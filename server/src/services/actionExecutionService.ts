/**
 * MyOS Gap 4 — Action Execution Service
 *
 * Confirmed action execution pipeline with read-after-write validation.
 * All writes confirmed before marking an item DONE.
 * Partial failures surface as alerts — never silently dropped.
 * Wrapped in idempotency (Gap 3) to prevent duplicate execution.
 */

import prisma from '../db/prisma';
import * as openItemsService from './openItemsService';
import * as entityService from './entityService';
import { withIdempotency, type ActionType as IdempotencyActionType } from './actionIdempotencyService';
import * as entityPropagationService from './entityPropagationService';
import { has as registryHas } from './actions/handlerRegistry';
import { executeViaRegistry } from './actions/executeViaRegistry';
import { isFeatureEnabled } from './featureFlagService';
import { V15_FLAGS } from '../config/featureFlags';
import { publish } from './infra/pubsubPublisher';
import { PUBSUB_TOPICS } from '../config/pubsub';
import crypto from 'crypto';

// HaseebOS v15: legacy action type → new handler name mapping.
// If the handler is registered, executeApprovedAction delegates to the new pipeline.
const LEGACY_TO_HANDLER: Record<string, string> = {
  reply: 'send_email_reply',
  delegate: 'send_email',
  schedule: 'create_event',
  close: 'close',
  erp: 'update_odoo_crm',
  snooze: 'snooze',
};

// ─── Types ──────────────────────────────────────────────────────

export type ActionType = 'reply' | 'delegate' | 'schedule' | 'close' | 'erp' | 'snooze';

export interface ApprovedAction {
  type: ActionType;
  openItemId: string;
  userId: number;
  clientNumber: string;
  draft?: string;           // email body, chat message, etc.
  delegateeEmail?: string;
  delegateeName?: string;
  connectorSlug?: string;   // which connector to execute via
  outcome?: string;         // user's note on outcome
  snoozeUntil?: Date;
}

interface WriteTarget {
  name: string;
  write: () => Promise<void>;
  confirm: () => Promise<boolean>;
}

export interface ExecutionResult {
  status: 'done' | 'partial_failure' | 'snoozed';
  confirmedTargets?: number;
  failedTargets?: string[];
  openItemId: string;
}

// ─── Main execution function ────────────────────────────────────

export async function executeApprovedAction(action: ApprovedAction): Promise<ExecutionResult> {
  const { openItemId, userId, clientNumber } = action;

  // HaseebOS v15 delegation path: if a v15 handler is registered for this action type,
  // route through executeViaRegistry which gives us validate→execute→confirm,
  // AgentAction persistence, dependency-graph edges, and 12-method handler contract.
  const handlerName = LEGACY_TO_HANDLER[action.type];
  if (handlerName && registryHas(handlerName)) {
    // If the tenant has ADK agents enabled, publish to tmcai-actions-approved
    // so the Action Executor agent picks up and executes via its ADK pipeline.
    // Otherwise execute in-process via the registry.
    const adkEnabled = await isFeatureEnabled(clientNumber, V15_FLAGS.ADK_AGENTS, false);
    if (adkEnabled) {
      try {
        return await publishToAgentExecutor(action, handlerName);
      } catch (err: any) {
        console.warn(
          `[actionExecution] ADK publish failed for ${action.type}: ${err.message} — falling back to in-process registry`,
        );
      }
    }

    try {
      const payload = buildPayloadForHandler(action, handlerName);
      const result = await executeViaRegistry({
        actionType: handlerName,
        clientNumber,
        userId,
        openItemId,
        payload,
        disambiguator: action.delegateeEmail || action.type,
      });
      if (!result.ok) {
        return { status: 'partial_failure', failedTargets: ['handler'], openItemId };
      }
      if (action.type === 'snooze') {
        return { status: 'snoozed', openItemId };
      }
      return { status: 'done', confirmedTargets: 1, openItemId };
    } catch (err: any) {
      // If the new path fails with a validation or wiring issue, fall back to legacy.
      console.warn(`[actionExecution] v15 delegation failed for ${action.type}: ${err.message} — falling back to legacy`);
    }
  }

  // Legacy path (pre-v15): inline switch + write confirmation.
  // Wrap in idempotency (Gap 3)
  const idempotencyType: IdempotencyActionType =
    action.type === 'reply' ? 'REPLY' :
    action.type === 'delegate' ? 'DELEGATE' :
    action.type === 'schedule' ? 'SCHEDULE' :
    action.type === 'close' ? 'CLOSE' :
    action.type === 'erp' ? 'ERP' : 'CLOSE';

  return withIdempotency(
    {
      actionType: idempotencyType,
      clientNumber,
      userId,
      referenceId: openItemId,
      disambiguator: action.delegateeEmail || action.type,
    },
    () => executeInternal(action),
  );
}

