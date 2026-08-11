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
    // DEF-123: ask HER which item, not him. She knows; he would be guessing.
    //
    // The whole block is wrapped because it is an ENHANCEMENT to correlation,
    // never a precondition for it. A `.catch()` alone is not enough: if the
    // Prisma method is missing the call throws SYNCHRONOUSLY, before any
    // promise exists, so the catch never runs and the throw takes the entire
    // capture path with it — an ambiguous reply would stop being recorded at
    // all. Asking a nicer question is not worth that.
    let candidateItems: Array<{ id: string; title: string }> = [];
    let askedHer = false;
    try {
      candidateItems = await prisma.$queryRawUnsafe<Array<{ id: string; title: string }>>(
        `SELECT oi.id, oi.title
           FROM delegation_threads t
           JOIN open_items oi ON oi.id = t.open_item_id
          WHERE t.client_number = $1 AND t.counterpart_key = $2 AND t.channel = $3
            AND oi.status NOT IN ('DONE','CANCELLED','CLOSED')
          ORDER BY t.updated_at DESC LIMIT 4`,
        input.clientNumber, counterpartKey, input.channel,
      );
      askedHer = await askCounterpartWhichItem(
        input.clientNumber, counterpartKey, input.channel, ownerUserId, candidateItems,
      );
    } catch (error: any) {
      log.warn('counterpart clarification skipped — owner will be asked instead', {
        error: error?.message?.slice(0, 200),
      });
    }

    // He is told either way. If Brain messaged her, he learns that from Brain —
    // never from her.
    await notifyOwner(input.clientNumber, { id: 'n/a', ownerUserId, openItemId: '' }, `ambiguity:${counterpartKey}:${incidentDate.toISOString().slice(0, 10)}`,
      { kind: askedHer ? 'delegation_reply_ambiguous_asked' : 'delegation_reply_ambiguous',
        counterpartKey, channel: input.channel,
        candidates: candidateItems.map((c) => c.title).slice(0, 4) });
  }
}


/**
 * DEF-123 — when Brain cannot tell which item a reply is about, ASK THE PERSON
 * WHO KNOWS.
 *
 * Owner, 2026-08-11: *"brain knows that against which that Hamna's message
 * belongs to, if not then brain should get clarification from Hamna and then
 * update me"*.
 *
 * Until now an ambiguous reply woke the OWNER: "they have more than one open
 * item with you — which is it?". That asks the one person in the exchange who
 * did not send the message. Hamna knows what she was answering; he has to guess
 * from a list.
 *
 * This is a deliberate change to the 33a policy that Brain "never replies to
 * the sender". That rule exists to stop Brain conversing with strangers, and it
 * still holds for strangers. A tracked delegatee, mid-thread, on an item the
 * owner assigned them, is not a stranger — and `smartChaseService` has always
 * been allowed to chase them, so the capability boundary was never really
 * "no contact", it was "no unsolicited conversation".
 *
 * Guarded hard:
 *   - ONLY a known counterpart with real open items. Never an unresolved LID,
 *     never a stranger.
 *   - ONE question per counterpart per day, whatever else happens. Being asked
 *     twice to disambiguate is worse than not being asked.
 *   - The owner is told immediately that Brain asked, and what it asked. He
 *     must never learn from Hamna that his assistant messaged her.
 *   - Failure to reach her falls back to asking him — the previous behaviour,
 *     so nothing is lost when this cannot run.
 */
