/**
 * Section 33a — delegation thread spine (REQ-003 approved, 2026-07-22).
 *
 * One thread per (tenant, open item, counterpart, channel); an
 * append-only event ledger carries every outbound intent/receipt,
 * inbound, persisted classification, and processing error. All state
 * transitions are CAS ("WHERE state = expected") inside the same
 * transaction as their event insert — duplicate provider deliveries
 * die on the partial-unique inbound index, stale receipts die on the
 * active-intent binding, concurrent transitions die on the CAS.
 *
 * 33a scope fence: capture + evidence + classification + owner
 * notification. Nothing here sends to counterparts; grants exist as
 * schema only (zero create/read/consume); autonomous outbound has no
 * consumer and its flag defaults OFF.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('delegation-threads');

export type DelegationChannel = 'whatsapp' | 'email';

export type DelegationThreadState =
  | 'pending_first_dispatch' | 'dispatch_pending' | 'awaiting_reply'
  | 'evaluating' | 'awaiting_owner' | 'followup_scheduled'
  | 'resolved_pending_owner' | 'reopened' | 'receipt_unknown'
  | 'closed' | 'expired' | 'cancelled';

/** Exact active-state set backing the partial uniques and the
 *  single-active-thread correlation rule. Must stay in lockstep with
 *  the migration's WHERE clauses (test-pinned). */
export const ACTIVE_THREAD_STATES: DelegationThreadState[] = [
  'pending_first_dispatch', 'dispatch_pending', 'awaiting_reply',
  'evaluating', 'awaiting_owner', 'followup_scheduled',
  'resolved_pending_owner', 'reopened', 'receipt_unknown',
];

/** Legal CAS transitions (from → to). Anything absent is illegal and
 *  must be rejected, never forced. 33a never reaches
 *  followup_scheduled (33b's state) — kept here so the table is the
 *  single source of truth for both phases. */
export const THREAD_TRANSITIONS: Record<string, DelegationThreadState[]> = {
  pending_first_dispatch: ['dispatch_pending', 'awaiting_reply', 'cancelled'],
  dispatch_pending: ['awaiting_reply', 'cancelled', 'receipt_unknown', /* restore-prior: */ 'pending_first_dispatch', 'evaluating', 'awaiting_owner', 'resolved_pending_owner', 'reopened'],
  awaiting_reply: ['evaluating', 'expired', 'dispatch_pending'],
  evaluating: ['resolved_pending_owner', 'awaiting_owner', 'awaiting_reply', 'dispatch_pending', 'expired'],
  awaiting_owner: ['awaiting_reply', 'closed', 'reopened', 'expired', 'dispatch_pending'],
  followup_scheduled: ['dispatch_pending', 'expired'],
  resolved_pending_owner: ['closed', 'reopened', 'expired'],
  reopened: ['awaiting_reply', 'dispatch_pending', 'expired'],
  receipt_unknown: ['evaluating', 'awaiting_reply', 'expired', 'cancelled', 'awaiting_owner'],
  closed: [], expired: [], cancelled: [],
};

// ── Canonical counterpart keys (NULL-safe uniqueness, REQ-002 §2) ────

export function canonicalWhatsAppNumber(raw: unknown): string | null {
  const digits = String(raw ?? '').replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  if (!/^\+?\d{7,15}$/.test(digits)) return null;
  return digits.startsWith('+') ? digits : `+${digits}`;
}