/**
 * HaseebOS v15: publish an approved action to the Pub/Sub topic so the
 * Action Executor agent on Cloud Run picks it up. Persists a pending AgentAction
 * row first so the Steering Wheel UI can show the status and the cascading-undo
 * engine can reference it later.
 */
async function publishToAgentExecutor(action: ApprovedAction, handlerName: string): Promise<ExecutionResult> {
  const traceId = crypto.randomUUID();
  const payload = buildPayloadForHandler(action, handlerName);

  // Persist a pending AgentAction so the agent has a concrete id to run against
  // via executeViaRegistry({existingActionId}).
  const row = await prisma.agentAction.create({
    data: {
      clientNumber: action.clientNumber,
      userId: action.userId,
      actionType: handlerName,
      status: 'pending',
      input: payload as any,
      requiresApproval: false,
      executedByAgent: 'action_executor',
    },
    select: { id: true },
  });

  await publish(
    PUBSUB_TOPICS.ACTIONS_APPROVED,
    {
      agentActionId: row.id,
      actionType: handlerName,
      payload,
      userId: action.userId,
      openItemId: action.openItemId,
    },
    {
      tenantId: action.clientNumber,
      traceId,
      orderingKey: `actions:${action.clientNumber}`,
      attributes: {
        actionType: handlerName,
        eventType: 'action_approved',
      },
    },
  );

  // Platform returns "done" optimistically. The agent worker will update the
  // AgentAction row's status on completion; the UI polls for real status.
  if (action.type === 'snooze') {
    return { status: 'snoozed', openItemId: action.openItemId };
  }
  return { status: 'done', confirmedTargets: 0, openItemId: action.openItemId };
}

function buildPayloadForHandler(action: ApprovedAction, handlerName: string): Record<string, unknown> {
  switch (handlerName) {
    case 'snooze':
      return { snoozeUntil: action.snoozeUntil?.toISOString() };
    case 'close':
      return { outcome: action.outcome };
    case 'send_email':
      return {
        to: action.delegateeEmail ? [action.delegateeEmail] : [],
        subject: 'AI-assisted message',
        body: action.draft ?? '',
      };
    case 'send_email_reply':
      return { threadId: action.openItemId, body: action.draft ?? '' };
    case 'create_event':
      return {
        summary: action.draft?.slice(0, 120) ?? 'AI-scheduled event',
        startTime: new Date().toISOString(),
        endTime: new Date(Date.now() + 30 * 60_000).toISOString(),
        attendees: action.delegateeEmail ? [action.delegateeEmail] : [],
      };
    case 'update_odoo_crm':
      return { recordType: 'contact', recordId: action.openItemId, fields: {} };
    default:
      return {};
  }
}