async function askCounterpartWhichItem(
  clientNumber: string,
  counterpartKey: string,
  channel: DelegationChannel,
  ownerUserId: number,
  candidates: Array<{ id: string; title: string }>,
): Promise<boolean> {
  if (channel !== 'whatsapp' || candidates.length < 2) return false;

  const phone = counterpartKey.replace(/^[a-z]+:/, '');
  if (!/^\+\d{8,15}$/.test(phone)) return false;      // never an unresolved LID

  // One ask per counterpart per day. `dedup_key` on the thread events is the
  // wrong home for this (it is not a thread event), so the guard is a direct
  // look at what we already sent her today.
  const day = new Date().toISOString().slice(0, 10);
  // Same synchronous-throw hazard as above: guard the call, not just the promise.
  let asked: Array<{ n: number }> = [{ n: 0 }];
  try {
    asked = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT COUNT(*)::int AS n FROM whatsapp_outbound_messages
        WHERE client_number = $1 AND chat_id LIKE $2
          AND body_text LIKE '%which one%'
          AND sent_at::date = $3::date`,
      clientNumber, `%${phone.replace('+', '')}%`, day,
    );
  } catch { return false; }   // cannot prove we have not already asked -> do not ask
  if ((asked[0]?.n ?? 0) > 0) return false;

  try {
    const { renderOutboundMessage } = await import('../notifications/outboundMessageTemplate');
    const { sendTenantWhatsAppText } = await import('../notifications/tenantWhatsappSender');

    const [owner] = await prisma.$queryRawUnsafe<Array<any>>(
      `SELECT name FROM users WHERE id = $1 AND client_number = $2`, ownerUserId, clientNumber,
    ).catch(() => []);
    const [cfg] = await prisma.$queryRawUnsafe<Array<any>>(
      `SELECT value FROM system_config WHERE client_number = $1 AND key = 'brain_name'`, clientNumber,
    ).catch(() => []);

    const list = candidates.slice(0, 4).map((c, i) => `${i + 1}. ${c.title}`).join('\n');
    const body = renderOutboundMessage(
      `Thanks for the update. You have more than one item open with ${owner?.name ?? 'us'}, ` +
      `so I want to record it against the right one — which one were you replying about?\n\n${list}\n\n` +
      `Just the number is fine.`,
      { brainName: cfg?.value ?? 'Nexeo', userName: owner?.name ?? '' },
    );

    const out = await sendTenantWhatsAppText(clientNumber, phone, body, ownerUserId);
    if (!out?.ok) return false;

    log.info('asked counterpart to disambiguate', { phone, candidates: candidates.length });
    return true;
  } catch (error: any) {
    log.warn('counterpart clarification failed — falling back to asking the owner', {
      error: error?.message?.slice(0, 200),
    });
    return false;
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

/**
 * DEF-126 — rebuild a queued delegation notice from the CURRENT wording.
 *
 * Owner, 2026-08-11, receiving *"A reply arrived from a contact with more than
 * one open delegation. Please tell me which item it belongs to."* for the second
 * time: *"this is again meaningless for me"*.
 *
 * He was right, and the reason is worse than the wording. That sentence no
 * longer exists anywhere in this codebase — DEF-122 and DEF-123 replaced it
 * hours earlier. What reached him was a sentence FROZEN IN THE QUEUE:
 *
 *   prompt 324   queued 07:02   sent 11:28
 *   DEF-122b deployed 07:29 · DEF-123 deployed 08:35
 *
 * Composed at 07:02, delivered four and a half hours later, having missed two
 * fixes that were live before it left. Every wording fix shipped so far has had
 * this hole under it: the improvement applies to future questions and the
 * backlog keeps delivering the old one. That is why a fix can be real and the
 * owner still sees no progress — and it is the honest explanation for "nothing
 * found progressive in brain".
 *
 * So the queue stores the FACTS and the sentence is built when it is sent.
 * Returns null when the row is not a delegation notice or carries no context,
 * and the stored text stands — a missing re-render must never blank a message.
 */
export function rerenderOwnerQuestion(metadata: unknown): string | null {
  const m = (metadata ?? {}) as Record<string, unknown>;
  if (m.source !== 'delegation_capture' || typeof m.kind !== 'string') return null;
  const ctx = (m.question_ctx ?? null) as Record<string, unknown> | null;
  // Rows queued before DEF-126 have no stored context. Rebuilding those from
  // nothing would strip the name and the quote back out — strictly worse than
  // the stale sentence they already carry.
  if (!ctx || typeof ctx !== 'object') return null;
  try {
    const text = buildOwnerQuestion(m, ctx as any);
    return text && text.trim() ? text : null;
  } catch {
    return null;
  }
}

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
      // DEF-126 — carry the ingredients, not just the cooked sentence. A queued
      // question can wait hours before it is sent, and the wording it was built
      // with may be obsolete by then. Storing the context lets the send path
      // rebuild the sentence from the CURRENT template.
      metadata: { source: 'delegation_capture', ...metadata, question_ctx: context },
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
): Promise<{ who?: string; item?: string; said?: string; guess?: string; confidence?: number }> {
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

  // What she actually said.
  //
  // NOT from the inbound event — that row records only that a reply arrived.
  // There is no `body` column, and evidence_source_id is null on every one of
  // them, so the counterpart's verbatim words are genuinely not retained
  // (unregistered senders' bodies are deliberately never written to
  // whatsapp_messages). My first attempt queried `body` and the catch swallowed
  // the error, which would have made the quote silently never appear — the same
  // failure this whole fix exists to remove.
  //
  // The classifier's summary is what IS kept, and it is the useful thing:
  //   {"outcome":"low_confidence","confidence":0.5,"rawOutcome":"in_progress",
  //    "summary":"The Vision Metric's service sales package video is not yet complete."}
  //
  // Brain had all of that and told the owner none of it. Passing the summary and
  // the best-guess outcome through is the difference between "I could not
  // classify it" and "she says it is not finished; my read is in-progress, but I
  // am only half sure".
  const [ev] = await prisma.$queryRawUnsafe<Array<any>>(
    `SELECT classification FROM delegation_thread_events
      WHERE thread_id = $1 AND event_type = 'classification_recorded'
        AND classification IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    thread.id,
  ).catch(() => []);
  const cls = (ev?.classification ?? {}) as Record<string, unknown>;

  return {
    // counterpart_key looks like "wa:+923134199294" — the prefix is machinery.
    who: row?.who ? String(row.who).replace(/^wa:/, '') : undefined,
    item: row?.item ? String(row.item) : undefined,
    said: cls.summary ? String(cls.summary).replace(/\s+/g, ' ').trim().slice(0, 220) : undefined,
    // The classifier's own best guess and how sure it was. Withholding these
    // makes Brain look blank when it actually had a view.
    guess: cls.rawOutcome ? String(cls.rawOutcome).replace(/_/g, ' ') : undefined,
    confidence: typeof cls.confidence === 'number' ? cls.confidence : undefined,
  };
}

