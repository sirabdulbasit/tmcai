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
  // Dedup gate. Without this, every email/feed_event spawns a fresh
  // row even when an open item for the SAME thread/sender/subject is
  // already on the user's plate — that's how local accumulated 2,460
  // open items, 71 critical. If a NEW or TRIAGED item already exists
  // with the same sourceRef (or same title for ad-hoc items), return
  // the existing row instead of creating a duplicate.
  if (input.sourceRef || input.title) {
    const dedupWhere: any = {
      clientNumber, userId,
      status: { in: ['NEW', 'TRIAGED'] as any },
    };
    if (input.sourceRef) {
      dedupWhere.sourceRef = input.sourceRef;
    } else {
      dedupWhere.title = input.title;
      dedupWhere.type = input.type;
    }
    const existing = await prisma.openItem.findFirst({ where: dedupWhere }).catch(() => null);
    if (existing) {
      // Bump priority if the new signal is stronger; otherwise leave alone.
      const order = { critical: 4, high: 3, medium: 2, low: 1 } as Record<string, number>;
      const cur = order[String(existing.priority).toLowerCase()] ?? 2;
      const next = order[String(input.priority ?? 'medium').toLowerCase()] ?? 2;
      if (next > cur) {
        await prisma.openItem.update({
          where: { id: existing.id },
          data: { priority: input.priority },
        }).catch(() => {});
      }
      return existing;
    }
  }

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

  // Star cadence — sender-stars-driven proactive WhatsApp notification
  // schedule. Only fires for feed-originated items where we know the
  // sender. Manual / internal-alert items have no sender so the service
  // returns 'skipped_no_sender' and bails. Best-effort: failures here
  // don't block item creation.
  try {
    const meta = (input.metadata as Record<string, unknown> | undefined) ?? {};
    const senderEmail = pickSenderEmail(meta);
    if (senderEmail) {
      const { scheduleStarCadence } = await import('./triage/starCadenceService');
      scheduleStarCadence({
        clientNumber,
        userId,
        openItemId: item.id,
        itemTitle: item.title,
        itemBody: item.description ?? null,
        intent: typeof meta.pass2Intent === 'string' ? (meta.pass2Intent as string) : null,
        senderEmail,
        senderName: typeof meta.senderName === 'string' ? (meta.senderName as string) : null,
      }).catch((err) => {
        console.warn(`[openItemsService] star cadence schedule failed ${item.id}: ${err?.message}`);
      });
    }
  } catch { /* cadence is optional */ }

  return item;
}

// Extract a normalised sender email from various places callers may have
// stashed it. Handlers stash it under different keys (senderEmail in
// feed-intelligence, fromEmail in delegation-tracker, etc.).
function pickSenderEmail(meta: Record<string, unknown>): string | null {
  const candidates = [
    meta.senderEmail, meta.fromEmail, meta.from, meta.sender,
    (meta.sender as Record<string, unknown> | undefined)?.email,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && /@/.test(c)) return c.trim().toLowerCase();
  }
  return null;
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
    // Frontend tabs send legacy lowercase ('delegated', 'done', …) but the
    // DB stores v15 enums uppercase ('DELEGATED', 'CLOSED', …). Translate
    // both forms so either still hits the right rows.
    const toV15 = (s: string) => LEGACY_TO_V15[s] ?? s;
    const arr = Array.isArray(filters.status) ? filters.status : [filters.status];
    const expanded: string[] = [];
    for (const s of arr) {
      if (!s) continue;
      expanded.push(s, toV15(s));
    }
    const uniq = Array.from(new Set(expanded));
    where.status = uniq.length === 1 ? uniq[0] : { in: uniq };
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
  // Pause star cadence — once the item is no longer NEW/TRIAGED, the
  // user has acknowledged it (closed, in-progress, delegated, snoozed,
  // informed). Cancel any pending sender-stars-driven WhatsApp pings
  // so the user isn't pestered about something they've already handled.
  const PAUSE_STATES = ['CLOSED', 'IN_PROGRESS', 'DELEGATED', 'SNOOZED', 'INFORMED', 'WAITING_INFO', 'closed', 'in_progress', 'delegated', 'snoozed', 'informed', 'waiting_info', 'done'];
  if (PAUSE_STATES.includes(String(v15))) {
    try {
      const { pauseCadenceForItem } = await import('./triage/starCadenceService');
      await pauseCadenceForItem(id, `status→${v15}`).catch(() => {});
    } catch { /* non-blocking */ }
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
  // v15 lifecycle uses uppercase CLOSED; legacy callers may still send 'done'.
  // Exclude both so "Total Open" is the live workload, not all-time history.
  const items = await prisma.openItem.findMany({
    where: { userId, clientNumber, status: { notIn: ['CLOSED', 'done'] as any } },
    select: { status: true, priority: true },
  });

  const byStatus: Record<string, number> = {};
  const byPriority: Record<string, number> = {};

  // Frontend reads byStatus.delegated / .done in lowercase; normalise here so
  // DELEGATED (v15) and delegated (legacy) collapse into the same bucket.
  for (const item of items) {
    const sKey = String(item.status).toLowerCase();
    byStatus[sKey] = (byStatus[sKey] || 0) + 1;
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
