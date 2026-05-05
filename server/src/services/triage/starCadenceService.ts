/**
 * starCadenceService — sender-stars-driven WhatsApp notification cadence.
 *
 * Policy (single source of truth for star-driven proactive notifications):
 *
 *   ╔═══╦══════════════════╦═══════════╦══════════════════════════╦══════════╗
 *   ║ ★ ║ First ping after ║ Channel   ║ Repeat cadence           ║ Hard cap ║
 *   ╠═══╬══════════════════╬═══════════╬══════════════════════════╬══════════╣
 *   ║ 0 ║ never proactive  ║ —         ║ —                        ║ 0        ║
 *   ║ 1 ║ 48h              ║ text      ║ once                     ║ 1        ║
 *   ║ 2 ║ 24h              ║ text      ║ once                     ║ 1        ║
 *   ║ 3 ║ immediate        ║ text      ║ every 4h                 ║ 3        ║
 *   ║ 4 ║ immediate        ║ voicenote ║ +2h text follow-up       ║ 2        ║
 *   ║ 5 ║ immediate        ║ voicecall ║ +30m voicenote, +2h text ║ 3        ║
 *   ╚═══╩══════════════════╩═══════════╩══════════════════════════╩══════════╝
 *
 * Quiet hours: respected at 0–4★, BYPASSED at 5★ (voice call only).
 *
 * Content gate (applied at every tier — sender stars never override
 * content):
 *   - Skip if classified intent ∈ {FYI, NOISE}
 *   - Skip if subject/body looks like a thanks / ack / auto-reply
 *   - Skip calendar invites and meeting reminders (already on calendar)
 *   - Only fire when message has actionable signal: action verb, question
 *     mark, deadline phrase, or intent ∈ {NEW_TASK, ESCALATION, RISK,
 *     OPPORTUNITY}
 *
 * Pause rules: when the open item moves to CLOSED, IN_PROGRESS, DELEGATED,
 * SNOOZED, or INFORMED, all unfired cadence prompts for that item are
 * marked state='skipped' so the user isn't pinged about something they've
 * already handled.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { enqueueBrainPrompt } from '../brainPrompts/brainPromptQueueService';
import { getStarsForSender } from '../knowledge/entitySweepService';

const log = createLogger('star-cadence');

export type Stars = 0 | 1 | 2 | 3 | 4 | 5;
export type CadenceChannel = 'text' | 'voicenote' | 'voicecall';

interface PingStep {
  /** Minutes from item-creation when this ping should fire. */
  delayMinutes: number;
  /** Criticality drives the WhatsApp channel:
   *  routine → text, high → voicenote, top → voice call. */
  criticality: 'routine' | 'high' | 'top';
}

const PLAN: Record<Stars, PingStep[]> = {
  0: [],
  1: [{ delayMinutes: 48 * 60, criticality: 'routine' }],
  2: [{ delayMinutes: 24 * 60, criticality: 'routine' }],
  3: [
    { delayMinutes: 0, criticality: 'routine' },
    { delayMinutes: 4 * 60, criticality: 'routine' },
    { delayMinutes: 8 * 60, criticality: 'routine' },
  ],
  4: [
    { delayMinutes: 0, criticality: 'high' },
    { delayMinutes: 2 * 60, criticality: 'routine' },
  ],
  5: [
    { delayMinutes: 0, criticality: 'top' },
    { delayMinutes: 30, criticality: 'high' },
    { delayMinutes: 2 * 60, criticality: 'routine' },
  ],
};

/** Public — what the UI / docs show users. */
export const STAR_CADENCE_TABLE: Array<{
  stars: Stars;
  status: string;
  whenFirstPing: string;
  channels: string;
  cap: number;
  quietHours: 'respect' | 'bypass';
}> = [
  { stars: 0, status: 'Unrated — normal', whenFirstPing: 'never proactive', channels: '—', cap: 0, quietHours: 'respect' },
  { stars: 1, status: 'Light',            whenFirstPing: 'after 48h',         channels: 'WhatsApp text', cap: 1, quietHours: 'respect' },
  { stars: 2, status: 'Light',            whenFirstPing: 'after 24h',         channels: 'WhatsApp text', cap: 1, quietHours: 'respect' },
  { stars: 3, status: 'Important',        whenFirstPing: 'immediate',         channels: 'WhatsApp text every 4h', cap: 3, quietHours: 'respect' },
  { stars: 4, status: 'High',             whenFirstPing: 'immediate',         channels: 'WhatsApp voicenote, text follow-up', cap: 2, quietHours: 'respect' },
  { stars: 5, status: 'Top critical',     whenFirstPing: 'immediate',         channels: 'WhatsApp voice call → voicenote → text', cap: 3, quietHours: 'bypass' },
];

