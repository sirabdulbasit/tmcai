/**
 * preactiveEngine — anticipation, not reaction (2026-07-14).
 *
 * Basit: "now fill the gaps including preactive." The brain had
 * reactive thinking (answers) and proactive triggers (risk radar,
 * stale-delegation nudges, day brief) but nothing ANTICIPATORY —
 * preparing what the user will need BEFORE they ask. Two moves a
 * living assistant makes every day:
 *
 *   1. MEETING PREP — "your 2:30 with Haseeb is coming up; here's
 *      what's open with him." Fires in a window before each meeting
 *      with attendees, once per event (dedup on eventId).
 *   2. COMMITMENT DEADLINES — "the leave-request item is due
 *      tomorrow." Fires for open items with a due date inside the
 *      next 24h, once per item per day.
 *
 * Delivery rides brainPromptQueueService — dedup, TTL, criticality
 * ordering, quiet-channel selection all apply as with any Brain
 * prompt. Content is LLM-narrated (no hardcoded Brain prose); when
 * narration fails the message degrades to a fully bracketed digest,
 * per the marker rule.
 *
 * Cost control: one calendar read + one open-items read per tick per
 * user; the LLM runs ONLY when something is actually due to fire
 * (dedup is checked before narration).
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('preactive');

/** Defaults for the prep window / due lookahead. Both are now
 *  user/tenant-tunable via behaviorConfig (audit 2026-07-14 #3/#10):
 *  keys 'preactive.meeting_prep_window_min' and
 *  'preactive.due_soon_hours'; these constants remain the documented
 *  code defaults (and back-compat exports). */
export const MEETING_PREP_WINDOW_MIN = 90;
export const DUE_SOON_HOURS = 24;

export interface PreactiveResult {
  meetingPrepsSent: number;
  dueNudgesSent: number;
}

/** One anticipation pass for one user. Called from the scheduler
 *  every ~15 min; every send is deduped so the cadence is safe. */
export async function runPreactiveTick(clientNumber: string, userId: number): Promise<PreactiveResult> {
  const out: PreactiveResult = { meetingPrepsSent: 0, dueNudgesSent: 0 };
  // #10 (audit 2026-07-14): per-user opt-out — brain_channel.preactive
  // === false mutes both passes. Inspectable and reversible in profile
  // settings; deterministic (no LLM decides whether to respect a mute).
  try {
    const u = await prisma.user.findUnique({
      where: { id: userId }, select: { notificationPreferences: true },
    });
    if ((u?.notificationPreferences as any)?.brain_channel?.preactive === false) return out;
  } catch { /* pref lookup failure must not block anticipation */ }
  try {
    out.meetingPrepsSent = await meetingPrepPass(clientNumber, userId);
  } catch (e: any) {
    log.warn('meeting-prep pass failed', { userId, error: e?.message });
  }
  try {
    out.dueNudgesSent = await dueSoonPass(clientNumber, userId);
  } catch (e: any) {
    log.warn('due-soon pass failed', { userId, error: e?.message });
  }
  return out;
}

// ─── 1. Meeting prep ────────────────────────────────────────────────

async function meetingPrepPass(clientNumber: string, userId: number): Promise<number> {
  const { getEvents } = await import('../calendarService');
  const { getBehaviorValue } = await import('../behaviorConfig');
  const windowMin = await getBehaviorValue('preactive.meeting_prep_window_min', { userId, clientNumber }).catch(() => MEETING_PREP_WINDOW_MIN);
  const now = new Date();
  const horizon = new Date(now.getTime() + windowMin * 60_000);
  const r = await getEvents(userId, now, horizon, 10);
  if (r.error || r.events.length === 0) return 0;

  const { enqueueBrainPrompt } = await import('../brainPrompts/brainPromptQueueService');
  let sent = 0;
  for (const ev of r.events) {
    // Solo blocks ("Office") have nothing to prep; require ≥1 other human.
    const others = (ev.attendees ?? []).filter((a) => !!a);
    if (others.length === 0) continue;
    if (ev.isAllDay) continue;

    const dedupKey = `meeting-prep:${ev.id}`;
    // Cheap pre-check — never pay for context/narration when the prep
    // already went out (enqueue would dedup anyway, but only AFTER we
    // spent an LLM call). Terminal rows count too: one prep per event ever.
    const already = await prisma.brainPromptQueue.findFirst({
      where: { userId, dedupKey },
      select: { id: true },
    }).catch(() => null);
    if (already) continue;

    const context = await gatherAttendeeContext(clientNumber, userId, others);
    const question = await narrateMeetingPrep(clientNumber, userId, ev.title, ev.start, others, context);
    const res = await enqueueBrainPrompt({
      userId, clientNumber,
      question,
      criticality: 'routine',
      dedupKey,
      sideEffect: { kind: 'noop' },
      metadata: { source: 'preactive_meeting_prep', eventId: ev.id, eventStart: ev.start } as any,
    });
    if (res.status !== 'duplicate') sent += 1;
  }
  return sent;
}

