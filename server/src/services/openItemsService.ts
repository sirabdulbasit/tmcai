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
export type OpenItemStatus = 'open' | 'in_progress' | 'delegated' | 'blocked' | 'done' | 'overdue';
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
  return prisma.openItem.create({
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

export async function changeStatus(id: string, clientNumber: string, status: OpenItemStatus, note?: string) {
  const item = await prisma.openItem.findFirst({ where: { id, clientNumber } });
  if (!item) throw new Error('Item not found');

  const notes = (item.notes as Array<Record<string, unknown>>) || [];
  if (note) {
    notes.push({ text: note, at: new Date().toISOString(), action: `status_changed_to_${status}` });
  }

  return prisma.openItem.update({
    where: { id },
    data: { status, notes: notes as any },
  });
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