interface ContentGateInput {
  title: string;
  body?: string | null;
  intent?: string | null;
}

/**
 * Content gate. Returns false (skip) for FYI / thanks / ack / auto-reply
 * / calendar invites / meeting reminders. Returns true if there's an
 * actionable signal: action verb, question mark, deadline, or
 * actionable intent classification.
 */
export function passesContentGate(input: ContentGateInput): boolean {
  const intent = (input.intent ?? '').toUpperCase();
  if (intent === 'FYI' || intent === 'NOISE' || intent === 'INFORMATION') return false;
  if (['NEW_TASK', 'ESCALATION', 'RISK', 'OPPORTUNITY'].includes(intent)) return true;

  const text = `${input.title} ${input.body ?? ''}`.toLowerCase();

  // Auto-reply / vacation responder / out-of-office
  if (/\b(out of office|auto[- ]?reply|vacation responder|away from)\b/.test(text)) return false;
  // Pure thanks / ack
  if (/^\s*(thanks!?|thank you!?|thx|ty|noted|got it|ok|okay|sounds good|cool|will do|done)\.?\s*$/i.test(input.title.trim())) return false;
  // Calendar / meeting invitation noise — invite is already on the calendar
  if (/\b(when:|location:|meeting at|calendar invite|invitation:|google calendar invitation)\b/.test(text)) return false;
  if (/(reminder.*meeting|meeting.*reminder|starts in \d+ min)/.test(text)) return false;

  // Positive actionable signals
  if (/\?/.test(text)) return true;                              // question
  if (/\b(by|before|due|deadline|until)\s+\w/.test(text)) return true; // deadline
  if (/\b(review|approve|sign|send|reply|prepare|complete|deliver|finalise|finalize|decide|confirm|schedule|call|draft|update|share|forward|escalate|investigate|fix|handle)\b/.test(text)) return true;

  // No clear actionable signal — skip.
  return false;
}

interface ScheduleInput {
  clientNumber: string;
  userId: number;
  openItemId: string;
  itemTitle: string;
  itemBody?: string | null;
  intent?: string | null;
  /** RFC2822 normalised — pass null if no email known (WhatsApp-origin etc). */
  senderEmail: string | null;
  /** Display name for the prompt body. */
  senderName?: string | null;
}

export interface ScheduleResult {
  status: 'scheduled' | 'skipped_unrated' | 'skipped_content_gate' | 'skipped_no_sender';
  attempts: number;
  stars: Stars;
}

/**
 * Compute the cadence for an open item and enqueue all scheduled pings.
 * Each ping lands in `brain_prompt_queue` with metadata.scheduledAt; the
 * dispatcher only fires queued rows where scheduledAt has elapsed.
 *
 * Idempotent — same openItemId never schedules twice (dedup_key per
 * attempt prevents double-enqueue).
 */
