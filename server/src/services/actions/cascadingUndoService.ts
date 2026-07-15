import prisma from '../../db/prisma';
import { topoOrderForUndo, descendants, actionsInGraph } from './dependencyGraphService';
import * as handlerRegistry from './handlerRegistry';
import type { HandlerContext, ReverseOperation } from './handlerBase';

export interface UndoPreview {
  rootActionId: number;
  graphId: string | null;
  willUndoIds: number[];
  dependents: Array<{
    id: number;
    actionType: string;
    executedByAgent: string | null;
    reverseOp: ReverseOperation | null;
  }>;
  warnings: string[];
}

/**
 * Build a preview of what would happen if rootActionId were undone.
 * Does not execute any reverse operations — purely inspection.
 */
export async function preview(rootActionId: number, clientNumber: string): Promise<UndoPreview> {
  const warnings: string[] = [];
  const root = await prisma.agentAction.findFirst({
    where: { id: rootActionId, clientNumber },
    select: { id: true, actionType: true, output: true, status: true, dependencyGraphId: true, undoStatus: true },
  });
  if (!root) {
    return { rootActionId, graphId: null, willUndoIds: [], dependents: [], warnings: ['action not found'] };
  }
  if (root.status !== 'done') warnings.push(`root action status is ${root.status}, not done`);
  if (root.undoStatus === 'undone') warnings.push('root already undone');
  if (root.undoStatus === 'expired') warnings.push('undo window expired');

  const willUndoIds = [rootActionId, ...(await descendants(rootActionId, clientNumber))];
  const rows = await prisma.agentAction.findMany({
    where: { clientNumber, id: { in: willUndoIds } },
    select: { id: true, actionType: true, output: true, executedByAgent: true },
  });
  const dependents = await Promise.all(rows.map(async (r) => {
    const handler = handlerRegistry.get(r.actionType);
    let reverseOp: ReverseOperation | null = null;
    if (handler) {
      try {
        reverseOp = await handler.undo(
          { clientNumber, userId: 0, payload: {} } as HandlerContext,
          r.output,
        );
      } catch {
        reverseOp = null;
      }
    } else {
      warnings.push(`handler "${r.actionType}" not registered — cannot preview undo for action ${r.id}`);
    }
    return { id: r.id, actionType: r.actionType, executedByAgent: r.executedByAgent, reverseOp };
  }));
  return { rootActionId, graphId: root.dependencyGraphId, willUndoIds, dependents, warnings };
}

export type UndoMode = 'single' | 'cascade';

export interface UndoResult {
  rootActionId: number;
  mode: UndoMode;
  undoneIds: number[];
  failed: Array<{ id: number; reason: string }>;
}

/**
 * Execute the cascading undo. In 'cascade' mode, walks all descendants of the
 * root action (topo order), calls each handler's undo(), and records the
 * reverse operation to `action_undo_log`.
 *
 * In 'single' mode, only undoes the root and errors if it has dependents.
 */
export async function execute(
  rootActionId: number,
  clientNumber: string,
  executedBy: number,
  mode: UndoMode,
): Promise<UndoResult> {
  const dependentIds = await descendants(rootActionId, clientNumber);
  if (mode === 'single' && dependentIds.length > 0) {
    throw new Error(`cannot single-undo: action ${rootActionId} has ${dependentIds.length} dependents — use cascade mode`);
  }

  const order = mode === 'cascade' ? await topoOrderForUndo(rootActionId, clientNumber) : [rootActionId];

  const undone: number[] = [];
  const failed: Array<{ id: number; reason: string }> = [];

  for (const id of order) {
    try {
      const action = await prisma.agentAction.findFirst({
        where: { id, clientNumber },
        select: { id: true, actionType: true, output: true, userId: true },
      });
      if (!action) {
        failed.push({ id, reason: 'not found' });
        continue;
      }
      const handler = handlerRegistry.get(action.actionType);
      if (!handler) {
        failed.push({ id, reason: `no handler registered for "${action.actionType}"` });
        continue;
      }
      const reverse = await handler.undo(
        { clientNumber, userId: action.userId, payload: {} } as HandlerContext,
        action.output,
      );
      await prisma.actionUndoLog.create({
        data: {
          clientNumber,
          actionId: id,
          reverseOperation: (reverse ?? { handler: 'noop', payload: {} }) as any,
          executedBy,
          undoneAt: new Date(),
        },
      });
      await prisma.agentAction.update({
        where: { id },
        data: { undoStatus: 'undone' },
      });
      undone.push(id);
    } catch (err: any) {
      failed.push({ id, reason: err.message });
    }
  }

  return { rootActionId, mode, undoneIds: undone, failed };
}

/** All actions in a dependency graph — used by UI to render a tree. */
export async function graphSummary(graphId: string, clientNumber: string) {
  return actionsInGraph(graphId, clientNumber);
}
