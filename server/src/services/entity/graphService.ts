/**
 * HaseebOS v15 L5.7 — Entity graph traversal.
 *
 * Provides a BFS walk over `entity_links` up to a configurable depth, plus
 * the "web of related items" query the risk-gating layer needs (HIGH-tier
 * approvals must show every connected OpenItem + recent action).
 *
 * Purely relational for now — no graph DB. When the tenant scale warrants it,
 * swap the internal implementation for Spanner Graph / Neo4j without changing
 * callers.
 */
import prisma from '../../db/prisma';

export interface GraphNode {
  id: string;
  entityType: string;
  name: string;
  depth: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  linkType: string;
}

export interface GraphResult {
  root: string;
  depth: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  relatedOpenItems: Array<{ id: string; title: string; status: string; priority: string | null; entityId: string }>;
  recentActions: Array<{ id: number; actionType: string; status: string; entityId: string | null; createdAt: Date }>;
}

const MAX_DEPTH = 4;
const MAX_NODES = 200;

export async function traverse(clientNumber: string, rootEntityId: string, depth = 2): Promise<GraphResult> {
  const d = Math.min(Math.max(depth, 1), MAX_DEPTH);
  const visited = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const queue: Array<{ id: string; depth: number }> = [{ id: rootEntityId, depth: 0 }];

  while (queue.length > 0 && visited.size < MAX_NODES) {
    const next = queue.shift()!;
    if (visited.has(next.id)) continue;

    const ent = await prisma.entity.findFirst({
      where: { id: next.id, clientNumber },
      select: { id: true, entityType: true, name: true },
    });
    if (!ent) continue;
    visited.set(ent.id, { ...ent, depth: next.depth });

    if (next.depth >= d) continue;

    const links = await prisma.entityLink.findMany({
      where: {
        clientNumber,
        OR: [{ entityId: ent.id }, { linkedEntityId: ent.id }],
      },
      select: { entityId: true, linkedEntityId: true, linkType: true },
    });
    for (const l of links) {
      edges.push({ from: l.entityId, to: l.linkedEntityId, linkType: l.linkType });
      const other = l.entityId === ent.id ? l.linkedEntityId : l.entityId;
      if (!visited.has(other)) queue.push({ id: other, depth: next.depth + 1 });
    }
  }

  const ids = Array.from(visited.keys());
  // OpenItems carry entityId directly. AgentActions do not — we look them up
  // via the items' openItemId to stay within the existing schema.
  const items = await prisma.openItem.findMany({
    where: { clientNumber, entityId: { in: ids } } as any,
    select: { id: true, title: true, status: true, priority: true, entityId: true },
    orderBy: { updatedAt: 'desc' },
    take: 50,
  });
  const openItemIds = items.map((i) => i.id);
  const actions = openItemIds.length
    ? await prisma.agentAction.findMany({
        where: { clientNumber, input: { path: ['openItemId'], in: openItemIds as any } } as any,
        select: { id: true, actionType: true, status: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }).catch(() => [])
    : [];

  return {
    root: rootEntityId,
    depth: d,
    nodes: Array.from(visited.values()),
    edges,
    relatedOpenItems: items as any,
    recentActions: actions.map((a) => ({ ...a, entityId: null })) as any,
  };
}
