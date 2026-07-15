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

    const due = new Date(it.dueDate);
    const overdue = due.getTime() < Date.now();
    const question = await narrateDueNudge(clientNumber, userId, it.title, due, overdue, it.delegateeName);
    const res = await enqueueBrainPrompt({
      userId, clientNumber,
      question,
      criticality: overdue ? 'high' : 'routine',
      dedupKey,
      sideEffect: { kind: 'noop' },
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
