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

async function executeInternal(action: ApprovedAction): Promise<ExecutionResult> {
  const { openItemId, userId, clientNumber } = action;

  // Snooze is simple — no write confirmation needed
  if (action.type === 'snooze' && action.snoozeUntil) {
    await openItemsService.changeStatus(openItemId, clientNumber, 'open');
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
    // All confirmed — mark DONE + revert any propagation boosts (Sprint 2 Gap G-A)
    await openItemsService.changeStatus(openItemId, clientNumber, 'done', `Action completed: ${action.type}`);
    entityPropagationService.revertPropagation(openItemId, clientNumber).catch(() => {});
    return { status: 'done', confirmedTargets: targets.length, openItemId };
  } else {
    // Partial failure — revert to in_progress, create alert
    await openItemsService.changeStatus(openItemId, clientNumber, 'in_progress', `Partial failure: ${failed.join(', ')}`);
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
