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
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import {
  ACTIVE_THREAD_STATES, appendEventWithTransition, counterpartKeyFor,
  isDelegationCaptureEnabled, DelegationChannel, DelegationThreadState,
} from './delegationThreadService';

const log = createLogger('delegation-capture');

export interface DelegationCaptureInput {
  clientNumber: string;
  channel: DelegationChannel;
  /** Raw sender identifier: phone (possibly @lid-resolved upstream) or email. */
  fromIdentifier: string;
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

  const counterpartKey = counterpartKeyFor(input.channel, input.fromIdentifier);
  if (!counterpartKey) return { matched: false, outcome: 'no_thread' };

  // ── correlation ────────────────────────────────────────────────────
  let thread: { id: string; state: string; ownerUserId: number; openItemId: string } | null = null;
  /** DEF-047: thread ids that were plausible but not chosen. Non-empty means
   *  the correlation is an INFERENCE, and the owner is told so. */
  let correlationInferredOver: string[] = [];

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
    const eligible = candidates.filter((c: any) =>
      c.state !== 'dispatch_pending' || c.activeIntentEventId != null);
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

  if (!thread) return { matched: false, outcome: 'no_thread' }; // silent drop upstream

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
    return { matched: false, outcome: 'no_thread' };
  }

  await classifyAndRecord(input, thread, consumed.eventId!, correlationInferredOver);
  return { matched: true, outcome: 'consumed', threadId: thread.id, openItemId: thread.openItemId };
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
    await notifyOwner(input.clientNumber, thread, 'completion_reported',
      { kind: 'delegation_completion_reported', threadId: thread.id, openItemId: thread.openItemId, summary: interpretation.summary.slice(0, 300) });
  } else if (outcome === 'low_confidence') {
    await notifyOwner(input.clientNumber, thread, 'low_confidence',
      { kind: 'delegation_reply_unclear', threadId: thread.id, openItemId: thread.openItemId });
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
      });
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
      });
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
): Promise<void> {
  try {
    const { enqueueBrainPrompt } = await import('../brainPrompts/brainPromptQueueService');
    const day = new Date().toISOString().slice(0, 10);
    await enqueueBrainPrompt({
      userId: thread.ownerUserId,
      clientNumber,
      question: buildOwnerQuestion(metadata),
      openItemId: thread.openItemId || undefined,
      sideEffect: { kind: 'action_status_update', ...(thread.openItemId ? { openItemId: thread.openItemId } : {}) },
      criticality: metadata.kind === 'delegation_completion_reported' ? 'high' : 'routine',
      dedupKey: `delegation:${thread.id}:${dedupClass}:${day}`,
      metadata: { source: 'delegation_capture', ...metadata },
    });
  } catch (error: any) {
    log.warn('owner notification failed', { error: error?.message?.slice(0, 200) });
  }
}

/** Owner-facing prompt text. These are structured system notices about
 *  machine state (delegation thread events), rendered factually — the
 *  invariant's bracketed-marker class; no fabricated Brain prose, no
 *  counterpart content beyond the bounded classifier summary. */
function buildOwnerQuestion(metadata: Record<string, unknown>): string {
  switch (metadata.kind) {
    case 'delegation_completion_reported':
      return `The responsible person reports completion: ${String(metadata.summary ?? '').slice(0, 300)} — confirm to close the item, or tell me what is still missing.`;
    case 'delegation_reply_unclear':
      return 'A delegatee replied on a tracked item but the reply could not be confidently classified. Please review the item and tell me how to proceed.';
    case 'delegation_reply_unclassified':
      return 'A delegatee reply was received but classification failed. The reply is stored as evidence; please review the item.';
    case 'delegation_reply_ambiguous':
      return 'A reply arrived from a contact with more than one open delegation. Please tell me which item it belongs to.';
    case 'delegation_reply_received':
      return `They replied: ${String(metadata.summary ?? '').slice(0, 300)} — tell me if you want anything done about it.`;
    case 'delegation_reply_correlation_inferred':
      return `That reply matched ${Number(metadata.alternatives ?? 0) + 1} open threads with the same contact; I attached it to the most recent one. Tell me if it belongs to a different item.`;
    default:
      return 'A delegation thread needs your attention.';
  }
}