/** Open items + last inbound per attendee — the "what's open with
 *  them" a human assistant would pull before a meeting. */
async function gatherAttendeeContext(
  clientNumber: string,
  userId: number,
  attendeeEmails: string[],
): Promise<string> {
  const lines: string[] = [];
  const emailsLower = attendeeEmails.map((e) => e.toLowerCase());
  try {
    const items = await prisma.openItem.findMany({
      where: {
        clientNumber, userId,
        status: { in: ['NEW', 'TRIAGED', 'IN_PROGRESS', 'DELEGATED', 'WAITING_INFO'] },
      },
      select: { title: true, status: true, dueDate: true, delegateeName: true, delegateeEmail: true, metadata: true } as any,
      take: 50,
    });
    for (const it of items as any[]) {
      const senderEmail = String(it.metadata?.senderEmail ?? '').toLowerCase();
      const delegEmail = String(it.delegateeEmail ?? '').toLowerCase();
      if (emailsLower.includes(senderEmail) || emailsLower.includes(delegEmail)) {
        const due = it.dueDate ? ` due ${new Date(it.dueDate).toISOString().slice(0, 10)}` : '';
        lines.push(`- open item "${it.title}" (${it.status}${due})${it.delegateeName ? ` with ${it.delegateeName}` : ''}`);
      }
    }
  } catch { /* items are optional context */ }
  try {
    const recent = await prisma.feedEvent.findMany({
      where: {
        clientNumber, userId,
        senderEmail: { in: attendeeEmails, mode: 'insensitive' } as any,
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 3600_000) },
      },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { sourceType: true, createdAt: true, rawPayload: true },
    });
    for (const fe of recent as any[]) {
      const subject = String(fe.rawPayload?.subject ?? fe.rawPayload?.text ?? '').slice(0, 90);
      lines.push(`- recent ${fe.sourceType} (${new Date(fe.createdAt).toISOString().slice(0, 10)}): ${subject}`);
    }
  } catch { /* recent activity optional */ }
  return lines.join('\n');
}

async function narrateMeetingPrep(
  clientNumber: string,
  userId: number,
  title: string,
  startIso: string,
  attendees: string[],
  context: string,
): Promise<string> {
  const when = new Date(startIso);
  const hhmm = isNaN(when.getTime()) ? startIso : when.toISOString().slice(11, 16);
  try {
    const { callLLM } = await import('../llmRouter');
    const r = await callLLM(
      `You are Nexeo, the user's AI assistant, sending a short WhatsApp meeting-prep note. 2-4 sentences, max 90 words, plain prose. Name the meeting and time, then the genuinely useful open threads with these attendees from the context. If the context is empty, say there are no open threads with them. No headers, no bullets, no invented facts — only what the context shows.`,
      `Meeting: "${title}" at ${hhmm} (UTC) with ${attendees.join(', ')}.\n\nContext (open items + recent activity with these attendees):\n${context || '(nothing on file)'}`,
      { maxTokens: 160, userId, clientNumber, purpose: 'preactive_meeting_prep' },
    );
    const text = r.text.trim();
    if (text) return text;
  } catch { /* fall through to bracketed digest */ }
  // Marker-rule fallback: bracketed digest, no fake prose.
  return `[meeting prep] "${title}" at ${hhmm} with ${attendees.join(', ')}${context ? `\n${context}` : ' [no open threads on file]'}`;
}

// ─── 2. Commitment deadlines ────────────────────────────────────────