export async function scheduleStarCadence(input: ScheduleInput): Promise<ScheduleResult> {
  if (!input.senderEmail) {
    return { status: 'skipped_no_sender', attempts: 0, stars: 0 };
  }
  const stars = ((await getStarsForSender(input.clientNumber, input.userId, input.senderEmail).catch(() => 0)) || 0) as Stars;
  const plan = PLAN[stars] ?? [];
  if (plan.length === 0) {
    return { status: 'skipped_unrated', attempts: 0, stars };
  }

  if (!passesContentGate({ title: input.itemTitle, body: input.itemBody ?? null, intent: input.intent ?? null })) {
    return { status: 'skipped_content_gate', attempts: 0, stars };
  }

  const senderHint = input.senderName ?? input.senderEmail;
  let scheduled = 0;
  for (let attempt = 0; attempt < plan.length; attempt++) {
    const step = plan[attempt]!;
    const scheduledAt = new Date(Date.now() + step.delayMinutes * 60 * 1000);
    const dedupKey = `cadence:${input.openItemId}:${attempt}`;
    const question = buildQuestion(input.itemTitle, senderHint, attempt, plan.length, stars);

    try {
      await enqueueBrainPrompt({
        clientNumber: input.clientNumber,
        userId: input.userId,
        question,
        openItemId: input.openItemId,
        sideEffect: { kind: 'free_form_note' },
        criticality: step.criticality,
        dedupKey,
        // The dispatcher only fires when scheduledAt has elapsed.
        // Top-criticality (5★ first ping) bypasses the queue entirely
        // and fires immediately — that's by design at the queue layer.
        metadata: {
          scheduledAt: scheduledAt.toISOString(),
          starCadence: { stars, attempt, totalAttempts: plan.length, senderEmail: input.senderEmail },
        },
      });
      scheduled++;
    } catch (err) {
      log.warn('star-cadence enqueue failed', { openItemId: input.openItemId, attempt, err: String(err) });
    }
  }

  return { status: 'scheduled', attempts: scheduled, stars };
}

function buildQuestion(itemTitle: string, senderHint: string, attempt: number, total: number, stars: Stars): string {
  const starBadge = '★'.repeat(stars);
  const followup = attempt === 0
    ? ''
    : ` (follow-up ${attempt + 1}/${total})`;
  return `${starBadge} ${senderHint}: "${truncate(itemTitle, 120)}"${followup}\n\nWhat would you like to do — reply, delegate, or close?`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

/**
 * Pause/cancel cadence when the open item is no longer awaiting user
 * action. Marks every pending cadence prompt for this item as 'skipped'.
 *
 * Called from openItemsService when item.status transitions to any of
 * {CLOSED, IN_PROGRESS, DELEGATED, SNOOZED, INFORMED}.
 */
export async function pauseCadenceForItem(openItemId: string, reason: string): Promise<number> {
  const result = await prisma.brainPromptQueue.updateMany({
    where: {
      openItemId,
      state: 'queued',
      dedupKey: { startsWith: `cadence:${openItemId}:` },
    },
    data: { state: 'skipped' },
  });
  if (result.count > 0) {
    log.info('star-cadence paused', { openItemId, reason, paused: result.count });
  }
  return result.count;
}

/**
 * Summary of what star-cadence has done for one open item — used by the
 * Day Brief to tell the user "I pinged you 2× about this, no response yet".
 */
export async function getCadenceSummaryForItem(openItemId: string): Promise<{
  totalScheduled: number;
  sent: number;
  pending: number;
  answered: number;
  skipped: number;
  expired: number;
  lastSentAt: Date | null;
  lastChannelUsed: string | null;
}> {
  const rows = await prisma.brainPromptQueue.findMany({
    where: { openItemId, dedupKey: { startsWith: `cadence:${openItemId}:` } },
    select: { state: true, sentAt: true, channelUsed: true },
    orderBy: { queuedAt: 'asc' },
  });
  let sent = 0, pending = 0, answered = 0, skipped = 0, expired = 0;
  let lastSentAt: Date | null = null;
  let lastChannelUsed: string | null = null;
  for (const r of rows) {
    if (r.state === 'queued') pending++;
    else if (r.state === 'awaiting_reply') { sent++; if (r.sentAt && (!lastSentAt || r.sentAt > lastSentAt)) { lastSentAt = r.sentAt; lastChannelUsed = r.channelUsed; } }
    else if (r.state === 'answered') { sent++; answered++; if (r.sentAt && (!lastSentAt || r.sentAt > lastSentAt)) { lastSentAt = r.sentAt; lastChannelUsed = r.channelUsed; } }
    else if (r.state === 'skipped') skipped++;
    else if (r.state === 'expired') expired++;
  }
  return { totalScheduled: rows.length, sent, pending, answered, skipped, expired, lastSentAt, lastChannelUsed };
}
