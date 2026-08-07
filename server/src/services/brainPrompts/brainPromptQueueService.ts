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
  kind: 'set_due_date' | 'assign_owner' | 'free_form_note' | 'action_status_update'
      | 'wa_sender_policy_decision' | 'noop';
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
  /**
   * DEF-063 — does this prompt WAIT for the owner to answer?
   *
   * `sendNextPrompt` refuses to dispatch while a conversation is in flight,
   * which is right for a question and wrong for a notice. On 2026-08-05 Babar's
   * answer took the lock at 10:30 and Farooq's at 10:45 sat behind it until
   * `expireStalePrompts` deleted it — so the owner learned one of two figures,
   * and the discrepancy that was the only news never reached him.
   *
   * `false` means: send it, then close it. It never holds the lock and never
   * blocks the next one. Defaults TRUE so every existing caller keeps its
   * current behaviour.
   */
  expectsReply?: boolean;
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
  // Carried in metadata rather than a column: additive, no migration, and
  // reversible. DEF-060 was a schema constraint rejecting a bad enum value —
  // not a mistake worth risking twice in one day for a boolean.
  const expectsReply = input.expectsReply !== false;
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
      metadata: { ...(input.metadata ?? {}), expectsReply } as any,
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
/** DEF-077 — how long an unanswered question may hold the conversational lock.
 *
 *  Prompt 271 held it for 28 HOURS on 2026-08-06: sent, never answered (the
 *  relevance gate kept deciding the owner's messages were new turns, not
 *  replies), and the 48h TTL meant it would have blocked everything for another
 *  day. Five notifications stacked behind it, including Hamna's answer.
 *
 *  A question the owner has ignored for two hours is not a live conversation.
 *  It stops blocking; it is not deleted, and its side effect is untouched. */
async function lockMaxAgeMs(userId: number): Promise<number> {
  try {
    const { getBehaviorValue } = await import('../behaviorConfig');
    const hours = await getBehaviorValue('prompt.lock_max_age_hours', { userId });
    return Math.max(1, hours) * 60 * 60 * 1000;
  } catch { return 2 * 60 * 60 * 1000; }
}