async function dueSoonPass(clientNumber: string, userId: number): Promise<number> {
  const { getBehaviorValue } = await import('../behaviorConfig');
  const dueSoonHours = await getBehaviorValue('preactive.due_soon_hours', { userId, clientNumber }).catch(() => DUE_SOON_HOURS);
  const soon = new Date(Date.now() + dueSoonHours * 3600_000);
  const items = await prisma.openItem.findMany({
    where: {
      clientNumber, userId, ownerId: userId,
      status: { in: ['NEW', 'TRIAGED', 'IN_PROGRESS', 'DELEGATED', 'WAITING_INFO'] },
      dueDate: { not: null, lte: soon },
    },
    select: { id: true, title: true, status: true, dueDate: true, delegateeName: true },
    orderBy: { dueDate: 'asc' },
    take: 10,
  }).catch(() => [] as any[]);
  if (items.length === 0) return 0;

  const { enqueueBrainPrompt } = await import('../brainPrompts/brainPromptQueueService');
  const today = new Date().toISOString().slice(0, 10);
  let sent = 0;
  for (const it of items as any[]) {
    // One nudge per item per day — overdue items re-nudge daily, not per tick.
    const dedupKey = `due-nudge:${it.id}:${today}`;
    const already = await prisma.brainPromptQueue.findFirst({
      where: { userId, dedupKey },
      select: { id: true },
    }).catch(() => null);
    if (already) continue;

    // DEF-261 — silence is an answer. The per-day dedup above only ever stopped a SECOND ask on
    // the same day; an item nobody answers was asked about again tomorrow, and the day after,
    // indefinitely (two items reached 8 consecutive days with zero replies, one reached 10).
    // The gap now widens with each unanswered ask and resets when he replies.
    // try/catch, not `.catch` — a missing or failing method throws SYNCHRONOUSLY, before there
    // is a promise to attach to. That is DEF-274's lesson from earlier today, and it bit again
    // here. On any failure we ASK: an unreadable history must not silence a real deadline, so
    // the fail-safe direction is the behaviour we already had.
    let priorNudges: Array<{ state: string; queuedAt: Date }> = [];
    let historyReadable = true;
    try {
      priorNudges = await prisma.brainPromptQueue.findMany({
        where: { userId, clientNumber, dedupKey: { startsWith: `due-nudge:${it.id}:` } },
        select: { state: true, queuedAt: true },
        orderBy: { queuedAt: 'desc' },
        take: 20,
      }) as Array<{ state: string; queuedAt: Date }>;
    } catch (err: any) {
      historyReadable = false;
      log.warn('could not read nudge history — asking rather than going silent', {
        item: it.id, error: String(err?.message ?? err).slice(0, 120),
      });
    }
    const verdict = historyReadable ? mayNudgeNow(priorNudges) : { may: true, reason: 'history unreadable', gapDays: 0, unanswered: 0 };
    if (!verdict.may) {
      log.info('due-nudge withheld — backing off', {
        item: it.id, unanswered: verdict.unanswered, reason: verdict.reason,
      });
      continue;
    }

    const due = new Date(it.dueDate);
    const overdue = due.getTime() < Date.now();
    const question = await narrateDueNudge(clientNumber, userId, it.title, due, overdue, it.delegateeName);
    const res = await enqueueBrainPrompt({
      userId, clientNumber,
      question,
      criticality: overdue ? 'high' : 'routine',
      dedupKey,
      // DEF-278 — the side effect its own words promise.
      //
      // This was `{ kind: 'noop' }` while `narrateDueNudge` wrote "Let me know if you attended
      // and I can mark it as done". The owner quote-replied "done" on 2026-09-02: routing was
      // perfect (prompt #490, confidence 1, referent delivered by DEF-267(b)), the prompt went
      // to `answered`, he was told "Got it." — and the item stayed `status=NEW`. A promise with
      // no dispatcher behind it, which is DEF-264 and DEF-255 in a third shape, and the 8th
      // `fabricated-status`.
      //
      // `action_status_update` is not a new capability: it already routes through
      // `recordActionLifecycleReply`, which closes the item, records a new deadline, or flags an
      // intervention, and acks with a subject the model can actually render.
      //
      // The id is passed on the side effect itself rather than left only in `metadata`. Both are
      // set: `promptSubjectItemId` reads metadata for DEF-115's staleness guard, and
      // `applySideEffect` reads `side.openItemId`. Two readers, one fact, so both get it.
      sideEffect: { kind: 'action_status_update', openItemId: it.id },
      metadata: { source: 'preactive_due_nudge', openItemId: it.id, overdue } as any,
    });
    if (res.status !== 'duplicate') sent += 1;
  }
  return sent;
}

async function narrateDueNudge(
  clientNumber: string,
  userId: number,
  title: string,
  due: Date,
  overdue: boolean,
  delegateeName?: string | null,
): Promise<string> {
  const dueStr = due.toISOString().slice(0, 10);
  try {
    const { callLLM } = await import('../llmRouter');
    const r = await callLLM(
      `You are Nexeo, the user's AI assistant, sending a one-or-two sentence WhatsApp reminder about a deadline. Max 45 words, plain prose. State the item and that it's ${overdue ? 'OVERDUE' : 'due soon'}, and offer ONE concrete next step (e.g. chase the delegatee, mark done, or push the date). No invented details.`,
      `Item: "${title}". Due: ${dueStr} (${overdue ? 'already past' : 'within 24h'}).${delegateeName ? ` Delegated to ${delegateeName}.` : ''}`,
      { maxTokens: 90, userId, clientNumber, purpose: 'preactive_due_nudge' },
    );
    const text = r.text.trim();
    if (text) return text;
  } catch { /* fall through */ }
  return `[deadline] "${title}" is ${overdue ? 'overdue' : `due ${dueStr}`}${delegateeName ? ` [with ${delegateeName}]` : ''} [reply to chase, mark done, or move the date]`;
}

