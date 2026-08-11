/**
 * Section 33a — inbound delegation-reply capture (REQ-003 approved).
 *
 * Correlation rules (exact):
 *  1. Quoted/reply-to provider id → the thread whose outbound_receipt
 *     carries that provider id, scoped (tenant, channel, sender
 *     identity is implicit via the event row's tenant+channel scope).
 *  2. Otherwise EXACTLY ONE active thread for (tenant, counterpart
 *     canonical key, channel).
 *  3. Zero matches → existing silent-drop policy (no notification, no
 *     storage). More than one → owner-scoped correlation incidents;
 *     no thread event, no lifecycle mutation.
 *
 * Fallback matching a dispatch_pending thread additionally requires
 * transport-attempt evidence (an outbound_intent that reached the
 * transport call) — an unsent thread must not consume unrelated
 * inbound (Codex mandatory detail 4; enforced here by requiring the
 * intent to be the thread's activeIntentEventId, which is set at
 * intent time, immediately before transport, and cleared on receipt).
 *
 * Counterpart content is untrusted data: it goes to the classifier as
 * fenced input and to feed storage — never interpreted as commands,
 * never echoed back, never answered (33a sends nothing to
 * counterparts).
 */
import { recordFinding } from '../selfheal/healthFindingService';
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import {
  ACTIVE_THREAD_STATES, appendEventWithTransition, counterpartKeyFor,
  isDelegationCaptureEnabled, canConsumeReply, DelegationChannel, DelegationThreadState,
} from './delegationThreadService';

const log = createLogger('delegation-capture');

export interface DelegationCaptureInput {
  clientNumber: string;
  channel: DelegationChannel;
  /** Raw sender identifier: phone (possibly @lid-resolved upstream) or email. */
  fromIdentifier: string;
  /** DEF-075 — the untouched provider id, e.g. `255043747987458@lid`, when the
   *  transport had one. `fromIdentifier` may be a SYNTHETIC phone built from a
   *  LID because neither getContact() nor the mapping API resolved the real
   *  number; that synthetic matches no thread, which is why every counterpart
   *  reply has been triaged as a stranger. */
  rawSenderId?: string | null;
  body: string;
  sourceId: string;                 // provider message id / feed event id — dedup anchor
  quotedProviderId?: string | null; // WhatsApp quoted message id
  inReplyTo?: string | null;        // email In-Reply-To
  evidenceSourceType?: 'whatsapp_message' | 'feed_event' | null;
  evidenceSourceId?: string | null;
}

export interface DelegationCaptureResult {
  matched: boolean;
  outcome?: 'consumed' | 'ambiguous' | 'no_thread' | 'disabled' | 'duplicate';
  threadId?: string;
  openItemId?: string;
}

