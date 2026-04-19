import prisma from '../../db/prisma';
import crypto from 'crypto';

/**
 * Records edges between related AgentActions so the cascading undo engine
 * can traverse them later.
 *
 * Every top-level action call creates a dependencyGraphId (shared across the
 * whole chain). Downstream actions triggered by orchestration handlers
 * (e.g. split_item → 3× create sub-item) inherit the same graph id.
 */
export function newGraphId(traceId?: string): string {
  return traceId ?? `graph_${crypto.randomUUID()}`;
}

export interface EdgeInput {
  clientNumber: string;
  parentActionId: number;
  childActionId: number;
  dependencyType: 'triggers' | 'blocks' | 'informs' | 'compensates';
}

export async function addEdge(edge: EdgeInput): Promise<void> {
  await prisma.actionDependency.upsert({
    where: { parentActionId_childActionId: { parentActionId: edge.parentActionId, childActionId: edge.childActionId } },
    create: { ...edge },
    update: { dependencyType: edge.dependencyType },
  });
}

/** Walk all actions reachable from rootActionId via triggers edges (DFS). */
export async function descendants(rootActionId: number, clientNumber: string): Promise<number[]> {
  const visited = new Set<number>();
  const stack = [rootActionId];
  while (stack.length) {
    const cur = stack.pop()!;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const edges = await prisma.actionDependency.findMany({
      where: { clientNumber, parentActionId: cur, dependencyType: 'triggers' },
      select: { childActionId: true },
    });
    for (const e of edges) {
      if (!visited.has(e.childActionId)) stack.push(e.childActionId);
    }
  }
  visited.delete(rootActionId);
  return Array.from(visited);
}

/** All actions sharing a dependencyGraphId. Used by preview in Action Center. */
export async function actionsInGraph(graphId: string, clientNumber: string) {
  return prisma.agentAction.findMany({
    where: { clientNumber, dependencyGraphId: graphId },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Topological sort of actions for safe undo order: undo children before parents.
 * Returns action IDs in the order they should be reversed.
 */
export async function topoOrderForUndo(rootActionId: number, clientNumber: string): Promise<number[]> {
  const order: number[] = [];
  const tempMark = new Set<number>();
  const permMark = new Set<number>();

  async function visit(id: number): Promise<void> {
    if (permMark.has(id)) return;
    if (tempMark.has(id)) throw new Error(`dependency cycle detected at action ${id}`);
    tempMark.add(id);
    const edges = await prisma.actionDependency.findMany({
      where: { clientNumber, parentActionId: id, dependencyType: 'triggers' },
      select: { childActionId: true },
    });
    for (const e of edges) await visit(e.childActionId);
    tempMark.delete(id);
    permMark.add(id);
    order.push(id);
  }

  await visit(rootActionId);
  return order.reverse();
}