export async function sendNextPrompt(userId: number): Promise<SendNextResult | null> {
  // ── DEF-077 / DEF-063 second half — the lock is not absolute ────────
  //
  // The guard used to be "anything in flight ⇒ send nothing". That is right
  // for another QUESTION and wrong for a NOTICE, and this morning I only fixed
  // the direction where a notice TAKES the lock. It still WAITED for one, so
  // Hamna's answer was correlated, classified and queued — then sat behind a
  // day-old reminder until it would have expired unread.
  //
  // Two changes: a stale lock is released, and a notice is exempt from a live
  // one. A notice is not part of the conversation, so the lock does not apply
  // to it in either direction.
  let inFlight = await prisma.brainPromptQueue.findFirst({
    where: { userId, state: 'awaiting_reply' },
    select: { id: true, sentAt: true, question: true },
  });

  if (inFlight) {
    const heldFor = Date.now() - new Date(inFlight.sentAt ?? Date.now()).getTime();
    if (heldFor > await lockMaxAgeMs(userId)) {
      // Not deleted — expired. The owner never answered, and holding the whole
      // notification channel hostage to that is worse than letting it go.
      await prisma.brainPromptQueue.update({
        where: { id: inFlight.id },
        data: { state: 'expired' },
      }).catch(() => undefined);
      log.info('stale conversational lock released', {
        userId, promptId: String(inFlight.id), heldForHours: Math.round(heldFor / 3600000),
      });
      inFlight = null;
    }
  }

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

  // A live lock only blocks another QUESTION. Notices go regardless — they are
  // not part of the conversation, so waiting for it makes no sense. This is the
  // half of DEF-063 I missed: I stopped a notice TAKING the lock and left it
  // still WAITING for one.
  // NOTE: a copy, not an alias. `sendable = dueCandidates` and then clearing
  // dueCandidates emptied both — they were the same array — and every prompt
  // silently vanished. Caught by def054 immediately, which is what those tests
  // are for.
  const sendable = (inFlight
    ? dueCandidates.filter((c) =>
      ((c.metadata as Record<string, unknown> | null) ?? {}).expectsReply === false)
    : [...dueCandidates]);
  if (sendable.length === 0) return null;

  sendable.sort((a, b) => {
    const wa = CRIT_WEIGHT[a.criticality] ?? 0;
    const wb = CRIT_WEIGHT[b.criticality] ?? 0;
    if (wa !== wb) return wb - wa;             // higher weight first
    return a.queuedAt.getTime() - b.queuedAt.getTime();  // older first
  });
  const next = sendable[0]!;

  // A notice must NOT be promoted to awaiting_reply. `uq_bpq_one_awaiting_per_user`
  // is a partial unique index, so doing that while a question already holds the
  // slot would throw P2002 and silently drop the notice — reintroducing the very
  // bug this bypass exists to fix. It goes straight to a terminal state: sent,
  // recorded, and out of the way.
  const promptExpectsReply = ((next.metadata as Record<string, unknown> | null) ?? {}).expectsReply !== false;

  // Promote atomically. If the partial unique index rejects (someone else got
  // there first), fall through with null.
  let promoted;
  try {
    promoted = await prisma.brainPromptQueue.update({
      where: { id: next.id },
      data: promptExpectsReply
        ? { state: 'awaiting_reply', sentAt: new Date() }
        : { state: 'answered', sentAt: new Date(), answeredAt: new Date() },
    });
  } catch (err: any) {
    if (err?.code === 'P2002') return null; // race lost
    throw err;
  }

  const channel = await channelForCriticality(next.criticality as Criticality, userId);
  const urgency: Urgency = next.criticality === 'high' ? 'high' : 'normal';

  // Propagate the queue row's metadata (smoke flag, starCadence info,
  // feedEventId) so brainOutboundService's smoke-isolation guard catches
  // test-flagged rows even when they fire from the deferred dispatcher.
  const queueMeta = (next.metadata as Record<string, unknown> | null) ?? {};
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
    metadata: {
      ...queueMeta,
      promptId: String(promoted.id),
      openItemId: next.openItemId,
      criticality: next.criticality,
    },
  });

  // ── DEF-063 — a NOTICE must not hold the conversational lock ──────
  //
  // The guard at the top of this function refuses to dispatch while a prompt
  // sits in `awaiting_reply`. Correct for a question; wrong for an update.
  // 2026-08-05: Babar's answer took the lock at 10:30, Farooq's arrived at
  // 10:45 and waited behind it until expireStalePrompts deleted it — so the
  // owner got one of two figures and never learned they disagreed, which was
  // the only thing worth telling him.
  //
  // `answered` is used deliberately: it is an existing state already written
  // elsewhere in this file, so no new enum value meets the CHECK constraint
  // that caused DEF-060.
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

  // ── DEF-081 — record that the owner was actually TOLD ────────────────
  //
  // Owner: "you should keep record what was asked through Brain and when it
  // notified, then it will be closed."
  //
  // Every failure today was silent because the ask lived in delegation_threads,
  // the notification in this table, and nothing joined them — so "she answered
  // and he never heard" was not a question the database could answer. Stamped
  // HERE, after a confirmed send, never at enqueue: written is not delivered,
  // and conflating the two is the entire class of bug.
  const notifiedThreadId = (queueMeta as Record<string, unknown>).threadId;
  if (typeof notifiedThreadId === 'string' && notifiedThreadId) {
    await prisma.delegationThread.updateMany({
      where: { id: notifiedThreadId, ownerNotifiedAt: null },
      data: { ownerNotifiedAt: new Date() },
    }).catch(() => undefined);
  }

  return { promptId: String(promoted.id), channelUsed: r.channelsUsed[0] ?? channel };
}

/**
 * DEF-054 — DRAIN THE QUEUE. Until 2026-08-05 nothing did.
 *
 * `sendNextPrompt` was complete, correct, and called from five smoke-test
 * scripts and nowhere else. Every production path — delegation replies, stale
 * connectors, trust promotions, gap prompts — ENQUEUED, and the only job that
 * touched the queue was `expireStalePrompts`, which DELETES rows after 30
 * minutes. So notifications were written for the owner and expired unread.
 *
 * The owner found it the way it deserved to be found: he asked Brain to ask
 * Hamna a question, and asked what would happen when she answered. Nothing
 * would have. "A question you can't get the answer to is worse than not
 * asking — it looks like it worked."
 *
 * A producer with no consumer is the third instance of that exact shape in one
 * day (DEF-023's dispatcher-less action kind, autonomous_outbound's missing
 * consumer, this). Writing the row is not delivering the message.
 *
 * One prompt per user per sweep is deliberate, not a limitation:
 * `sendNextPrompt` refuses while a conversation is in flight, so the queue
 * advances as the owner answers rather than arriving as a burst.
 */
