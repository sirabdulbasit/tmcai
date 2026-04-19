/**
 * MyOS Open Items Service
 *
 * Unified task/delegation/follow-up/alert database.
 * Every actionable item from any connector lands here.
 * Items are linked to entities, have status lifecycle, and delegation trail.
 */

import prisma from '../db/prisma';

// ─── Types ────────────────────────────────────────────────────────

export type OpenItemType = 'task' | 'email' | 'delegation' | 'alert' | 'erp' | 'okr' | 'risk';
// v15 L2 — 8-value lifecycle + legacy aliases for backwards compatibility with
// callers still passing the old vocabulary (they get translated in changeStatus).
export type OpenItemStatus =
  | 'NEW' | 'TRIAGED' | 'IN_PROGRESS' | 'DELEGATED' | 'WAITING_INFO' | 'SNOOZED' | 'INFORMED' | 'CLOSED'
  | 'open' | 'in_progress' | 'delegated' | 'blocked' | 'done' | 'overdue';
export type OpenItemPriority = 'critical' | 'high' | 'medium' | 'low';

export interface CreateOpenItemInput {
  title: string;
  description?: string;
  entityId?: string;
  type: OpenItemType;
  priority?: OpenItemPriority;
  dueDate?: Date;
  sourceFeed?: string;
  sourceRef?: string;
  connectorId?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateOpenItemInput {
  title?: string;
  description?: string;
  entityId?: string;
  status?: OpenItemStatus;
  priority?: OpenItemPriority;
  dueDate?: Date;
  metadata?: Record<string, unknown>;
}

// ─── CRUD ─────────────────────────────────────────────────────────

export async function createItem(userId: number, clientNumber: string, input: CreateOpenItemInput) {
  const item = await prisma.openItem.create({
    data: {
      title: input.title,
      description: input.description,
      entityId: input.entityId,
      type: input.type,
      priority: input.priority || 'medium',
      dueDate: input.dueDate,
      sourceFeed: input.sourceFeed,
      sourceRef: input.sourceRef,
      connectorId: input.connectorId,
      metadata: (input.metadata as any) || undefined,
      ownerId: userId,
      userId,
      clientNumber,
    },
  });
  // L2+ — embed title+description+archetype into open_item_embeddings for
  // similar-items lookup. Best-effort and async-friendly.
  try {
    const { embedAndStore } = await import('./triage/openItemEmbeddingService');
    const text = [item.title, item.description ?? '', (item as any).archetype ?? ''].filter(Boolean).join('\n');
    embedAndStore(item.id, clientNumber, text).catch(() => {});
  } catch { /* embedding is optional */ }

  // L2.7 — publish creation event on tmcai-open-item-events so Brain,
  // Reflection, and the Steering Wheel see new items live (not just on status
  // transitions). Best-effort: a publish failure does not block creation.
  try {
    const { publish } = await import('./infra/pubsubPublisher');
    const { PUBSUB_TOPICS } = await import('../config/pubsub');
    await publish(
      PUBSUB_TOPICS.OPEN_ITEM_EVENTS,
      {
        openItemId: item.id,
        clientNumber,
        fromStatus: null,
        toStatus: item.status,
        transitionDescription: 'created',
        actor: `user:${userId}`,
        title: item.title,
        priority: item.priority,
        type: item.type,
        entityId: item.entityId,
        occurredAt: item.createdAt?.toISOString?.() ?? new Date().toISOString(),
      },
      {
        tenantId: clientNumber,
        traceId: undefined,
        orderingKey: `${clientNumber}:openitem:${item.id}`,
        attributes: { fromStatus: 'created', toStatus: item.status, actor: `user:${userId}` },
      },
    );
  } catch (err: any) {
    console.warn(`[openItemsService] open-item-events create publish failed ${item.id}: ${err.message}`);
  }
  return item;
}

export async function getItem(id: string, clientNumber: string) {
  return prisma.openItem.findFirst({
    where: { id, clientNumber },
  });
}

export async function updateItem(id: string, clientNumber: string, input: UpdateOpenItemInput) {
  return prisma.openItem.update({
    where: { id },
    data: {
      ...input as any,
    },
  });
}

export async function listItems(
  userId: number,
  clientNumber: string,
  filters?: {
    status?: OpenItemStatus | OpenItemStatus[];
    priority?: OpenItemPriority | OpenItemPriority[];
    type?: OpenItemType | OpenItemType[];
    entityId?: string;
    sourceFeed?: string;
  },
) {
  const where: Record<string, unknown> = { userId, clientNumber };

  if (filters?.status) {
    where.status = Array.isArray(filters.status) ? { in: filters.status } : filters.status;
  }
  if (filters?.priority) {
    where.priority = Array.isArray(filters.priority) ? { in: filters.priority } : filters.priority;
  }
  if (filters?.type) {
    where.type = Array.isArray(filters.type) ? { in: filters.type } : filters.type;
  }
  if (filters?.entityId) {
    where.entityId = filters.entityId;
  }
  if (filters?.sourceFeed) {
    where.sourceFeed = filters.sourceFeed;
  }

  return prisma.openItem.findMany({
    where,
    orderBy: [
      { priority: 'asc' }, // critical first
      { createdAt: 'desc' },
    ],
  });
}

// ─── Status transitions ──────────────────────────────────────────
// L2.4 — DEPRECATED direct path. All status changes must flow through
// services/itemLifecycle/lifecycleService.transitionStatus() so guards +
// history + open-item-events publish are enforced. This legacy helper
// translates its inputs into the v15 8-status set and delegates.

const LEGACY_TO_V15: Record<string, string> = {
  open: 'NEW',
  in_progress: 'IN_PROGRESS',
  delegated: 'DELEGATED',
  blocked: 'WAITING_INFO',
  done: 'CLOSED',
  overdue: 'IN_PROGRESS',
  snoozed: 'SNOOZED',
  triaged: 'TRIAGED',
  informed: 'INFORMED',
  closed: 'CLOSED',
};

export async function changeStatus(
  id: string,
  clientNumber: string,
  status: OpenItemStatus,
  note?: string,
  actor?: string,
) {
  const { transitionStatus } = await import('./itemLifecycle/lifecycleService');
  const v15 = (LEGACY_TO_V15[status as string] ?? status) as any;
  const result = await transitionStatus(id, v15, {
    clientNumber,
    actor: actor ?? 'system',
    reason: note,
  });
  if (!result.ok) {
    throw new Error(result.error ?? 'transition rejected');
  }
  const item = await prisma.openItem.findFirst({ where: { id, clientNumber } });
  if (!item) throw new Error('Item not found after transition');
  if (note) {
    const notes = (item.notes as Array<Record<string, unknown>>) || [];
    notes.push({ text: note, at: new Date().toISOString(), action: `status_changed_to_${v15}` });
    await prisma.openItem.update({ where: { id }, data: { notes: notes as any } });
  }
  return prisma.openItem.findFirst({ where: { id, clientNumber } });
}

// ─── Delegation ──────────────────────────────────────────────────

export async function delegateItem(
  id: string,
  clientNumber: string,
  delegateeId: number | null,
  delegateeName: string,
  delegateeEmail?: string,
  note?: string,
) {
  const item = await prisma.openItem.findFirst({ where: { id, clientNumber } });
  if (!item) throw new Error('Item not found');

  const trail = (item.delegationTrail as Array<Record<string, unknown>>) || [];
  trail.push({
    delegatedTo: delegateeName,
    delegatedToEmail: delegateeEmail || null,
    delegatedAt: new Date().toISOString(),
    note: note || null,
  });

  return prisma.openItem.update({
    where: { id },
    data: {
      status: 'delegated',
      delegateeId,
      delegateeName,
      delegateeEmail,
      delegationTrail: trail as any,
    },
  });
}

// ─── Add note ────────────────────────────────────────────────────

export async function addNote(id: string, clientNumber: string, text: string, userId: number) {
  const item = await prisma.openItem.findFirst({ where: { id, clientNumber } });
  if (!item) throw new Error('Item not found');

  const notes = (item.notes as Array<Record<string, unknown>>) || [];
  notes.push({ text, at: new Date().toISOString(), by: userId });

  return prisma.openItem.update({
    where: { id },
    data: { notes: notes as any },
  });
}

// ─── Stats ───────────────────────────────────────────────────────

export async function getStats(userId: number, clientNumber: string) {
  const items = await prisma.openItem.findMany({
    where: { userId, clientNumber, status: { not: 'done' } },
    select: { status: true, priority: true },
  });

  const byStatus: Record<string, number> = {};
  const byPriority: Record<string, number> = {};

  for (const item of items) {
    byStatus[item.status] = (byStatus[item.status] || 0) + 1;
    byPriority[item.priority] = (byPriority[item.priority] || 0) + 1;
  }

  return { total: items.length, byStatus, byPriority };
}

// ─── Find by source reference (dedup check) ──────────────────────

export async function findBySourceRef(userId: number, clientNumber: string, sourceFeed: string, sourceRef: string) {
  return prisma.openItem.findFirst({
    where: { userId, clientNumber, sourceFeed, sourceRef },
  });
}
