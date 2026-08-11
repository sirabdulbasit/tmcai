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
  // Quality gate — only applies to auto-created items where Brain
  // produced the title from a feed event. Manual / split / "+ New Item"
  // creates carry metadata.manualCreate=true (or no senderEmail in
  // metadata) and bypass the gate entirely. The gate rejects vendor
  // bulletins, password-changed notifications, dashboard nags, and
  // automated-sender mail BEFORE the row is written, so the backlog
  // stops growing from junk.
  const inputMeta = (input.metadata as Record<string, unknown> | undefined) ?? {};
  const isAutoCreate = inputMeta.senderEmail || inputMeta.classificationPass || inputMeta.fromAutomation;
  const isManual = inputMeta.manualCreate === true || inputMeta.imported_from === 'manual';
  if (isAutoCreate && !isManual) {
    const { qualifyAutoOpenItem } = await import('./openItems/qualityGate');
    const senderEmail = typeof inputMeta.senderEmail === 'string' ? (inputMeta.senderEmail as string) : null;
    const verdict = qualifyAutoOpenItem({
      title: input.title,
      body: input.description ?? '',
      dueDate: input.dueDate,
      archetype: typeof inputMeta.archetype === 'string' ? (inputMeta.archetype as string) : null,
      intent: typeof inputMeta.pass2Intent === 'string' ? (inputMeta.pass2Intent as string) : null,
      confidence: typeof inputMeta.confidence === 'number' ? (inputMeta.confidence as number) : undefined,
      senderEmail,
    });
    if (verdict.verdict === 'reject') {
      console.info(`[openItems] auto-create rejected: ${verdict.code} — ${verdict.reason} · "${input.title.slice(0, 80)}"`);
      return null as any;
    }

    // Cumulative learning: if the user has marked 3+ items with this
    // (senderEmail, title-prefix) signature as "not relevant" in the
    // last 14 days, treat future items matching the same signature as
    // junk and reject at the gate. The user's pushback becomes a
    // permanent block until they unblock manually.
    if (senderEmail) {
      const titlePrefix = input.title.toLowerCase()
        .replace(/^(\s*(re|fwd|fw)\s*:\s*)+/g, '')
        .replace(/[\d/.\-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
      const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const wrongCount = await prisma.openItem.count({
        where: {
          clientNumber, userId,
          status: 'closed' as any,
          createdAt: { gte: since },
          metadata: {
            path: ['archivedReason'],
            equals: 'user_marked_wrong',
          } as any,
          // Match same sender + same title prefix
          AND: [
            { metadata: { path: ['senderEmail'], equals: senderEmail } as any },
          ],
        },
      }).catch(() => 0);
      if (wrongCount >= 3) {
        // Confirm same title prefix by fetching titles and comparing.
        // Cheap: 14d * 3+ wrongs is bounded by daily caps.
        const recentWrongs = await prisma.openItem.findMany({
          where: {
            clientNumber, userId,
            status: 'closed' as any,
            createdAt: { gte: since },
            metadata: {
              path: ['archivedReason'],
              equals: 'user_marked_wrong',
            } as any,
            AND: [
              { metadata: { path: ['senderEmail'], equals: senderEmail } as any },
            ],
          },
          select: { title: true },
          take: 20,
        }).catch(() => [] as Array<{ title: string }>);
        const samePrefix = recentWrongs.filter((r) => r.title.toLowerCase()
          .replace(/^(\s*(re|fwd|fw)\s*:\s*)+/g, '')
          .replace(/[\d/.\-]+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 40) === titlePrefix).length;
        if (samePrefix >= 3) {
          console.info(`[openItems] auto-create rejected: user_marked_wrong_pattern — sender=${senderEmail} prefix="${titlePrefix}" wrongs=${samePrefix}`);
          return null as any;
        }
      }
    }
  }

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
  // MEM-005, 2026-08-11 — open-item embedding call REMOVED.
  //
  // It wrote to `open_item_embeddings`, a table dropped on 2026-05-18. The
  // Prisma model does not exist, so the call threw a TypeError that the
  // service's own try/catch turned into a `console.warn` — every item creation
  // since May did this work, failed, and said nothing. `.catch(() => {})` here
  // could not have caught it either: the throw happens while resolving the
  // undefined model property, before any promise exists.
  //
  // Nothing replaced it because nothing consumed it: the only reader was
  // `GET /open-items/:id/similar`, also removed. Open-item retrieval is served
  // by the wiki vector path, which is live and on the current model.

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

  // Star cadence is now triggered at feed-ingest (feedIngestionService),
  // not here, so a starred contact's message always gets the cadence
  // treatment regardless of whether it lands as an open item. Re-anchoring
  // the cadence to the new openItemId would only matter for the pause
  // logic — and the queue dispatcher already skips queued rows whose
  // openItemId points at a closed item via openItemsService.changeStatus.

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

/**
 * THE canonical query for a user's open items. ONE function. Three callers:
 *   - GET /open-items (UI's Action Center list)
 *   - brainComposer's "Open items snapshot" injection (web + WhatsApp chat)
 *   - dayBriefDispatchJob's open-items section
 *
 * All three MUST go through here so the web UI, web Brain Chat, and
 * WhatsApp Brain show the same rows for the same user. Per Basit
 * 2026-05-20: "brain should have same knowledge, same feed, same open
 * item as it is showing in tai.tmcltd, brain chat or whatsap chat all
 * three conversation, information, sources should be the same."
 *
 * Defaults match the Action Center's "All" tab: every status except
 * closed/done/archived (case-insensitive), priority-first order,
 * smoke/test items excluded. Callers can opt in to wider/narrower
 * filtering via the options.
 */
export async function listItems(
  userId: number,
  clientNumber: string,
  filters?: {
    status?: OpenItemStatus | OpenItemStatus[];
    priority?: OpenItemPriority | OpenItemPriority[];
    type?: OpenItemType | OpenItemType[];
    entityId?: string;
    sourceFeed?: string;
    /** Cap on rows returned. Default: no cap (UI lists all). */
    limit?: number;
    /** Drop test/regression items (metadata.smoke=true). Default true.
     *  brainComposer always wants this; UI now opts-in by default too
     *  so the Action Center doesn't show battery rows. */
    excludeSmoke?: boolean;
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
  } else {
    // No explicit status filter ("All" tab on the client) — exclude
    // archived / closed / done items by default. The Action Center
    // is for items that still need a decision; surfacing rows the user
    // already disposed of (Done / Wrong / archived) defeats the purpose
    // and is what produced the "I marked them Wrong but they're still
    // there" complaint.
    where.status = { notIn: ['closed', 'CLOSED', 'done', 'DONE', 'archived', 'ARCHIVED'] };
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
  // Smoke filter is OPT-IN (default false). Per Basit 2026-05-20: the
  // previous default-true broke the UI Action Center — it showed
  // "2 Total Open" in the stats tile but "No items found" in the list,
  // because Prisma's NOT-JSON-path clause silently drops rows whose
  // metadata doesn't contain a 'smoke' key (Postgres treats missing-
  // key path queries as NULL → NOT NULL → UNKNOWN → row excluded by
  // WHERE). The two real items (EXIM, Polypack) have no smoke key in
  // metadata so they got filtered out by my own "safety" filter.
  //
  // Fix: JS post-filter only the rows we want to drop, and only when
  // the caller explicitly asks. UI doesn't pass excludeSmoke → keeps
  // its prior behaviour. Brain composer (via services/views/openItems)
  // passes excludeSmoke=true → smoke rows get dropped at the JS layer,
  // safely, without the Postgres NULL-semantics trap.
  const rows = await prisma.openItem.findMany({
    where,
    orderBy: [
      { priority: 'asc' }, // critical first
      { createdAt: 'desc' },
    ],
    ...(filters?.limit ? { take: Math.min(Math.max(filters.limit, 1), 500) } : {}),
  });

  if (filters?.excludeSmoke === true) {
    return rows.filter((r) => {
      const md = (r as { metadata?: unknown }).metadata as Record<string, unknown> | null;
      return !md || md.smoke !== true;
    });
  }
  return rows;
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
    where: { userId, clientNumber, status: { notIn: ['CLOSED', 'closed', 'DONE', 'done', 'ARCHIVED', 'archived'] as any } },
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