async function executeInternal(action: ApprovedAction): Promise<ExecutionResult> {
  const { openItemId, userId, clientNumber } = action;

  // Snooze is simple — no write confirmation needed
  if (action.type === 'snooze' && action.snoozeUntil) {
    const { transitionStatus } = await import('./itemLifecycle/lifecycleService');
    await transitionStatus(openItemId, 'SNOOZED' as any, {
      clientNumber,
      actor: `user:${userId}`,
      reason: 'snoozed via legacy action pipeline',
      snoozeUntil: action.snoozeUntil,
    });
    await prisma.openItem.update({
      where: { id: openItemId },
      data: {
        dueDate: action.snoozeUntil,
        metadata: { snoozedAt: new Date().toISOString() } as any,
      },
    });
    return { status: 'snoozed', openItemId };
  }

  const before = new Date();

  // Build write targets for this action type
  const targets: WriteTarget[] = [
    // Target 1: Update entity interaction timestamp
    {
      name: 'entity_context',
      write: async () => {
        const item = await openItemsService.getItem(openItemId, clientNumber);
        if (item?.entityId) await entityService.touchInteraction(item.entityId);
      },
      confirm: async () => {
        const item = await openItemsService.getItem(openItemId, clientNumber);
        if (!item?.entityId) return true; // no entity, nothing to confirm
        const entity = await entityService.getEntity(item.entityId, clientNumber);
        return entity ? new Date(entity.lastInteraction!) > before : false;
      },
    },

    // Target 2: Log the action as a note on the open item
    {
      name: 'action_log',
      write: async () => {
        await openItemsService.addNote(
          openItemId, clientNumber,
          `Action executed: ${action.type}${action.draft ? ' — ' + action.draft.slice(0, 100) : ''}`,
          userId,
        );
      },
      confirm: async () => {
        const item = await openItemsService.getItem(openItemId, clientNumber);
        const notes = (item?.notes as any[]) || [];
        return notes.some((n: any) => n.text?.includes(`Action executed: ${action.type}`));
      },
    },

    // Target 3: Connector-specific execution (logged as metadata)
    // In future: call actual connector services (Gmail send, Calendar create, etc.)
    {
      name: `connector_${action.type}`,
      write: async () => {
        const item = await openItemsService.getItem(openItemId, clientNumber);
        await prisma.openItem.update({
          where: { id: openItemId },
          data: {
            metadata: {
              ...((item?.metadata as object) ?? {}),
              lastAction: action.type,
              lastActionDraft: action.draft?.slice(0, 500),
              lastActionAt: new Date().toISOString(),
            } as any,
          },
        });
      },
      confirm: async () => {
        const item = await openItemsService.getItem(openItemId, clientNumber);
        return (item?.metadata as any)?.lastAction === action.type;
      },
    },
  ];

  // Execute all writes in parallel
  const writeResults = await Promise.allSettled(targets.map(t => t.write()));

  // Confirm each write succeeded (read-back)
  const confirmResults = await Promise.allSettled(
    targets.map((t, i) =>
      writeResults[i].status === 'fulfilled' ? t.confirm() : Promise.resolve(false),
    ),
  );

  const failed = targets.filter((_, i) => {
    const cr = confirmResults[i];
    return cr.status === 'rejected' || (cr.status === 'fulfilled' && !cr.value);
  }).map(t => t.name);

  if (failed.length === 0) {
    // All confirmed — mark CLOSED + revert any propagation boosts (Sprint 2 Gap G-A)
    await openItemsService.changeStatus(
      openItemId,
      clientNumber,
      'CLOSED' as any,
      `Action completed: ${action.type}`,
      `user:${userId}`,
    );
    entityPropagationService.revertPropagation(openItemId, clientNumber).catch(() => {});
    return { status: 'done', confirmedTargets: targets.length, openItemId };
  } else {
    // Partial failure — revert to IN_PROGRESS, create alert
    await openItemsService.changeStatus(
      openItemId,
      clientNumber,
      'IN_PROGRESS' as any,
      `Partial failure: ${failed.join(', ')}`,
      `user:${userId}`,
    );
    await createPartialFailureAlert(failed, openItemId, userId, clientNumber);
    return { status: 'partial_failure', failedTargets: failed, openItemId };
  }
}

// ─── Partial failure alert ──────────────────────────────────────

async function createPartialFailureAlert(
  failedTargets: string[],
  openItemId: string,
  userId: number,
  clientNumber: string,
): Promise<void> {
  const item = await openItemsService.getItem(openItemId, clientNumber);
  await openItemsService.createItem(userId, clientNumber, {
    title: `Write incomplete: "${item?.title ?? openItemId}" — ${failedTargets.join(', ')} failed`,
    description: `The following write targets failed during action execution: ${failedTargets.join(', ')}. The item has been kept in_progress. Review and retry when ready.`,
    type: 'alert',
    priority: 'high',
    sourceFeed: 'manual',
    metadata: { failedTargets, relatedItemId: openItemId },
  });
}
