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
  /**
   * DEF-129 — item fields to write in the SAME transaction as the status change
   * and the ledger row.
   *
   * Delegation used to write `delegateeName`/`delegateeEmail`/`delegateeId` in a
   * separate `openItem.update` BEFORE asking for the transition. When the
   * transition was then refused, those fields stayed behind: the item was not
   * DELEGATED but carried a delegatee, which reads as an assignment nobody made.
   *
   * Passing them here makes status, related fields and audit one atomic unit —
   * a refusal leaves the item exactly as it was.
   */
  itemData?: Record<string, unknown>;
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
      // DEF-127 — the audit ledger is user-owned. `userId` is read here and
      // passed to every history write, accepted and rejected alike. It comes
      // from the ITEM rather than from `ctx`, so it cannot be spoofed by a
      // caller and cannot be defaulted when a caller omits it.
      userId: true,
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
    await recordHistory(ctx, item.userId, openItemId, from, target, 'rejected', 'no-op self-transition');
    return { ok: false, from, to: target, error: 'cannot transition to the same status' };
  }

  const spec = findTransition(from, target);
  if (!spec) {
    await recordHistory(ctx, item.userId, openItemId, from, target, 'rejected', 'transition not in matrix');
    return { ok: false, from, to: target, error: `no valid transition from ${from} to ${target}` };
  }

  // Guard evaluation
  const failed: Guard[] = [];
  for (const g of spec.guards) {
    if (!checkGuard(g, item, ctx)) failed.push(g);
  }
  if (failed.length > 0) {
    await recordHistory(ctx, item.userId, openItemId, from, target, 'rejected', `guards failed: ${failed.join(',')}`);
    return { ok: false, from, to: target, error: `guards failed: ${failed.join(', ')}`, guardsFailed: failed };
  }

  if (spec.requiresApproval && !ctx.approvalId) {
    await recordHistory(ctx, item.userId, openItemId, from, target, 'rejected', 'approval required, none provided');
    return { ok: false, from, to: target, error: 'approval required', approvalRequired: true };
  }

  // Apply atomically: update status + append history row.
  const historyRow = await prisma.$transaction(async (tx) => {
    await tx.openItem.update({
      where: { id: openItemId },
      // ctx.itemData cannot override `status`: it is spread FIRST, so the
      // transition target always wins. A caller cannot smuggle a different
      // status past the matrix through this field.
      data: { ...(ctx.itemData ?? {}), status: target, updatedAt: new Date() } as any,
    });
    const h = await tx.itemStatusHistory.create({
      data: {
        clientNumber: ctx.clientNumber,
        userId: item.userId,
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
      // DEF-129 — the guard asks whether the item WILL have a delegatee once
      // this transition is applied, so a delegatee arriving with the transition
      // itself satisfies it. Before `itemData` existed the caller had to write
      // the fields first, which is exactly what left them behind on a refusal.
      return !!(item.delegateeId ?? item.delegateeEmail
        ?? (ctx.itemData?.delegateeId as unknown) ?? (ctx.itemData?.delegateeEmail as unknown));
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
  userId: number,
  openItemId: string,
  from: ItemStatus,
  to: ItemStatus,
  outcome: 'accepted' | 'rejected',
  reason: string,
): Promise<void> {
  try {
    await prisma.itemStatusHistory.create({
      data: {
        clientNumber: ctx.clientNumber,
        userId,
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