/** Owner-facing prompt text. These are structured system notices about
 *  machine state (delegation thread events), rendered factually — the
 *  invariant's bracketed-marker class; no fabricated Brain prose, no
 *  counterpart content beyond the bounded classifier summary. */
function buildOwnerQuestion(
  metadata: Record<string, unknown>,
  ctx: { who?: string; item?: string; said?: string; guess?: string; confidence?: number } = {},
): string {
  // DEF-122: every notice names the person and the item when they are known.
  // "someone" and "an item you delegated" are the honest fallbacks — vague, but
  // never a fabricated name.
  const who = ctx.who || 'Someone';
  const about = ctx.item ? `"${ctx.item}"` : 'an item you delegated';
  const said = ctx.said ? `\n\nWhat they said: ${ctx.said}` : '';
  // Say the best guess out loud. "I could not classify it" reads as blank;
  // "my read is in-progress, but I am only half sure" is a judgement the owner
  // can accept or correct in one word.
  const guess = ctx.guess
    ? `\n\nMy read: ${ctx.guess}${typeof ctx.confidence === 'number' ? ` (about ${Math.round(ctx.confidence * 100)}% sure)` : ''}.`
    : '';

  switch (metadata.kind) {
    case 'delegation_completion_reported':
      return `${who} says ${about} is done: ${String(metadata.summary ?? '').slice(0, 300)} — confirm to close it, or tell me what is still missing.`;
    case 'delegation_reply_unclear':
      return `${who} replied about ${about}.${said}${guess}\n\nI am not confident enough to act on it — should I mark it done, chase her, or leave it?`;
    case 'delegation_reply_unclassified':
      return `${who} replied about ${about}, and I could not read it well enough to judge.${said}${guess}\n\nWhat would you like me to do?`;
    case 'delegation_reply_ambiguous_asked': {
      const list = Array.isArray(metadata.candidates) && metadata.candidates.length
        ? `\n\n${(metadata.candidates as string[]).map((t, i) => `${i + 1}. ${t}`).join('\n')}`
        : '';
      return `${who} replied, but it matched more than one of their open items so I could not tell which.${said}\n\n` +
             `I have asked them which one they meant.${list}\n\nI will update you as soon as they answer.`;
    }
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