export async function captureDelegationReply(input: DelegationCaptureInput): Promise<DelegationCaptureResult> {
  if (!await isDelegationCaptureEnabled(input.clientNumber)) return { matched: false, outcome: 'disabled' };

  let counterpartKey = counterpartKeyFor(input.channel, input.fromIdentifier);
  if (!counterpartKey) return { matched: false, outcome: 'no_thread' };

  // ── DEF-075 — bind the LID once, then match exactly forever after ────
  //
  // Fifth recurrence of the @lid class, and the first four all tried the same
  // thing: resolve LID → phone at read time. That depends on an upstream API
  // which has now failed four times, and when it fails `WebjsProvider` falls
  // back to `'+' + lid` — a SYNTHETIC number that matches nothing. Hamna's
  // reply arrived as `+255043747987458` while her thread is keyed
  // `wa:+923134199294`, so she was triaged as a stranger. That is the whole
  // reason no counterpart reply has ever been correlated.
  //
  // This stops depending on resolution. Two steps, neither calling the API:
  //
  //   1. KNOWN ALIAS — a contact already carrying this LID gives the real
  //      phone. Exact, permanent, and the path every reply after the first
  //      takes.
  //   2. BOOTSTRAP — an unknown LID replying while EXACTLY ONE thread is
  //      awaiting a reply from someone we messaged in the last 6 hours is
  //      almost certainly that person. Bind the alias to their contact, then
  //      proceed. One temporal inference buys permanent exactness.
  //
  // Deliberately narrow. Two candidates ⇒ no bind, because a wrong bind is
  // durable and would misroute that person's replies indefinitely. A known
  // alias is never overwritten by a guess.
  if (isSyntheticLidIdentity(input)) {
    const bound = await resolveByLidAlias(input);
    if (bound) counterpartKey = bound;
  }

  // ── correlation ────────────────────────────────────────────────────
  let thread: { id: string; state: string; ownerUserId: number; openItemId: string } | null = null;
  /** DEF-047: thread ids that were plausible but not chosen. Non-empty means
   *  the correlation is an INFERENCE, and the owner is told so. */
  let correlationInferredOver: string[] = [];
  /** DEF-064: set when this counterpart IS known but no thread of theirs can
   *  currently accept a reply. Distinguishes "who is this?" from "we know
   *  exactly who this is and our bookkeeping has moved on". */
  let knownButClosedToReplies = false;
  let knownThreadOwnerUserId: number | null = null;

  const referencedId = input.quotedProviderId || input.inReplyTo || null;
  if (referencedId) {
    const receipt = await prisma.delegationThreadEvent.findFirst({
      where: {
        clientNumber: input.clientNumber, channel: input.channel,
        eventType: 'outbound_receipt',
        OR: [{ providerMessageId: referencedId }, { emailMessageId: referencedId }],
      },
      select: { threadId: true },
    });
    if (receipt) {
      thread = await prisma.delegationThread.findFirst({
        where: { id: receipt.threadId, clientNumber: input.clientNumber, state: { in: ACTIVE_THREAD_STATES } },
        select: { id: true, state: true, ownerUserId: true, openItemId: true },
      });
    }
  }

  if (!thread) {
    const candidates = await prisma.delegationThread.findMany({
      where: {
        clientNumber: input.clientNumber, counterpartKey, channel: input.channel,
        state: { in: ACTIVE_THREAD_STATES },
      },
      select: {
        id: true, state: true, ownerUserId: true, openItemId: true,
        activeIntentEventId: true, updatedAt: true,
      },
      take: 30,
    });
    // Unsent new threads cannot consume unrelated inbound: dispatch_pending
    // qualifies only when its intent reached transport (activeIntentEventId set).
    //
    // DEF-064: and the state must actually PERMIT consuming a reply.
    // ACTIVE_THREAD_STATES is far wider than that — awaiting_owner,
    // resolved_pending_owner, followup_scheduled and reopened are all "active"
    // and none of them allows `→ evaluating`. Picking one produced
    // `illegal_transition`, and capture then reported no_thread and sent a
    // known counterpart to stranger-triage. Filtering here means recency can
    // only ever choose a thread that can receive the reply.
    // Two separate filters, and the order matters for the fallback below.
    // First: was anything actually SENT to this person? An unsent
    // dispatch_pending thread means we never messaged them, so an inbound is
    // not a reply to us and must not be treated as one.
    const actuallySent = candidates.filter((c: any) =>
      c.state !== 'dispatch_pending' || c.activeIntentEventId != null);
    // Second: can that thread's state legally take a reply (DEF-064)?
    const eligible = actuallySent.filter((c: any) => canConsumeReply(c.state));
    // "We messaged this person and they answered, but every one of those
    // threads has moved past accepting replies." Distinct from "we never
    // messaged them" — only the former earns the relay.
    knownButClosedToReplies = eligible.length === 0 && actuallySent.length > 0;
    knownThreadOwnerUserId = actuallySent[0]?.ownerUserId ?? null;
    if (eligible.length === 1) {
      thread = eligible[0];
    } else if (eligible.length > 1) {
      // ── DEF-047 (2026-08-05) — this used to REFUSE and return early ──
      //
      // The rule was "exactly one active thread, or no match". Measured
      // consequence on production: `delegation_thread_events` held 15 events
      // over four days, every one OUTBOUND. Not a single inbound reply had
      // EVER been correlated, while the follow-up worker kept messaging the
      // same counterparts daily. Hamna had two active threads on one number,
      // so no plain reply from her could ever be read.
      //
      // Refusing looks like the safe choice and is not: it converts "we might
      // attach this to the wrong item" into "we never hear from anyone, and we
      // keep nagging people who already answered". A person with two questions
      // outstanding who receives a reply attaches it to the more recent one and
      // asks if unsure. That is what happens here.
      //
      // The inference is CONSUMED but never presented as certain: the owner is
      // told which item it was attached to and what the alternatives were, so a
      // wrong guess is correctable. The incident row is still written, so the
      // audit trail is unchanged.
      const ordered = [...eligible].sort(
        (a: any, b: any) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      thread = ordered[0];
      correlationInferredOver = ordered.slice(1).map((t: any) => t.id);
      log.info('correlation inferred by recency', {
        counterpartKey, chosen: thread!.id, alternatives: correlationInferredOver.length,
      });
      await recordAmbiguityIncidents(input, counterpartKey, eligible);
    }
  }

  if (!thread) {
    // DEF-064 — a KNOWN person's reply is never thrown away.
    //
    // If we have threads with this counterpart but none can take a reply (all
    // resolved, or awaiting the owner), the honest outcome is not "unknown
    // sender". He asked her something; she answered; he is told. The thread
    // state machine is our bookkeeping problem, not a reason to lose her words.
    if (knownButClosedToReplies) {
      await notifyOwnerOfUnattachedReply(input, knownThreadOwnerUserId);
      return { matched: true, outcome: 'consumed' };
    }
    return { matched: false, outcome: 'no_thread' }; // silent drop upstream
  }

  // ── consume: inbound event + CAS → evaluating ─────────────────────
  const consumed = await appendEventWithTransition({
    clientNumber: input.clientNumber, threadId: thread.id,
    event: {
      eventType: 'inbound_received', direction: 'inbound', channel: input.channel,
      inboundSourceId: input.sourceId,
      quotedProviderId: input.quotedProviderId ?? null,
      inReplyTo: input.inReplyTo ?? null,
      provenance: 'external_delegatee_reply',
      evidenceSourceType: input.evidenceSourceType ?? null,
      evidenceSourceId: input.evidenceSourceId ?? null,
    },
    transition: {
      expectedState: thread.state as DelegationThreadState,
      toState: 'evaluating',
    },
  });
  if (!consumed.ok) {
    if (consumed.reason === 'duplicate_event') return { matched: true, outcome: 'duplicate', threadId: thread.id };
    log.warn('inbound consume failed', { threadId: thread.id, reason: consumed.reason });
    // DEF-064 is exactly this line. On 2026-08-06 it fired for Hamna's reply —
    // identified, correlated, then discarded because recency picked a thread in
    // a state that cannot accept an answer. It was a log line and nothing else,
    // so it rotated away and the break had to be reconstructed by hand.
    // Recording it makes "a real person answered and it went nowhere" a query.
    void recordFinding({
      clientNumber: input.clientNumber,
      kind: 'reply_consume_failed',
      severity: 'error',
      source: 'delegation-capture',
      subjectType: 'delegation_thread',
      subjectId: thread.id,
      summary: `a counterpart replied and the thread could not consume it: ${consumed.reason}`,
      evidence: { reason: consumed.reason, threadState: thread.state, attemptedTo: 'evaluating' },
    });
    return { matched: false, outcome: 'no_thread' };
  }

  await classifyAndRecord(input, thread, consumed.eventId!, correlationInferredOver);
  return { matched: true, outcome: 'consumed', threadId: thread.id, openItemId: thread.openItemId };
}

/**
 * DEF-064 — a known person answered, and we cannot file it. Tell him anyway.
 *
 * Every thread with this counterpart has moved past taking replies — resolved,
 * or waiting on the owner. The state machine has no slot for her words. That is
 * OUR bookkeeping problem; he asked her a question and she answered it, so he
 * hears it.
 *
 * Deliberately plain: her name, what she said, and an honest note that it is
 * not attached to anything. No classification, no completion inference, no
 * silent close — the thread is untouched.
 */
async function notifyOwnerOfUnattachedReply(
  input: DelegationCaptureInput,
  ownerUserId: number | null,
): Promise<void> {
  if (!ownerUserId) return;
  try {
    const digits = input.fromIdentifier.replace(/[^0-9]/g, '').slice(-9);
    const contact = await prisma.entity.findFirst({
      where: {
        clientNumber: input.clientNumber, entityType: 'contact',
        phone: { contains: digits },
      },
      select: { name: true },
    }).catch(() => null);
    const who = contact?.name ?? input.fromIdentifier;

    const { enqueueBrainPrompt } = await import('../brainPrompts/brainPromptQueueService');
    await enqueueBrainPrompt({
      userId: ownerUserId,
      clientNumber: input.clientNumber,
      question: `${who} replied: "${input.body.slice(0, 300)}"\n\n`
        + '(Not attached to an open request — everything I had with them is already closed or waiting on you.)',
      criticality: 'routine',
      // An answer is news, not a question — it must never hold the lock.
      expectsReply: false,
      dedupKey: `unattached_reply:${input.sourceId}`,
      metadata: { source: 'unattached_counterpart_reply', from: input.fromIdentifier },
    });
    log.info('unattached reply relayed to owner', { who, ownerUserId });
  } catch (error: any) {
    log.warn('unattached reply relay failed', { error: error?.message?.slice(0, 200) });
  }
}

// ── DEF-075: LID alias binding ───────────────────────────────────────

/** How far back an outbound counts as "we just messaged them". Owner-tunable
 *  (`delegation.lid_bootstrap_window_hours`): longer catches overnight replies
 *  but also raises the chance two counterparts overlap, in which case it
 *  refuses to bind at all. The literal is only the fallback when config is
 *  unreachable. */
async function bootstrapWindowMs(clientNumber: string): Promise<number> {
  try {
    const { getBehaviorValue } = await import('../behaviorConfig');
    const hours = await getBehaviorValue('delegation.lid_bootstrap_window_hours', { clientNumber });
    return Math.max(1, hours) * 60 * 60 * 1000;
  } catch { return 6 * 60 * 60 * 1000; }
}

/** True when `fromIdentifier` is the synthetic `'+' + lid` that WebjsProvider
 *  falls back to. A real phone never equals the LID digits. */
function isSyntheticLidIdentity(input: DelegationCaptureInput): boolean {
  const raw = (input.rawSenderId ?? '').trim();
  if (!raw.endsWith('@lid')) return false;
  return input.fromIdentifier.replace(/[^0-9]/g, '') === raw.replace('@lid', '');
}

/**
 * Turn a raw `@lid` into the counterpart key of a REAL phone, or null.
 *
 * Never calls the WhatsApp mapping API — that is precisely the dependency that
 * has failed four times and produced this fifth recurrence.
 */
async function resolveByLidAlias(input: DelegationCaptureInput): Promise<string | null> {
  const lid = (input.rawSenderId ?? '').trim();
  if (!lid) return null;

  // 1. Known alias — exact, and the path every reply after the first takes.
  const known = await prisma.entity.findFirst({
    where: {
      clientNumber: input.clientNumber, entityType: 'contact',
      metadata: { path: ['waLid'], equals: lid } as any,
    },
    select: { id: true, name: true, phone: true },
  }).catch(() => null);
  if (known?.phone) {
    const key = counterpartKeyFor(input.channel, known.phone);
    if (key) {
      log.info('lid alias hit', { lid, contact: known.name });
      return key;
    }
  }

  // 2. Bootstrap. Exactly ONE thread awaiting a reply from someone messaged
  //    recently ⇒ this is almost certainly them. Two candidates and we do not
  //    guess: a wrong bind is durable and would misroute them indefinitely.
  const since = new Date(Date.now() - await bootstrapWindowMs(input.clientNumber));
  const waiting = await prisma.delegationThread.findMany({
    where: {
      clientNumber: input.clientNumber, channel: input.channel,
      state: { in: ACTIVE_THREAD_STATES },
      updatedAt: { gte: since },
      counterpartNumberCanonical: { not: null },
    },
    select: { counterpartNumberCanonical: true, counterpartKey: true },
    take: 10,
  }).catch(() => [] as any[]);

  const distinct = Array.from(new Set(
    waiting.map((t: any) => t.counterpartNumberCanonical).filter(Boolean)));
  if (distinct.length !== 1) {
    log.info('lid bootstrap declined', { lid, candidates: distinct.length });
    return null;
  }

  const phone = String(distinct[0]);
  const key = counterpartKeyFor(input.channel, phone);
  if (!key) return null;

  // Persist so this is the LAST time we infer for this person.
  const contact = await prisma.entity.findFirst({
    where: {
      clientNumber: input.clientNumber, entityType: 'contact',
      phone: { contains: phone.replace(/[^0-9]/g, '').slice(-9) },
    },
    select: { id: true, name: true, metadata: true },
  }).catch(() => null);
  if (contact) {
    const meta = { ...((contact.metadata ?? {}) as Record<string, unknown>) };
    if (!meta.waLid) {
      meta.waLid = lid;
      meta.waLidBoundAt = new Date().toISOString();
      meta.waLidBoundBy = 'reply_bootstrap';
      await prisma.entity.update({ where: { id: contact.id }, data: { metadata: meta as any } })
        .catch(() => undefined);
      log.info('lid alias bound', { lid, contact: contact.name, phone });
    }
  }
  return key;
}

// ── classification (persisted, idempotent) ───────────────────────────

async function classifyAndRecord(
  input: DelegationCaptureInput,
  thread: { id: string; ownerUserId: number; openItemId: string },
  inboundEventId: string,
  /** DEF-047: non-empty when the thread was chosen by recency among several
   *  candidates, i.e. the correlation is an inference the owner should see. */
  correlationInferredOver: string[] = [],
): Promise<void> {
  const item = await prisma.openItem.findFirst({
    where: { id: thread.openItemId, clientNumber: input.clientNumber },
    select: { title: true, dueDate: true, userId: true },
  });

  const { interpretActionReplyStrict } = await import('../openItems/actionLifecycleService');
  const interpretation = item
    ? await interpretActionReplyStrict(input.body, { title: item.title, currentDueDate: item.dueDate })
    : null;

  if (!interpretation) {
    // Classifier failure: processing event + owner notification; thread
    // state UNCHANGED (remains evaluating for owner/TTL resolution).
    await appendEventWithTransition({
      clientNumber: input.clientNumber, threadId: thread.id,
      event: {
        eventType: 'processing_error', channel: input.channel,
        sourceEventId: inboundEventId, provenance: 'system',
        classification: { error: 'classifier_unavailable_or_strict_failure' },
      },
    });
    await notifyOwner(input.clientNumber, thread, 'classifier_failure',
      { kind: 'delegation_reply_unclassified', threadId: thread.id, openItemId: thread.openItemId });
    return;
  }

  // Completion threshold: protocol constant aligned with the lifecycle
  // service's own 0.7 gate (single number, single meaning).
  const confident = interpretation.confidence >= 0.7;

  const outcome = interpretation.outcome === 'completed' && interpretation.completionEvidence && confident
    ? 'completed'
    : interpretation.outcome === 'blocked' && confident ? 'blocked'
    : interpretation.outcome === 'unknown' ? 'unrelated'
    : !confident ? 'low_confidence'
    : 'in_progress';

  // Persisted verdict FIRST (idempotency anchor) — lifecycle consumption
  // keys off this row, never a live LLM result.
  const verdict = await appendEventWithTransition({
    clientNumber: input.clientNumber, threadId: thread.id,
    event: {
      eventType: 'classification_recorded', channel: input.channel,
      sourceEventId: inboundEventId, classifierKey: 'action_reply_strict_v1',
      classification: {
        outcome, rawOutcome: interpretation.outcome,
        confidence: interpretation.confidence,
        summary: interpretation.summary.slice(0, 500),
      },
      provenance: 'system',
    },
    transition: {
      expectedState: 'evaluating',
      toState: outcome === 'completed' ? 'resolved_pending_owner'
        : outcome === 'blocked' ? 'awaiting_owner'
        : outcome === 'low_confidence' ? 'awaiting_owner'
        : 'awaiting_reply', // in_progress and unrelated keep the thread open
    },
  });
  if (!verdict.ok && verdict.reason === 'duplicate_event') return; // retried classification — already recorded

  // Evidence onto the open item through the fenced lifecycle path
  // (notes + intervention prompt; no close, no dueDate, no fallback).
  const { recordActionLifecycleReply } = await import('../openItems/actionLifecycleService');
  await recordActionLifecycleReply({
    openItemId: thread.openItemId, clientNumber: input.clientNumber,
    body: input.body, source: input.channel === 'whatsapp' ? 'whatsapp' : 'email',
    sourceId: input.sourceId, interpretation, mode: 'thread_capture',
  }).catch((e: any) => log.warn('thread_capture lifecycle record failed', { error: e.message }));

  if (outcome === 'completed') {
    // DEF-080: the ANSWER is news and must not queue behind an unrelated
    // question. On 2026-08-06 prompt 277 ("that reply matched 3 open threads")
    // reached the owner because I had marked it a notice, while 276 — the
    // actual answer, "reports completion: Issue resolved" — sat queued because
    // I had left it expecting a reply. He got the footnote and not the content.
    // Confirming the close is a separate, later question; hearing the answer is
    // not optional.
    await notifyOwner(input.clientNumber, thread, 'completion_reported',
      { kind: 'delegation_completion_reported', threadId: thread.id, openItemId: thread.openItemId, summary: interpretation.summary.slice(0, 300) },
      { expectsReply: false });
  } else if (outcome === 'low_confidence') {
    await notifyOwner(input.clientNumber, thread, 'low_confidence',
      { kind: 'delegation_reply_unclear', threadId: thread.id, openItemId: thread.openItemId },
      { expectsReply: false });
  } else if (outcome === 'in_progress') {
    // ── DEF-048 (2026-08-05) — the owner was never told a reply arrived ──
    //
    // Only `completed` and `low_confidence` notified. A counterpart answering
    // the actual question — "yes, I'll be in tomorrow" — classifies as
    // in_progress, was filed silently onto the open item, and the owner was
    // never informed. From his side that is indistinguishable from no reply at
    // all, which is exactly what he reported: "is Brain reading responses from
    // those to whom it sent message?"
    //
    // An answer to a question you asked is the POINT of asking. It is reported.
    await notifyOwner(input.clientNumber, thread, 'reply_received',
      {
        kind: 'delegation_reply_received', threadId: thread.id,
        openItemId: thread.openItemId, summary: interpretation.summary.slice(0, 300),
      },
      // DEF-063: an answer is news, not a question. It must not take the
      // conversational lock and block the NEXT counterpart's reply.
      { expectsReply: false });
  }
  // blocked → recordActionLifecycleReply's existing deduped intervention
  // prompt covers the owner notice; unrelated → deliberately silent.

  // DEF-047: the correlation above was a RECENCY GUESS between several open
  // threads with the same counterpart. Tell the owner, so a wrong attachment is
  // correctable instead of silent. Separate from the reply notice on purpose —
  // this is about our confidence, not about what they said.
  if (correlationInferredOver.length > 0) {
    await notifyOwner(input.clientNumber, thread, 'correlation_inferred',
      {
        kind: 'delegation_reply_correlation_inferred', threadId: thread.id,
        openItemId: thread.openItemId, alternatives: correlationInferredOver.length,
      },
      { expectsReply: false });
  }
}

// ── ambiguity incidents (owner-scoped, capped, transactional) ────────

async function recordAmbiguityIncidents(
  input: DelegationCaptureInput,
  counterpartKey: string,
  candidates: Array<{ id: string; ownerUserId: number }>,
): Promise<void> {
  const byOwner = new Map<number, string[]>();
  for (const c of candidates) {
    byOwner.set(c.ownerUserId, [...(byOwner.get(c.ownerUserId) ?? []), c.id]);
  }
  const { getBehaviorValue } = await import('../behaviorConfig');
  const cap = await getBehaviorValue('delegation.ambiguity_candidate_cap', { clientNumber: input.clientNumber }).catch(() => 10);

  for (const [ownerUserId, threadIds] of byOwner) {
    const incidentDate = await ownerLocalDate(input.clientNumber, ownerUserId);
    try {
      await prisma.$transaction(async (tx: any) => {
        const incident = await tx.correlationIncident.upsert({
          where: {
            clientNumber_ownerUserId_counterpartKey_channel_incidentDate: {
              clientNumber: input.clientNumber, ownerUserId,
              counterpartKey, channel: input.channel, incidentDate,
            },
          },
          create: {
            clientNumber: input.clientNumber, ownerUserId,
            channel: input.channel, counterpartKey, incidentDate,
          },
          update: {},
          select: { id: true },
        });
        // Cap enforced under the incident row lock (Codex detail 3).
        await tx.$queryRawUnsafe(
          `SELECT id FROM correlation_incidents WHERE id = $1 FOR UPDATE`, incident.id,
        );
        let count = await tx.correlationIncidentCandidate.count({ where: { incidentId: incident.id } });
        let overflow = 0;
        for (const threadId of threadIds) {
          if (count >= cap) { overflow += 1; continue; }
          await tx.correlationIncidentCandidate.upsert({
            where: { incidentId_threadId: { incidentId: incident.id, threadId } },
            create: {
              clientNumber: input.clientNumber, ownerUserId,
              incidentId: incident.id, threadId,
            },
            update: {},
          });
          count += 1;
        }
        if (overflow > 0) {
          await tx.correlationIncident.update({
            where: { id: incident.id },
            data: { overflowCount: { increment: overflow } },
          });
        }
      });
    } catch (error: any) {
      log.warn('ambiguity incident record failed', { ownerUserId, error: error?.message?.slice(0, 200) });
      continue;
    }
    await notifyOwner(input.clientNumber, { id: 'n/a', ownerUserId, openItemId: '' }, `ambiguity:${counterpartKey}:${incidentDate.toISOString().slice(0, 10)}`,
      { kind: 'delegation_reply_ambiguous', counterpartKey, channel: input.channel });
  }
}

async function ownerLocalDate(clientNumber: string, ownerUserId: number): Promise<Date> {
  void clientNumber; // owner tz is user-level; tenant default folds into resolveUserTimezone
  try {
    const { resolveUserTimezone } = await import('../userTimezoneService');
    const tz = await resolveUserTimezone(ownerUserId);
    const local = new Date().toLocaleDateString('en-CA', { timeZone: tz || 'UTC' });
    return new Date(`${local}T00:00:00.000Z`);
  } catch {
    return new Date(new Date().toISOString().slice(0, 10)); // documented fallback: UTC date
  }
}

// ── owner notification (deduped; structured; invariant-compliant) ────

async function notifyOwner(
  clientNumber: string,
  thread: { id: string; ownerUserId: number; openItemId: string },
  dedupClass: string,
  metadata: Record<string, unknown>,
  opts: { expectsReply?: boolean } = {},
): Promise<void> {
  try {
    const { enqueueBrainPrompt } = await import('../brainPrompts/brainPromptQueueService');
    const day = new Date().toISOString().slice(0, 10);
    // DEF-122 — name the person and the item.
    //
    // Owner, 2026-08-11, on receiving "A delegatee replied on a tracked item but
    // the reply could not be confidently classified": *"what is meant for?"*.
    //
    // Fair question — the message named nobody and nothing. Brain KNEW both:
    // the metadata already carried threadId and openItemId, and the thread row
    // carries the counterpart. Four of the seven notices below were written
    // without them, so the owner was asked to "review the item" without being
    // told which item, who replied, or what they said. That is not a notice, it
    // is a puzzle.
    const context = await resolveNotifyContext(clientNumber, thread).catch(() => ({}));
    await enqueueBrainPrompt({
      userId: thread.ownerUserId,
      clientNumber,
      question: buildOwnerQuestion(metadata, context),
      openItemId: thread.openItemId || undefined,
      sideEffect: { kind: 'action_status_update', ...(thread.openItemId ? { openItemId: thread.openItemId } : {}) },
      criticality: metadata.kind === 'delegation_completion_reported' ? 'high' : 'routine',
      dedupKey: `delegation:${thread.id}:${dedupClass}:${day}`,
      metadata: { source: 'delegation_capture', ...metadata },
      expectsReply: opts.expectsReply,
    });
  } catch (error: any) {
    log.warn('owner notification failed', { error: error?.message?.slice(0, 200) });
  }
}


/**
 * Who replied, and about what — the two facts every notice needs.
 *
 * Read at notify time rather than carried in metadata: a thread's item can be
 * renamed and a contact's name filled in between the reply arriving and the
 * owner reading about it, and the fresher answer is the useful one.
 *
 * Both are optional. A notice missing a name is worse than one with it, but a
 * notice that never sends because a lookup failed is worse than either — so
 * every failure degrades to "unknown" rather than throwing.
 */
async function resolveNotifyContext(
  clientNumber: string,
  thread: { id: string; openItemId: string },
): Promise<{ who?: string; item?: string; said?: string }> {
  // Resolve the name TWO ways, because the first one is usually empty.
  //
  // Every delegation thread on this tenant has counterpart_entity_id = NULL,
  // so a join on that link alone yields nothing and the notice falls back to a
  // bare phone number. Meanwhile `entities` knows the person perfectly well:
  // +923134199294 is Hamna Latif Bhutta, +923028000553 is Muhammad Yousaf.
  //
  // So: the entity link when present, otherwise a lookup by the phone inside
  // counterpart_key ("wa:+92..."). Telling the owner "+923134199294 replied"
  // about someone he speaks to daily is barely better than telling him nothing.
  const [row] = await prisma.$queryRawUnsafe<Array<any>>(
    `SELECT COALESCE(
              NULLIF(e.name, ''),
              NULLIF(byphone.name, ''),
              t.counterpart_key
            )                    AS who,
            oi.title             AS item
       FROM delegation_threads t
       LEFT JOIN entities   e  ON e.id = t.counterpart_entity_id
       LEFT JOIN open_items oi ON oi.id = t.open_item_id
       LEFT JOIN LATERAL (
         SELECT c.name
           FROM entities c
          WHERE c.client_number = t.client_number
            AND c.phone IS NOT NULL
            AND c.phone = regexp_replace(t.counterpart_key, '^[a-z]+:', '')
          ORDER BY c.name NULLS LAST
          LIMIT 1
       ) byphone ON TRUE
      WHERE t.id = $1 AND t.client_number = $2`,
    thread.id, clientNumber,
  ).catch(() => []);

  // The reply itself. Stored as evidence when it arrived — quoting it back is
  // what lets the owner judge in one read instead of opening the item.
  const [ev] = await prisma.$queryRawUnsafe<Array<any>>(
    `SELECT body FROM delegation_thread_events
      WHERE thread_id = $1 AND event_type = 'inbound_received'
      ORDER BY created_at DESC LIMIT 1`,
    thread.id,
  ).catch(() => []);

  return {
    // counterpart_key looks like "wa:+923134199294" — the prefix is machinery.
    who: row?.who ? String(row.who).replace(/^wa:/, '') : undefined,
    item: row?.item ? String(row.item) : undefined,
    said: ev?.body ? String(ev.body).replace(/\s+/g, ' ').trim().slice(0, 200) : undefined,
  };
}

/** Owner-facing prompt text. These are structured system notices about
 *  machine state (delegation thread events), rendered factually — the
 *  invariant's bracketed-marker class; no fabricated Brain prose, no
 *  counterpart content beyond the bounded classifier summary. */
function buildOwnerQuestion(
  metadata: Record<string, unknown>,
  ctx: { who?: string; item?: string; said?: string } = {},
): string {
  // DEF-122: every notice names the person and the item when they are known.
  // "someone" and "an item you delegated" are the honest fallbacks — vague, but
  // never a fabricated name.
  const who = ctx.who || 'Someone';
  const about = ctx.item ? `"${ctx.item}"` : 'an item you delegated';
  const said = ctx.said ? `\n\nThey said: "${ctx.said}"` : '';

  switch (metadata.kind) {
    case 'delegation_completion_reported':
      return `${who} says ${about} is done: ${String(metadata.summary ?? '').slice(0, 300)} — confirm to close it, or tell me what is still missing.`;
    case 'delegation_reply_unclear':
      return `${who} replied about ${about}, but I could not tell whether it means done, delayed, or something else.${said}\n\nHow should I take it?`;
    case 'delegation_reply_unclassified':
      return `${who} replied about ${about}. I could not read it well enough to judge, so I have kept it as-is.${said}\n\nWhat would you like me to do?`;
    case 'delegation_reply_ambiguous':
      return `${who} replied, but they have more than one open item with you, so I could not tell which one they meant.${said}\n\nWhich item is it?`;
    case 'delegation_reply_received':
      return `${who} replied about ${about}: ${String(metadata.summary ?? '').slice(0, 300)} — tell me if you want anything done about it.`;
    case 'delegation_reply_correlation_inferred':
      return `${who} replied and it matched ${Number(metadata.alternatives ?? 0) + 1} of their open items; I attached it to ${about}, the most recent.${said}\n\nTell me if it belongs to a different one.`;
    default:
      return `${who} — something needs your attention on ${about}.`;
  }
}
