/**
 * MyOS — Brain Prompt Queue.
 *
 * Sequential conversation between Brain and the user. Each user has at most
 * ONE prompt in `awaiting_reply` at a time (enforced by a partial unique
 * index in the DB). When the user replies, the active prompt is marked
 * `answered`, the side-effect runs, and the next queued prompt is
 * dispatched on the channel that matches its criticality.
 *
 * Criticality → channel:
 *   routine → text
 *   high    → voicenote
 *   top     → voice call (interrupts the queue, bypasses quiet hours)
 *
 * Top-priority prompts SKIP the queue entirely and go straight to
 * `brainContactsUser` with `urgency=emergency`. They don't claim the
 * `awaiting_reply` slot, so a routine conversation already in progress
 * isn't disrupted at the queue level (it WILL of course be interrupted
 * on the user's phone when the call rings — that's the point).
 *
 * Concurrency: enqueue + sendNext race-safe via the partial unique index
 * (`uq_bpq_one_awaiting_per_user`). Two workers calling sendNext at the
 * same instant: at most one wins the awaiting_reply slot; the loser's
 * UPDATE either no-ops or fails and is retried by the next tick.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { brainContactsUser, type Urgency } from '../notifications/brainOutboundService';

const log = createLogger('brain-prompt-queue');

export type Criticality = 'routine' | 'high' | 'top';

export interface SideEffect {
  /** What to do with the user's answer. */
  kind: 'set_due_date' | 'assign_owner' | 'free_form_note' | 'noop';
  /** Most side-effects target an open item. */
  openItemId?: string;
  /** Free-form payload — handler-specific. */
  data?: Record<string, unknown>;
}

export interface EnqueueInput {
  userId: number;
  clientNumber: string;
  /** What Brain is asking the user. Plain text rendered as the WhatsApp message. */
  question: string;
  /** Optional related open item — used by reply side-effects. */
  openItemId?: string;
  /** What to do with the answer. */
  sideEffect?: SideEffect;
  criticality?: Criticality;
  /** Skip enqueue if a non-terminal prompt with this dedup_key already exists. */
  dedupKey?: string;
  /** Override the default 48h auto-skip TTL. */
  ttlMs?: number;
  /** Free-form audit metadata. */
  metadata?: Record<string, unknown>;
}

export interface EnqueueResult {
  status: 'queued' | 'sent_now' | 'top_dispatched' | 'duplicate';
  promptId?: string;
  /** Set when status='top_dispatched' or 'sent_now'. */
  channelUsed?: string;
  /** Reason for non-send / dedup. */
  reason?: string;
}

const DEFAULT_TTL_MS = 48 * 60 * 60 * 1000;
// Voice-call cooldown — top prompts arriving inside this window get
// downgraded to a voicenote with the call CTA so the user isn't called
// every five minutes during a critical incident.
const VOICE_CALL_COOLDOWN_MS = 30 * 60 * 1000;

export async function enqueueBrainPrompt(input: EnqueueInput): Promise<EnqueueResult> {
  const criticality: Criticality = input.criticality ?? 'routine';
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  const expiresAt = new Date(Date.now() + ttlMs);

  // ── Dedup ──────────────────────────────────────────────────────
  // Soft dedup by (user_id, dedup_key) on any non-terminal row. Avoids
  // the same producer asking the same question twice when a poll fires
  // back-to-back.
  if (input.dedupKey) {
    const existing = await prisma.brainPromptQueue.findFirst({
      where: {
        userId: input.userId,
        dedupKey: input.dedupKey,
        state: { in: ['queued', 'awaiting_reply'] },
      },
      select: { id: true },
    });
    if (existing) {
      return {
        status: 'duplicate',
        promptId: String(existing.id),
        reason: 'dedup_key already queued or awaiting_reply',
      };
    }
  }

  // ── Top priority: bypass queue, fire voice call now ────────────
  if (criticality === 'top') {
    const channel = await pickTopChannel(input.userId);
    const r = await brainContactsUser({
      userId: input.userId,
      kind: 'brain_prompt_top',
      summary: clip(input.question, 120),
      body: input.question,
      urgency: channel === 'call_business' ? 'emergency' : 'high',
      channel,
      dedupKey: input.dedupKey ?? null,
      bypassQuietHours: channel === 'call_business',
      metadata: { ...(input.metadata ?? {}), criticality, openItemId: input.openItemId },
    });

    // Record the prompt as already-answered for audit (no awaiting_reply
    // slot — a voice call doesn't fit the typed-reply state machine).
    // The user can still answer in the regular chat which routes to the
    // free-form note handler.
    const row = await prisma.brainPromptQueue.create({
      data: {
        clientNumber: input.clientNumber,
        userId: input.userId,
        question: input.question,
        openItemId: input.openItemId ?? null,
        sideEffect: (input.sideEffect ?? { kind: 'noop' }) as any,
        criticality,
        state: r.sent ? 'answered' : 'skipped', // call placed → considered delivered
        channelUsed: channel,
        ackMessageId: r.waMessageIds[0] ?? null,
        dedupKey: input.dedupKey ?? null,
        sentAt: r.sent ? new Date() : null,
        answeredAt: r.sent ? new Date() : null,
        expiresAt,
        metadata: { ...(input.metadata ?? {}), brainOutboundReason: r.reason } as any,
      },
      select: { id: true },
    });
    return {
      status: 'top_dispatched',
      promptId: String(row.id),
      channelUsed: channel,
      reason: r.reason,
    };
  }

  // ── Routine / high: enqueue ────────────────────────────────────
  const row = await prisma.brainPromptQueue.create({
    data: {
      clientNumber: input.clientNumber,
      userId: input.userId,
      question: input.question,
      openItemId: input.openItemId ?? null,
      sideEffect: (input.sideEffect ?? { kind: 'noop' }) as any,
      criticality,
      state: 'queued',
      dedupKey: input.dedupKey ?? null,
      expiresAt,
      metadata: (input.metadata ?? {}) as any,
    },
    select: { id: true },
  });

  // Try to dispatch immediately. If another prompt is already
  // awaiting_reply, this one stays queued.
  const dispatched = await sendNextPrompt(input.userId);

  return dispatched && String(dispatched.promptId) === String(row.id)
    ? { status: 'sent_now', promptId: String(row.id), channelUsed: dispatched.channelUsed }
    : { status: 'queued', promptId: String(row.id) };
}