// ─── Scheduler entry ────────────────────────────────────────────────

/** Sweep all active users across tenants. Registered in server.ts. */
export async function runPreactiveForAllUsers(): Promise<{ users: number; preps: number; nudges: number }> {
  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, clientNumber: true },
  }).catch(() => [] as Array<{ id: number; clientNumber: string }>);
  let preps = 0, nudges = 0;
  for (const u of users) {
    const r = await runPreactiveTick(u.clientNumber, u.id).catch(() => ({ meetingPrepsSent: 0, dueNudgesSent: 0 }));
    preps += r.meetingPrepsSent;
    nudges += r.dueNudgesSent;
  }
  if (preps > 0 || nudges > 0) log.info('preactive sweep', { users: users.length, preps, nudges });
  return { users: users.length, preps, nudges };
}

/**
 * DEF-261 — the deadline nag repeated every day, forever.
 *
 * Measured 2026-09-02: 71 due-nudges across 17 items, **16 ever answered**. Two items had been
 * nagged **8 days running with zero responses** (08-26 → 09-02); one reached 10. The dedup key is
 * `due-nudge:<item>:<today>`, so "one per item per day" was the only limit and an item nobody
 * answers is asked about again tomorrow, and the day after, indefinitely.
 *
 * That is not merely irritating. Those nudges are `high` when overdue, and DEF-331 established
 * that the outbound queue drains roughly one prompt per in-flight cycle — so ~13 self-replenishing
 * nags per day consumed the entire channel, starving every `routine` prompt (the identity ask sat
 * unsent for hours) and, on 2026-09-01, pushing two of the owner's real relayed messages out of
 * the daily cap entirely.
 *
 * SILENCE IS AN ANSWER. Asking a ninth time is not persistence, it is noise, and it costs the
 * messages that matter. So the gap widens with each unanswered ask — 1, 2, 4, then weekly — and
 * **resets the moment he replies**, because an answered item has re-earned the right to a prompt
 * cadence.
 *
 * It backs OFF rather than stopping: a deadline that genuinely matters must not go silent because
 * the owner was on holiday for a fortnight. A weekly floor keeps it alive at a cost the channel
 * can carry.
 */
export const MAX_NUDGE_GAP_DAYS = 7;

export function nudgeGapDays(consecutiveUnanswered: number): number {
  if (consecutiveUnanswered <= 0) return 0;             // never asked — ask now
  return Math.min(2 ** (consecutiveUnanswered - 1), MAX_NUDGE_GAP_DAYS);
}

/**
 * Count unanswered asks back from the most recent, stopping at the first answer. Consecutive,
 * not total: a reply is the owner re-engaging, and the cadence should start over rather than
 * hold his past silence against him forever.
 */
export function consecutiveUnansweredNudges(
  prior: Array<{ state: string; queuedAt: Date }>,
): number {
  const newestFirst = [...prior].sort((a, b) => b.queuedAt.getTime() - a.queuedAt.getTime());
  let n = 0;
  for (const row of newestFirst) {
    if (row.state === 'answered') break;
    n += 1;
  }
  return n;
}

export function mayNudgeNow(
  prior: Array<{ state: string; queuedAt: Date }>,
  now = new Date(),
): { may: boolean; reason: string; gapDays: number; unanswered: number } {
  const unanswered = consecutiveUnansweredNudges(prior);
  const gapDays = nudgeGapDays(unanswered);
  if (prior.length === 0) return { may: true, reason: 'never asked', gapDays, unanswered };
  const newest = [...prior].sort((a, b) => b.queuedAt.getTime() - a.queuedAt.getTime())[0]!;
  const daysSince = (now.getTime() - newest.queuedAt.getTime()) / 86_400_000;
  if (daysSince >= gapDays) {
    return { may: true, reason: `${daysSince.toFixed(1)}d since last, gap ${gapDays}d`, gapDays, unanswered };
  }
  return {
    may: false,
    reason: `${unanswered} unanswered — next in ${(gapDays - daysSince).toFixed(1)}d`,
    gapDays, unanswered,
  };
}
