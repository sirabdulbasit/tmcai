/**
 * Section 33a — delegation thread recovery + expiry.
 *
 * Owns exactly two CAS transitions (inbound handlers never retry
 * transitions; this job never resends anything):
 *   1. dispatch_pending past the receipt-recovery window →
 *      receipt_unknown (non-sendable; still correlation-active) +
 *      processing event + deduped owner notice + system log.
 *   2. Any active thread idle past the thread TTL → expired
 *      (marked, never deleted).
 *
 * Runs under the central governor via protectedTick (lease + ledger).
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';
import {
  ACTIVE_THREAD_STATES, appendEventWithTransition, DelegationThreadState,
} from '../services/delegation/delegationThreadService';

const log = createLogger('delegation-recovery');

export async function runDelegationRecoverySweep(now = new Date()): Promise<{ markedUnknown: number; expired: number }> {
  const { getBehaviorValue } = await import('../services/behaviorConfig');
  let markedUnknown = 0;
  let expired = 0;

  // 1 — receipt recovery (per tenant window; small scan, bounded take)
  const pending = await prisma.delegationThread.findMany({
    where: { state: 'dispatch_pending' },
    select: { id: true, clientNumber: true, ownerUserId: true, openItemId: true, channel: true, updatedAt: true },
    take: 200,
  });
  for (const thread of pending) {
    const windowMin = await getBehaviorValue('delegation.receipt_recovery_window_min', { clientNumber: thread.clientNumber }).catch(() => 30);
    if (now.getTime() - thread.updatedAt.getTime() < windowMin * 60_000) continue;
    const marked = await appendEventWithTransition({
      clientNumber: thread.clientNumber, threadId: thread.id,
      event: {
        eventType: 'processing_error', channel: thread.channel as any,
        provenance: 'system',
        classification: { error: 'receipt_unknown', detail: 'no transport receipt within recovery window; never resent' },
      },
      transition: { expectedState: 'dispatch_pending', toState: 'receipt_unknown', extraData: { activeIntentEventId: null } },
    });
    if (marked.ok) {
      markedUnknown += 1;
      const { enqueueBrainPrompt } = await import('../services/brainPrompts/brainPromptQueueService');
      await enqueueBrainPrompt({
        userId: thread.ownerUserId, clientNumber: thread.clientNumber,
        question: 'A tracked message to a responsible person has no delivery receipt. I will not resend it automatically — please check whether it arrived or tell me how to proceed.',
        openItemId: thread.openItemId,
        sideEffect: { kind: 'action_status_update', openItemId: thread.openItemId },
        criticality: 'routine',
        dedupKey: `delegation:${thread.id}:receipt_unknown`,
        metadata: { source: 'delegation_recovery', threadId: thread.id },
      }).catch((e: any) => log.warn('receipt_unknown owner notice failed', { error: e.message }));
    }
  }

  // 2 — TTL expiry (marked, kept)
  const stale = await prisma.delegationThread.findMany({
    where: { state: { in: ACTIVE_THREAD_STATES.filter((s) => s !== 'dispatch_pending') } },
    select: { id: true, clientNumber: true, channel: true, state: true, updatedAt: true },
    take: 500,
  });
  for (const thread of stale) {
    const ttlDays = await getBehaviorValue('delegation.thread_ttl_days', { clientNumber: thread.clientNumber }).catch(() => 30);
    if (now.getTime() - thread.updatedAt.getTime() < ttlDays * 24 * 60 * 60_000) continue;
    const marked = await appendEventWithTransition({
      clientNumber: thread.clientNumber, threadId: thread.id,
      event: {
        eventType: 'processing_error', channel: thread.channel as any,
        provenance: 'system',
        classification: { error: 'thread_expired', detail: `idle beyond ${ttlDays}d TTL` },
      },
      transition: {
        expectedState: thread.state as DelegationThreadState, toState: 'expired',
        extraData: { expiresAt: now },
      },
    });
    if (marked.ok) expired += 1;
  }

  if (markedUnknown || expired) log.info('delegation recovery sweep', { markedUnknown, expired });
  return { markedUnknown, expired };
}
