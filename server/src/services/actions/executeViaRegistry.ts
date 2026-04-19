import prisma from '../../db/prisma';
import { requireHandler, has } from './handlerRegistry';
import type { HandlerContext, ExecutionOutput } from './handlerBase';
import { withIdempotency, type ActionType as IdempotencyActionType } from '../actionIdempotencyService';
import { newGraphId, addEdge } from './dependencyGraphService';
import { publish } from '../infra/pubsubPublisher';
import { PUBSUB_TOPICS } from '../../config/pubsub';
import crypto from 'crypto';

export interface RegistryExecutionInput {
  actionType: string;
  clientNumber: string;
  userId: number;
  openItemId?: string;
  entityId?: string;
  payload: Record<string, unknown>;
  traceId?: string;
  executedByAgent?: string;
  /** group multiple related actions under one dependency graph */
  dependencyGraphId?: string;
  /** pass through a pre-existing AgentAction.id if the caller has already persisted one */
  existingActionId?: number;
  /** idempotency disambiguator */
  disambiguator?: string;
}

export interface RegistryExecutionResult {
  ok: boolean;
  actionId: number;
  handlerName: string;
  output?: unknown;
  error?: string;
  dependencyGraphId: string;
  traceId: string;
}

/**
 * Execute an approved action through the handler registry.
 * Single source of truth for validate → execute → confirm → persist.
 * Wraps in the existing idempotency layer (Redis SETNX + SQL audit).
 */
export async function executeViaRegistry(input: RegistryExecutionInput): Promise<RegistryExecutionResult> {
  if (!has(input.actionType)) {
    throw new Error(`no handler registered for action "${input.actionType}"`);
  }
  const handler = requireHandler(input.actionType);
  const traceId = input.traceId ?? crypto.randomUUID();
  const graphId = input.dependencyGraphId ?? newGraphId(traceId);

  // Resolve rootActionId *after* we know whether we're reusing an existing AgentAction row
  const ctx: HandlerContext = {
    clientNumber: input.clientNumber,
    userId: input.userId,
    openItemId: input.openItemId,
    entityId: input.entityId,
    traceId,
    executedByAgent: input.executedByAgent,
    dependencyGraphId: graphId,
    payload: input.payload,
  };

  const validation = await handler.validate(ctx);
  if (!validation.valid) {
    throw new Error(`validation failed: ${(validation.errors ?? []).join('; ')}`);
  }

  const riskTier = await handler.riskLevel(ctx);

  // Persist AgentAction upfront so downstream can reference it even if execute throws
  let actionRow: { id: number };
  let linkedParentId: number | null = null;
  if (input.existingActionId) {
    actionRow = { id: input.existingActionId };
    // If the existing action was created by an orchestration handler (e.g. wait_for_approval),
    // it may have stashed `_parentActionId` in its input JSON. Read and link.
    try {
      const existing = await prisma.agentAction.findFirst({
        where: { id: input.existingActionId, clientNumber: input.clientNumber },
        select: { input: true, dependencyGraphId: true },
      });
      const inputJson = (existing?.input as Record<string, unknown> | null) ?? {};
      const parentId = typeof inputJson._parentActionId === 'number' ? inputJson._parentActionId : null;
      if (parentId !== null) linkedParentId = parentId;
    } catch {
      /* best effort */
    }
    await prisma.agentAction.update({
      where: { id: actionRow.id },
      data: { status: 'executing', dependencyGraphId: graphId, executedByAgent: input.executedByAgent },
    });
  } else {
    actionRow = await prisma.agentAction.create({
      data: {
        clientNumber: input.clientNumber,
        userId: input.userId,
        actionType: input.actionType,
        status: 'executing',
        input: input.payload as any,
        riskTier,
        dependencyGraphId: graphId,
        executedByAgent: input.executedByAgent,
        requiresApproval: false,
      },
      select: { id: true },
    });
  }

  // Record dependency edge back to parent if one was declared
  if (linkedParentId !== null) {
    try {
      await addEdge({
        clientNumber: input.clientNumber,
        parentActionId: linkedParentId,
        childActionId: actionRow.id,
        dependencyType: 'triggers',
      });
    } catch (err: any) {
      console.warn(`[executeViaRegistry] failed to record parent edge ${linkedParentId} → ${actionRow.id}: ${err.message}`);
    }
  }

  ctx.rootActionId = actionRow.id;

  const idempotencyType: IdempotencyActionType = coerceIdempotencyType(input.actionType);

  try {
    const result = await withIdempotency(
      {
        actionType: idempotencyType,
        clientNumber: input.clientNumber,
        userId: input.userId,
        referenceId: input.openItemId ?? `action:${actionRow.id}`,
        disambiguator: input.disambiguator ?? input.actionType,
      },
      async (): Promise<ExecutionOutput> => {
        await handler.prepare(ctx);
        const out = await handler.execute(ctx);
        if (out.ok) {
          const confirmed = await handler.confirm(ctx, out.output);
          if (!confirmed) throw new Error(`confirm() returned false for handler "${input.actionType}"`);
        }
        return out;
      },
    );

    await prisma.agentAction.update({
      where: { id: actionRow.id },
      data: {
        status: result.ok ? 'done' : 'error',
        output: (result.output ?? null) as any,
        error: result.error,
        undoStatus: result.ok ? 'undoable' : 'none',
      },
    });

    // L3.4 — publish outcome on action-executed-events for Brain observability
    // and Reflection's training feed. Best-effort: failure to publish does not
    // roll back the successful execute.
    await publishActionExecuted(input, actionRow.id, riskTier, graphId, traceId, result.ok, result.output, result.error);

    return {
      ok: result.ok,
      actionId: actionRow.id,
      handlerName: input.actionType,
      output: result.output,
      error: result.error,
      dependencyGraphId: graphId,
      traceId,
    };
  } catch (err: any) {
    await prisma.agentAction.update({
      where: { id: actionRow.id },
      data: { status: 'error', error: err.message, undoStatus: 'none' },
    });
    await publishActionExecuted(input, actionRow.id, riskTier, graphId, traceId, false, undefined, err.message);
    throw err;
  }
}