export interface SendNextResult {
  promptId: string;
  channelUsed: string;
}

/**
 * Pull the next queued prompt for the user and dispatch it. Returns null
 * when the user already has an awaiting_reply prompt OR has nothing
 * queued.
 *
 * Race-safe via the partial unique index on state='awaiting_reply':
 * if two callers run concurrently, at most one will succeed in
 * promoting a row to awaiting_reply; the other gets P2002 and we treat
 * it as "someone else dispatched", returning null.
 */
export async function sendNextPrompt(userId: number): Promise<SendNextResult | null> {
  // Already a conversation in flight? Don't dispatch.
  const inFlight = await prisma.brainPromptQueue.findFirst({
    where: { userId, state: 'awaiting_reply' },
    select: { id: true },
  });
  if (inFlight) return null;

  // Pick highest-criticality, oldest first. We can't use `orderBy:
  // { criticality: 'desc' }` directly because the values are strings
  // ('routine' / 'high' / 'top') and alphabetical desc would put
  // 'top' > 'routine' > 'high' — wrong. Fetch the small candidate set
  // and sort by explicit weight in Node.
  const CRIT_WEIGHT: Record<string, number> = { top: 3, high: 2, routine: 1 };
  const candidates = await prisma.brainPromptQueue.findMany({
    where: { userId, state: 'queued' },
    orderBy: [{ queuedAt: 'asc' }],
    select: { id: true, criticality: true, question: true, clientNumber: true, openItemId: true, dedupKey: true, queuedAt: true, metadata: true },
    take: 50,  // bounded — full queue depth shouldn't ever realistically exceed this per-user
  });
  if (candidates.length === 0) return null;
  // Filter out scheduled-future prompts. The star-cadence service stamps
  // metadata.scheduledAt on deferred pings (e.g. 1★ contact's first ping
  // is +48h). Don't dispatch until the clock rolls over that timestamp.
  const now = Date.now();
  const dueCandidates = candidates.filter((c) => {
    const meta = (c.metadata as Record<string, unknown> | null) ?? {};
    const at = typeof meta.scheduledAt === 'string' ? Date.parse(meta.scheduledAt) : NaN;
    return Number.isNaN(at) || at <= now;
  });
  if (dueCandidates.length === 0) return null;
  dueCandidates.sort((a, b) => {
    const wa = CRIT_WEIGHT[a.criticality] ?? 0;
    const wb = CRIT_WEIGHT[b.criticality] ?? 0;
    if (wa !== wb) return wb - wa;             // higher weight first
    return a.queuedAt.getTime() - b.queuedAt.getTime();  // older first
  });
  const next = dueCandidates[0]!;

  // Promote to awaiting_reply atomically. If the partial unique index
  // rejects (someone else got there first), fall through with null.
  let promoted;
  try {
    promoted = await prisma.brainPromptQueue.update({
      where: { id: next.id },
      data: { state: 'awaiting_reply', sentAt: new Date() },
    });
  } catch (err: any) {
    if (err?.code === 'P2002') return null; // race lost
    throw err;
  }

  const channel = channelForCriticality(next.criticality as Criticality);
  const urgency: Urgency = next.criticality === 'high' ? 'high' : 'normal';

  const r = await brainContactsUser({
    userId,
    kind: 'brain_prompt',
    summary: clip(next.question, 120),
    body: next.question,
    urgency,
    channel,
    // We bypass brainOutboundService dedup here — the queue itself is the
    // dedup mechanism. Passing null is sparingly authorised.
    dedupKey: null,
    metadata: { promptId: String(promoted.id), openItemId: next.openItemId, criticality: next.criticality },
  });

  // Record the wa_message_id for reply correlation.
  await prisma.brainPromptQueue.update({
    where: { id: promoted.id },
    data: {
      channelUsed: r.channelsUsed[0] ?? channel,
      ackMessageId: r.waMessageIds[0] ?? null,
      // If the outbound layer suppressed (quiet hours / no phone), roll
      // the prompt back to queued so the next sweep re-tries when
      // conditions change.
      ...(r.sent ? {} : { state: 'queued', sentAt: null }),
    },
  });

  if (!r.sent) {
    log.info('prompt rolled back to queued', { promptId: String(promoted.id), reason: r.reason });
    return null;
  }

  return { promptId: String(promoted.id), channelUsed: r.channelsUsed[0] ?? channel };
}

