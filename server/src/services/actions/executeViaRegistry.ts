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
  /** Brain's self-assessed confidence in this action (0.0–1.0). If below the
   *  user's per-channel threshold, the action is held as a DRAFT for MD review
   *  instead of being executed. Absent = treat as 1.0 (full confidence). */
  confidence?: number;
  /** D1 (2026-07-08): who initiated this action. 'user' = a user-initiated
   *  chain (clicked approve, gave a voice/chat instruction, configured a
   *  standing rule) — never gated. 'brain' = Brain acting on its own
   *  judgment (proactive outreach, self-directed actions) — gated by the
   *  user's automationLevel in the executor. Defaults to 'user' so existing
   *  user-driven call sites keep working; every NEW brain-discretionary
   *  caller MUST pass 'brain'. */
  initiator?: 'user' | 'brain';
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

  // Per-tenant kill switch — enforce at the action-handler boundary so
  // that backend paths (cron, brain engine, autonomous executor) are
  // also blocked, not just HTTP mutating routes. The middleware catches
  // user-initiated POSTs; this catches the autonomous fallout. We hold
  // as a DRAFT (status='blocked_by_kill_switch') instead of throwing so
  // the user can review what would have happened once the switch
  // releases. Read-only and undo handlers are not blocked here — undo
  // routes through executeViaRegistry only via explicit human action.
  try {
    const { isActive } = await import('../safety/killSwitchService');
    const blocked = await isActive(input.clientNumber);
    if (blocked) {
      const heldDraft = await prisma.agentAction.create({
        data: {
          clientNumber: input.clientNumber,
          userId: input.userId,
          actionType: input.actionType,
          status: 'blocked_by_kill_switch',
          input: input.payload as any,
          output: {
            reason: 'Kill switch is engaged for this tenant. Action withheld; release the kill switch to retry.',
            actionType: input.actionType,
            withheldAt: new Date().toISOString(),
          } as any,
          riskTier: await handler.riskLevel({
            clientNumber: input.clientNumber, userId: input.userId,
            traceId, dependencyGraphId: graphId,
            payload: input.payload,
          } as HandlerContext),
          dependencyGraphId: graphId,
          executedByAgent: input.executedByAgent,
          requiresApproval: true,
        } as any,
        select: { id: true },
      });
      return {
        ok: false,
        actionId: heldDraft.id,
        handlerName: input.actionType,
        error: 'kill_switch_active',
        dependencyGraphId: graphId,
        traceId,
      };
    }
  } catch (err: any) {
    // Failing OPEN here matches the HTTP middleware's behaviour — kill
    // switch is a safety net, not a critical-path dependency. Logged
    // for visibility, then we proceed normally.
    console.error(`[executeViaRegistry] kill switch check failed, proceeding: ${err.message}`);
  }

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

  // D1 (2026-07-08): automation-level gate — deterministic, in the executor,
  // BEFORE any dispatch. Brain-initiated actions are held per the user's
  // automationLevel (observe_only → proposed; drafts_only → draft;
  // supervised → pending_approval); user-initiated chains pass through.
  // This is structural enforcement, not a prompt instruction.
  if ((input.initiator ?? 'user') === 'brain') {
    const { resolveAutonomyGate } = await import('./autonomyGate');
    const { getAutomationLevel } = await import('../brainConfigService');
    const level = await getAutomationLevel(input.userId);
    const decision = resolveAutonomyGate('brain', level);
    if (decision !== 'execute') {
      const held = await prisma.agentAction.create({
        data: {
          clientNumber: input.clientNumber,
          userId: input.userId,
          actionType: input.actionType,
          status: decision, // proposed | draft | pending_approval
          input: input.payload as any,
          output: {
            heldBy: 'automation_level',
            level,
            reason: `Brain-initiated action held: your automation level is "${level}"`,
          } as any,
          riskTier,
          dependencyGraphId: graphId,
          executedByAgent: input.executedByAgent,
          requiresApproval: decision !== 'proposed',
        } as any,
        select: { id: true },
      });
      return {
        ok: true,
        actionId: held.id,
        handlerName: input.actionType,
        output: { status: decision, heldBy: 'automation_level', level },
        dependencyGraphId: graphId,
        traceId,
      } as any;
    }
  }

  // Confidence-gated draft mode: if the Brain provided a confidence score and
  // it falls below the user's per-channel threshold, hold as DRAFT for MD
  // review instead of executing. Surfaced on Day Brief.
  if (typeof input.confidence === 'number' && input.confidence < 1) {
    const channel = inferChannel(input.actionType);
    const threshold = await getUserChannelThreshold(input.clientNumber, input.userId, channel);
    if (input.confidence < threshold) {
      const draft = await prisma.agentAction.create({
        data: {
          clientNumber: input.clientNumber,
          userId: input.userId,
          actionType: input.actionType,
          status: 'draft',
          input: input.payload as any,
          output: {
            confidence: input.confidence,
            channel,
            threshold,
            reason: `Brain confidence ${Math.round(input.confidence * 100)}% below your ${channel} threshold ${Math.round(threshold * 100)}%`,
          } as any,
          riskTier,
          dependencyGraphId: graphId,
          executedByAgent: input.executedByAgent,
          requiresApproval: true,
        } as any,
        select: { id: true },
      });
      return {
        ok: true,
        actionId: draft.id,
        handlerName: input.actionType,
        output: { status: 'draft', confidence: input.confidence, threshold },
        dependencyGraphId: graphId,
        traceId,
      } as any;
    }
  }

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

  // B4 (2026-07-09): stamp the idempotency key into the row's input JSON so
  // the reconciler can join a stuck-'executing' row back to the confirmed
  // outcome in action_idempotency_log (the log write happens BEFORE the
  // status write, so it survives a crash between provider ack and DB
  // update). Stored in JSON, not the unique idempotencyKey column — a
  // legitimate retry creates a second row with the same key and the unique
  // constraint would reject it.
  const idemParams = {
    actionType: idempotencyType,
    clientNumber: input.clientNumber,
    userId: input.userId,
    referenceId: input.openItemId ?? `action:${actionRow.id}`,
    disambiguator: input.disambiguator ?? input.actionType,
  };
  try {
    const { generateKey } = await import('../actionIdempotencyService');
    await prisma.agentAction.update({
      where: { id: actionRow.id },
      data: { input: { ...(input.payload as any), _idempotencyKey: generateKey(idemParams) } as any },
    });
  } catch (err: any) {
    console.warn(`[executeViaRegistry] could not stamp idempotency key on row ${actionRow.id}: ${err.message}`);
  }

  try {
    const result = await withIdempotency(
      idemParams,
      async (): Promise<ExecutionOutput> => {
        await handler.prepare(ctx);
        const out = await handler.execute(ctx);
        if (out.ok) {
          // B2: fail closed — a handler that somehow lacks confirm()
          // (JS-level gap the abstract base can't catch at runtime) is
          // UNCONFIRMED, never implicitly successful.
          if (typeof handler.confirm !== 'function') {
            throw new Error(`handler "${input.actionType}" has no confirm() — action cannot be verified`);
          }
          const confirmed = await handler.confirm(ctx, out.output);
          if (!confirmed) throw new Error(`confirm() returned false for handler "${input.actionType}"`);
        }
        return out;
      },
      {
        // B3: a cache hit must be re-verified against the system of record
        // (the handler's own confirm()) before we claim "already done" —
        // and failed outcomes are never cached, so a transient failure
        // can't block retries for the TTL window.
        reconfirm: async (cached) =>
          cached?.ok === true && typeof handler.confirm === 'function'
            ? handler.confirm(ctx, cached.output).catch(() => false)
            : false,
        shouldCache: (r) => r?.ok === true,
      },
    );

    // B4: this write is non-fatal. The confirmed outcome is already durable
    // in action_idempotency_log; if this update fails the reconciler
    // (reconcileStuckExecuting) resolves the row from the log — throwing
    // here would misreport a confirmed action as failed to the caller.
    try {
      await prisma.agentAction.update({
        where: { id: actionRow.id },
        data: {
          status: result.ok ? 'done' : 'error',
          output: (result.output ?? null) as any,
          error: result.error,
          undoStatus: result.ok ? 'undoable' : 'none',
        },
      });
    } catch (err: any) {
      console.error(`[executeViaRegistry] status write failed for action ${actionRow.id} — reconciler will recover from idempotency log: ${err.message}`);
    }

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

/**
 * Map an action type to the logical channel used by the per-channel autonomy
 * thresholds stored in users.notification_preferences.brain_channel_thresholds.
 */
function inferChannel(actionType: string): 'email' | 'whatsapp' | 'delegation' | 'calendar' {
  if (actionType.includes('whatsapp')) return 'whatsapp';
  if (actionType.includes('email')) return 'email';
  if (actionType.includes('event') || actionType.includes('schedule') || actionType.includes('attendee')) return 'calendar';
  if (actionType.includes('delegate') || actionType.includes('reassign')) return 'delegation';
  return 'email'; // reasonable default
}

/**
 * Read the user's per-channel confidence threshold from their notification_preferences JSON.
 * Falls back to conservative defaults if unset.
 */
async function getUserChannelThreshold(
  clientNumber: string,
  userId: number,
  channel: 'email' | 'whatsapp' | 'delegation' | 'calendar',
): Promise<number> {
  const DEFAULTS = { email: 0.88, whatsapp: 0.92, delegation: 0.75, calendar: 0.82 } as const;
  try {
    const u = await prisma.user.findFirst({
      where: { id: userId, clientNumber },
      select: { notificationPreferences: true },
    });
    const prefs = (u?.notificationPreferences as any) ?? {};
    const t = prefs.brain_channel_thresholds?.[channel];
    if (typeof t === 'number' && t >= 0 && t <= 1) return t;
  } catch { /* ignore */ }
  return DEFAULTS[channel];
}