export async function dispatchDuePrompts(): Promise<{ users: number; sent: number }> {
  const rows = await prisma.brainPromptQueue.findMany({
    where: { state: 'queued' },
    select: { userId: true },
    distinct: ['userId'],
    take: 200,
  });
  let sent = 0;
  for (const { userId } of rows) {
    try {
      // Failure for one user must never stop the sweep for the others.
      if (await sendNextPrompt(userId)) sent += 1;
    } catch (error: any) {
      log.warn('prompt dispatch failed for user', { userId, error: error?.message?.slice(0, 200) });
    }
  }
  if (sent > 0) log.info('prompt queue drained', { users: rows.length, sent });
  return { users: rows.length, sent };
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
const PROMPT_SELECT = {
  id: true, clientNumber: true, userId: true, question: true,
  openItemId: true, sideEffect: true, criticality: true,
  ackMessageId: true, sentAt: true, metadata: true, state: true,
} as const;

export async function getAwaitingPrompt(userId: number, clientNumber?: string) {
  return prisma.brainPromptQueue.findFirst({
    where: { userId, state: 'awaiting_reply', ...(clientNumber ? { clientNumber } : {}) },
    // DEF-095: previously unordered. With two questions outstanding, WHICH one a
    // reply attached to was whatever order Postgres happened to return — so an
    // answer could silently be recorded against the wrong question. Newest asked
    // wins, which is what a person means by "the question you just asked me".
    orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
    select: PROMPT_SELECT,
  });
}

/**
 * DEF-095 — every question this user could still plausibly be answering.
 *
 * Owner, 2026-08-07: *"if brain ask me any question... after an hour when i reply
 * to it... it didnt corelated my this with his last message... don't you think it
 * will read last n number message to correlated what i had asked it"*.
 *
 * He was right, and the reality was narrower than he assumed. Correlation
 * considered exactly ONE row in exactly ONE state. When he raised this there
 * were **zero** rows in `awaiting_reply` and **119** expired — so a reply that
 * arrived an hour later matched nothing, fell through to chat, and got re-read
 * as a brand-new instruction. That is the same failure as DEF-064, where a
 * counterpart's answer was discarded because the thread had moved on: Brain
 * keeps forgetting that it asked.
 *
 * Expired questions are INCLUDED deliberately. Expiry is Brain's bookkeeping,
 * not the user's deadline — a question he finally gets round to answering has
 * still been answered, and discarding it teaches him that replying is pointless.
 *
 * Ordering is deliberate too: still-awaiting questions come before expired ones,
 * newest first within each group. The caller judges each candidate with the
 * relevance classifier and takes the first real match, so ordering decides only
 * which plausible question is tested first.
 *
 * Scoped by (clientNumber, userId): this is per-user under a tenant, never a
 * global "the owner" (owner instruction, 2026-08-07 — *"nothing should be
 * hardcoded related me it should be user under tenant/client"*).
 */
export async function getAnswerableQuestions(args: {
  userId: number;
  clientNumber: string;
  lookbackHours: number;
  limit: number;
}) {
  const since = new Date(Date.now() - args.lookbackHours * 60 * 60 * 1000);
  const rows = await prisma.brainPromptQueue.findMany({
    where: {
      userId: args.userId,
      clientNumber: args.clientNumber,
      state: { in: ['awaiting_reply', 'expired'] },
      sentAt: { not: null, gte: since },
    },
    orderBy: [{ sentAt: 'desc' }, { id: 'desc' }],
    take: Math.max(args.limit * 3, args.limit),
    select: PROMPT_SELECT,
  });
  const rank = (state: string) => (state === 'awaiting_reply' ? 0 : 1);
  return rows.sort((a, b) => rank(a.state) - rank(b.state)).slice(0, args.limit);
}

/**
 * DEF-095 — an expired question the user has just answered is not expired.
 *
 * Returning it to `awaiting_reply` before recording the answer keeps the state
 * machine honest: `recordAnswer` moves `awaiting_reply → answered`, and a row
 * that jumped straight from `expired → answered` would make the queue's own
 * history unreadable.
 */
export async function reviveExpiredPrompt(promptId: string | bigint): Promise<void> {
  await prisma.brainPromptQueue.updateMany({
    where: { id: BigInt(promptId), state: 'expired' },
    data: { state: 'awaiting_reply' },
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

/** DEF-084 — the owner reads, he does not listen.
 *
 *  `high` mapped to a voice note, so every overdue reminder arrived as audio:
 *  "always send text message instead of voice (sometime unable to understand)".
 *  Synthesised speech is strictly worse than text for a status line — it cannot
 *  be skimmed, searched or re-read, and a mishearing is silent.
 *
 *  `brain.voice_prompt_min_criticality` decides where voice starts: 'never'
 *  (default), 'high', or 'top'. A voice CALL for `top` stays available because
 *  its purpose is to interrupt, not to be read.
 */
async function channelForCriticality(
  c: Criticality,
  userId: number,
): Promise<'text' | 'voicenote' | 'call_business'> {
  if (c === 'top') return pickTopChannel(userId);
  let threshold = 'never';
  try {
    const { getConfig } = await import('../configService');
    const row = await prisma.user.findUnique({
      where: { id: userId }, select: { clientNumber: true },
    });
    if (row?.clientNumber) {
      threshold = (await getConfig(row.clientNumber, 'brain.voice_prompt_min_criticality')) ?? 'never';
    }
  } catch { /* unreadable config → text, the safe and preferred default */ }
  if (c === 'high' && threshold === 'high') return 'voicenote';
  return 'text';
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
