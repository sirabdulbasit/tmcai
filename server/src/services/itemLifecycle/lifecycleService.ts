import prisma from '../../db/prisma';
import { publish } from '../infra/pubsubPublisher';
import { PUBSUB_TOPICS } from '../../config/pubsub';
import {
  findTransition,
  isValidStatus,
  ItemStatus,
  Guard,
  TransitionSpec,
} from './transitionMatrix';

export interface TransitionContext {
  clientNumber: string;
  actor: string; // user:<id> | agent:<name> | system
  reason?: string;
  approvalId?: number;
  snoozeUntil?: Date;
  traceId?: string;
  metadata?: Record<string, unknown>;
  /** skip external publish (used by bulk backfills) */
  skipPublish?: boolean;
}

export interface TransitionResult {
  ok: boolean;
  from: ItemStatus;
  to: ItemStatus;
  historyId?: number;
  error?: string;
  guardsFailed?: Guard[];
  approvalRequired?: boolean;
}

/**
 * HaseebOS v15 L2 — canonical entry point for all OpenItem status changes.
 *
 * Every caller (UI, agent handlers, reflection, snooze cron) must go through
 * this function. Direct writes to `open_items.status` bypass guards, history,
 * and the open-item-events publish, and are considered a bug.
 */
export async function transitionStatus(
  openItemId: string,
  target: ItemStatus,
  ctx: TransitionContext,
): Promise<TransitionResult> {
  if (!isValidStatus(target)) {
    return { ok: false, from: 'NEW', to: target, error: `invalid target status "${target}"` };
  }

  const item = await prisma.openItem.findFirst({
    where: { id: openItemId, clientNumber: ctx.clientNumber },
    select: {
      id: true,
      status: true,
      delegateeId: true,
      delegateeEmail: true,
      ownerId: true,
      entityId: true,
      priority: true,
      title: true,
    },
  });
  if (!item) {
    return { ok: false, from: 'NEW', to: target, error: `open item ${openItemId} not found` };
  }

  const from = (item.status as ItemStatus) ?? 'NEW';
  if (!isValidStatus(from)) {
    return { ok: false, from: from as ItemStatus, to: target, error: `current status "${from}" is not in the v15 lifecycle — migrate first` };
  }
  if (from === target) {
    // No-op transition — record as rejected so we see churn in the audit trail.
    await recordHistory(ctx, openItemId, from, target, 'rejected', 'no-op self-transition');
    return { ok: false, from, to: target, error: 'cannot transition to the same status' };
  }

  const spec = findTransition(from, target);
  if (!spec) {
    await recordHistory(ctx, openItemId, from, target, 'rejected', 'transition not in matrix');
    return { ok: false, from, to: target, error: `no valid transition from ${from} to ${target}` };
  }

  // Guard evaluation
  const failed: Guard[] = [];
  for (const g of spec.guards) {
    if (!checkGuard(g, item, ctx)) failed.push(g);
  }
  if (failed.length > 0) {
    await recordHistory(ctx, openItemId, from, target, 'rejected', `guards failed: ${failed.join(',')}`);
    return { ok: false, from, to: target, error: `guards failed: ${failed.join(', ')}`, guardsFailed: failed };
  }

  if (spec.requiresApproval && !ctx.approvalId) {
    await recordHistory(ctx, openItemId, from, target, 'rejected', 'approval required, none provided');
    return { ok: false, from, to: target, error: 'approval required', approvalRequired: true };
  }

  // Apply atomically: update status + append history row.
  const historyRow = await prisma.$transaction(async (tx) => {
    await tx.openItem.update({
      where: { id: openItemId },
      data: { status: target, updatedAt: new Date() },
    });
    const h = await (tx as any).itemStatusHistory.create({
      data: {
        clientNumber: ctx.clientNumber,
        openItemId,
        fromStatus: from,
        toStatus: target,
        outcome: 'accepted',
        reason: ctx.reason,
        actor: ctx.actor,
        traceId: ctx.traceId,
        metadata: ctx.metadata as any,
      },
      select: { id: true },
    });
    return h;
  });

  if (!ctx.skipPublish) {
    void publishOpenItemEvent(item, from, target, spec, ctx);
  }

  return { ok: true, from, to: target, historyId: historyRow.id };
}

function checkGuard(g: Guard, item: any, ctx: TransitionContext): boolean {
  switch (g) {
    case 'delegatee_set':
      return !!(item.delegateeId ?? item.delegateeEmail);
    case 'approval_id':
      return !!ctx.approvalId;
    case 'resolution_reason':
      return !!ctx.reason && ctx.reason.trim().length > 0;
    case 'is_owner_or_agent':
      return ctx.actor === `user:${item.ownerId}` || ctx.actor.startsWith('agent:') || ctx.actor === 'system';
    case 'snooze_until_set':
      return !!ctx.snoozeUntil;
    default:
      return false;
  }
}

async function recordHistory(
  ctx: TransitionContext,
  openItemId: string,
  from: ItemStatus,
  to: ItemStatus,
  outcome: 'accepted' | 'rejected',
  reason: string,
): Promise<void> {
  try {
    await (prisma as any).itemStatusHistory.create({
      data: {
        clientNumber: ctx.clientNumber,
        openItemId,
        fromStatus: from,
        toStatus: to,
        outcome,
        reason,
        actor: ctx.actor,
        traceId: ctx.traceId,
        metadata: ctx.metadata as any,
      },
    });
  } catch {
    /* swallow — audit table must not block the request */
  }
}

async function publishOpenItemEvent(
  item: any,
  from: ItemStatus,
  to: ItemStatus,
  spec: TransitionSpec,
  ctx: TransitionContext,
): Promise<void> {
  try {
    const orderingKey = `${ctx.clientNumber}:openitem:${item.id}`;
    await publish(
      PUBSUB_TOPICS.OPEN_ITEM_EVENTS,
      {
        openItemId: item.id,
        clientNumber: ctx.clientNumber,
        userId: item.ownerId,
        fromStatus: from,
        toStatus: to,
        transitionDescription: spec.description,
        actor: ctx.actor,
        reason: ctx.reason,
        approvalId: ctx.approvalId,
        title: item.title,
        priority: item.priority,
        entityId: item.entityId,
        occurredAt: new Date().toISOString(),
      },
      {
        tenantId: ctx.clientNumber,
        traceId: ctx.traceId,
        orderingKey,
        attributes: {
          fromStatus: from,
          toStatus: to,
          actor: ctx.actor,
        },
      },
    );
  } catch (err: any) {
    console.warn(`[lifecycleService] open-item-events publish failed ${item.id}: ${err.message}`);
  }
}