async function publishActionExecuted(
  input: RegistryExecutionInput,
  actionId: number,
  riskTier: string,
  graphId: string,
  traceId: string,
  ok: boolean,
  output: unknown,
  error: string | undefined,
): Promise<void> {
  try {
    const orderingKey = `${input.clientNumber}:action:${actionId}`;
    await publish(
      PUBSUB_TOPICS.ACTION_EXECUTED_EVENTS,
      {
        actionId,
        actionType: input.actionType,
        clientNumber: input.clientNumber,
        userId: input.userId,
        openItemId: input.openItemId,
        entityId: input.entityId,
        riskTier,
        ok,
        output,
        error,
        dependencyGraphId: graphId,
        executedByAgent: input.executedByAgent,
        executedAt: new Date().toISOString(),
      },
      {
        tenantId: input.clientNumber,
        traceId,
        orderingKey,
        attributes: {
          actionType: input.actionType,
          riskTier: riskTier as any,
          outcome: ok ? 'done' : 'error',
        },
      },
    );
  } catch (err: any) {
    console.warn(`[executeViaRegistry] action-executed publish failed actionId=${actionId}: ${err.message}`);
  }
}

function coerceIdempotencyType(actionType: string): IdempotencyActionType {
  if (actionType.includes('reply')) return 'REPLY';
  if (actionType === 'send_email' || actionType === 'forward_email' || actionType.startsWith('send_')) return 'DELEGATE_MSG';
  if (actionType.includes('delegate') || actionType.includes('reassign')) return 'DELEGATE';
  if (actionType.includes('event') || actionType.includes('schedule') || actionType.includes('attendee')) return 'SCHEDULE';
  if (actionType.includes('odoo') || actionType === 'erp') return 'ERP';
  if (actionType.includes('okr')) return 'OKR_ALERT';
  return 'CLOSE';
}