/**
 * Auto-skip prompts whose expires_at has passed. Returns count of
 * skipped rows. Cron caller (every 15m or so) advances the queue when
 * the user has gone silent — otherwise a single unanswered prompt would
 * deadlock the conversation forever.
 */
export async function expireStalePrompts(): Promise<{ expired: number; advanced: number }> {
  const now = new Date();
  // Find every non-terminal prompt past its TTL.
  const stale = await prisma.brainPromptQueue.findMany({
    where: {
      state: { in: ['queued', 'awaiting_reply'] },
      expiresAt: { lt: now },
    },
    select: { id: true, userId: true },
    take: 200,
  });
  let advanced = 0;
  for (const s of stale) {
    await prisma.brainPromptQueue.update({
      where: { id: s.id },
      data: { state: 'expired', metadata: { autoSkipReason: 'ttl' } as any },
    }).catch(() => {});
    // Try to dispatch the next prompt for this user — the active slot
    // just freed up.
    const r = await sendNextPrompt(s.userId).catch(() => null);
    if (r) advanced += 1;
  }
  if (stale.length > 0) {
    log.info('expired stale prompts', { expired: stale.length, advanced });
  }
  return { expired: stale.length, advanced };
}

/**
 * Look up the user's currently-awaiting prompt. Used by the reply
 * handler to route an inbound WhatsApp message to its answer.
 */
export async function getAwaitingPrompt(userId: number) {
  return prisma.brainPromptQueue.findFirst({
    where: { userId, state: 'awaiting_reply' },
    select: {
      id: true, clientNumber: true, userId: true, question: true,
      openItemId: true, sideEffect: true, criticality: true,
      ackMessageId: true, sentAt: true, metadata: true,
    },
  });
}

/**
 * Mark the user's currently-awaiting prompt as answered with the given
 * text. Caller is responsible for applying the side-effect; this only
 * mutates the queue row + advances to the next prompt.
 */
export async function recordAnswer(promptId: string | bigint, answerText: string): Promise<void> {
  await prisma.brainPromptQueue.update({
    where: { id: BigInt(promptId) },
    data: {
      state: 'answered',
      answeredAt: new Date(),
      answerText: answerText.slice(0, 4000),
    },
  });
}

// ─── Internal helpers ────────────────────────────────────────────

function channelForCriticality(c: Criticality): 'text' | 'voicenote' | 'call_business' {
  switch (c) {
    case 'routine': return 'text';
    case 'high':    return 'voicenote';
    case 'top':     return 'call_business';
  }
}

/**
 * Choose the channel for a top-priority prompt, applying the voice-call
 * cooldown. If a call has been placed in the last 30 min for this user,
 * downgrade to a voicenote so the user isn't called repeatedly.
 */
async function pickTopChannel(userId: number): Promise<'call_business' | 'voicenote'> {
  const recent = await prisma.brainUserMessage.findFirst({
    where: {
      userId,
      kind: { in: ['brain_prompt_top', 'critical_bundle'] },
      channel: 'call_business',
      createdAt: { gte: new Date(Date.now() - VOICE_CALL_COOLDOWN_MS) },
      status: { in: ['sent', 'partial'] },
    },
    select: { id: true },
  }).catch(() => null);
  return recent ? 'voicenote' : 'call_business';
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