export function counterpartKeyFor(channel: DelegationChannel, destination: unknown): string | null {
  if (channel === 'whatsapp') {
    const canon = canonicalWhatsAppNumber(destination);
    return canon ? `wa:${canon}` : null;
  }
  const email = String(destination ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? `em:${email}` : null;
}

// ── Feature flags (numeric behaviorConfig 0/1; env kill wins) ────────

export async function isDelegationCaptureEnabled(clientNumber: string): Promise<boolean> {
  if (process.env.DELEGATION_CAPTURE_ENABLED === '0') return false; // global kill switch
  try {
    const { getBehaviorValue } = await import('../behaviorConfig');
    return (await getBehaviorValue('delegation.capture_enabled', { clientNumber })) === 1;
  } catch {
    return false; // fail closed: unknown spec / config error ⇒ capture off
  }
}

export async function isAutonomousOutboundEnabled(clientNumber: string): Promise<boolean> {
  if (process.env.DELEGATION_AUTONOMOUS_OUTBOUND_ENABLED === '0') return false;
  try {
    const { getBehaviorValue } = await import('../behaviorConfig');
    return (await getBehaviorValue('delegation.autonomous_outbound_enabled', { clientNumber })) === 1;
  } catch {
    return false;
  }
}

// ── Thread upsert (deterministic; no title/body inference) ──────────

export interface UpsertThreadInput {
  clientNumber: string;
  ownerUserId: number;
  openItemId: string;
  channel: DelegationChannel;
  destination: string;           // raw phone or email; canonicalized here
  counterpartEntityId?: string | null;
  origin: 'worker_send' | 'owner_confirmed';
}

/** Select the active thread for (tenant, item, counterpart, channel) or
 *  create one. Race-safe: a concurrent create loses on the partial
 *  unique and re-selects. Returns null when the destination cannot be
 *  canonicalized (fail closed — no guessing). */
export async function upsertActiveThread(input: UpsertThreadInput): Promise<{ id: string; state: string } | null> {
  const key = counterpartKeyFor(input.channel, input.destination);
  if (!key) return null;
  const canonNumber = input.channel === 'whatsapp' ? canonicalWhatsAppNumber(input.destination) : null;
  const canonEmail = input.channel === 'email' ? key.slice(3) : null;

  const selectActive = () => prisma.delegationThread.findFirst({
    where: {
      clientNumber: input.clientNumber, openItemId: input.openItemId,
      counterpartKey: key, channel: input.channel,
      state: { in: ACTIVE_THREAD_STATES },
    },
    select: { id: true, state: true },
  });

  const existing = await selectActive();
  if (existing) return existing;
  try {
    const created = await prisma.delegationThread.create({
      data: {
        clientNumber: input.clientNumber, ownerUserId: input.ownerUserId,
        openItemId: input.openItemId, channel: input.channel,
        counterpartKey: key,
        counterpartNumberCanonical: canonNumber,
        counterpartEmailCanonical: canonEmail,
        counterpartEntityId: input.counterpartEntityId ?? null,
        origin: input.origin,
        // Worker/owner sends both begin life awaiting their dispatch
        // outcome; the state advances only through registered intents.
        state: input.origin === 'owner_confirmed' ? 'pending_first_dispatch' : 'awaiting_reply',
      },
      select: { id: true, state: true },
    });
    return created;
  } catch (error: any) {
    if (String(error?.code) === 'P2002') return selectActive(); // lost the race — reuse winner
    throw error;
  }
}

// ── CAS transition, transactional with its event ─────────────────────

export interface ThreadEventInput {
  eventType: 'outbound_intent' | 'outbound_receipt' | 'inbound_received' | 'classification_recorded' | 'processing_error';
  direction?: 'inbound' | 'outbound';
  channel: DelegationChannel;
  senderIdentity?: string | null;
  providerMessageId?: string | null;
  inboundSourceId?: string | null;
  quotedProviderId?: string | null;
  emailMessageId?: string | null;
  inReplyTo?: string | null;
  receiptStatus?: 'accepted' | 'failed' | 'unknown' | null;
  sourceEventId?: string | null;
  classifierKey?: string | null;
  classification?: Record<string, unknown> | null;
  provenance: 'assistant_outbound' | 'external_delegatee_reply' | 'owner_activity' | 'system';
  priorState?: string | null;
  evidenceSourceType?: 'whatsapp_message' | 'feed_event' | null;
  evidenceSourceId?: string | null;
}

export interface TransitionResult {
  ok: boolean;
  reason?: 'cas_conflict' | 'duplicate_event' | 'illegal_transition' | 'thread_missing';
  eventId?: string;
}

/** Append an event and (optionally) CAS the thread state in one
 *  transaction. `expectedState` guards the CAS; a mismatch aborts with
 *  cas_conflict and no event is written. Duplicate inbound source ids
 *  return duplicate_event without mutation. */
export async function appendEventWithTransition(input: {
  clientNumber: string;
  threadId: string;
  event: ThreadEventInput;
  transition?: { expectedState: DelegationThreadState; toState: DelegationThreadState; setActiveIntentToEvent?: boolean; extraData?: Record<string, unknown> };
}): Promise<TransitionResult> {
  const { transition } = input;
  if (transition && !THREAD_TRANSITIONS[transition.expectedState]?.includes(transition.toState)) {
    return { ok: false, reason: 'illegal_transition' };
  }
  try {
    return await prisma.$transaction(async (tx: any) => {
      const event = await tx.delegationThreadEvent.create({
        data: {
          clientNumber: input.clientNumber, threadId: input.threadId,
          eventType: input.event.eventType, direction: input.event.direction ?? null,
          channel: input.event.channel, senderIdentity: input.event.senderIdentity ?? null,
          providerMessageId: input.event.providerMessageId ?? null,
          inboundSourceId: input.event.inboundSourceId ?? null,
          quotedProviderId: input.event.quotedProviderId ?? null,
          emailMessageId: input.event.emailMessageId ?? null,
          inReplyTo: input.event.inReplyTo ?? null,
          receiptStatus: input.event.receiptStatus ?? null,
          sourceEventId: input.event.sourceEventId ?? null,
          classifierKey: input.event.classifierKey ?? null,
          classification: (input.event.classification ?? undefined) as any,
          provenance: input.event.provenance,
          priorState: input.event.priorState ?? null,
          evidenceSourceType: input.event.evidenceSourceType ?? null,
          evidenceSourceId: input.event.evidenceSourceId ?? null,
        },
        select: { id: true },
      });
      if (transition) {
        const updated = await tx.delegationThread.updateMany({
          where: {
            id: input.threadId, clientNumber: input.clientNumber,
            state: transition.expectedState,
          },
          data: {
            state: transition.toState,
            priorState: transition.expectedState,
            ...(transition.setActiveIntentToEvent ? { activeIntentEventId: event.id } : {}),
            ...(transition.extraData ?? {}),
          },
        });
        if (updated.count !== 1) throw new CasConflict();
      }
      return { ok: true, eventId: event.id };
    });
  } catch (error: any) {
    if (error instanceof CasConflict) return { ok: false, reason: 'cas_conflict' };
    if (String(error?.code) === 'P2002') return { ok: false, reason: 'duplicate_event' };
    throw error;
  }
}

class CasConflict extends Error { constructor() { super('cas_conflict'); } }

// ── Outbound intent / receipt binding (Codex mandatory details 1-2) ──

export async function registerOutboundIntent(input: {
  clientNumber: string; threadId: string; channel: DelegationChannel;
  senderIdentity: string; expectedState: DelegationThreadState;
}): Promise<TransitionResult> {
  return appendEventWithTransition({
    clientNumber: input.clientNumber, threadId: input.threadId,
    event: {
      eventType: 'outbound_intent', direction: 'outbound', channel: input.channel,
      senderIdentity: input.senderIdentity, provenance: 'assistant_outbound',
      priorState: input.expectedState,
    },
    transition: { expectedState: input.expectedState, toState: 'dispatch_pending', setActiveIntentToEvent: true },
  });
}

/** Receipts transition the thread ONLY when they belong to its current
 *  dispatch (activeIntentEventId binding) — a stale receipt can never
 *  mutate a later dispatch. Late receipts after inbound evidence
 *  (state no longer dispatch_pending/receipt_unknown) are recorded as
 *  audit events with no transition. */
export async function registerOutboundReceipt(input: {
  clientNumber: string; threadId: string; channel: DelegationChannel;
  senderIdentity: string; intentEventId: string;
  status: 'accepted' | 'failed'; providerMessageId?: string | null;
}): Promise<TransitionResult & { transitioned?: boolean }> {
  const thread = await prisma.delegationThread.findFirst({
    where: { id: input.threadId, clientNumber: input.clientNumber },
    select: { state: true, activeIntentEventId: true, priorState: true, origin: true },
  });
  if (!thread) return { ok: false, reason: 'thread_missing' };

  const event: ThreadEventInput = {
    eventType: 'outbound_receipt', direction: 'outbound', channel: input.channel,
    senderIdentity: input.senderIdentity, receiptStatus: input.status,
    providerMessageId: input.providerMessageId ?? null,
    sourceEventId: input.intentEventId, provenance: 'assistant_outbound',
  };

  const belongsToCurrentDispatch = thread.activeIntentEventId === input.intentEventId;
  const inDispatchWindow = thread.state === 'dispatch_pending' || thread.state === 'receipt_unknown';

  if (!belongsToCurrentDispatch || !inDispatchWindow) {
    // Audit-only: late/stale receipt. No state movement (mandatory detail 2).
    const audit = await appendEventWithTransition({
      clientNumber: input.clientNumber, threadId: input.threadId, event,
    });
    return { ...audit, transitioned: false };
  }

  const priorOnIntent = await prisma.delegationThreadEvent.findFirst({
    where: { id: input.intentEventId, clientNumber: input.clientNumber },
    select: { priorState: true },
  });
  const priorState = (priorOnIntent?.priorState ?? null) as DelegationThreadState | null;
  // "Newly created for this dispatch" is judged from the ledger, not
  // the state name: no other event exists besides this very intent.
  const otherEvents = await prisma.delegationThreadEvent.count({
    where: { threadId: input.threadId, clientNumber: input.clientNumber, id: { not: input.intentEventId } },
  });
  const newlyCreated = otherEvents === 0;

  const toState: DelegationThreadState = input.status === 'accepted'
    ? 'awaiting_reply'
    : newlyCreated
      ? 'cancelled'
      : (priorState && THREAD_TRANSITIONS[thread.state]?.includes(priorState) ? priorState : 'awaiting_owner');

  const result = await appendEventWithTransition({
    clientNumber: input.clientNumber, threadId: input.threadId, event,
    transition: {
      expectedState: thread.state as DelegationThreadState, toState,
      extraData: { activeIntentEventId: null },
    },
  });
  return { ...result, transitioned: result.ok };
}

export async function getThread(clientNumber: string, threadId: string) {
  return prisma.delegationThread.findFirst({ where: { id: threadId, clientNumber } });
}
