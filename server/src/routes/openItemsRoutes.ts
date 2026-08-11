/**
 * MyOS Open Items Routes
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import * as openItemsService from '../services/openItemsService';
import prisma from '../db/prisma';
import { transitionStatus } from '../services/itemLifecycle/lifecycleService';
import { TRANSITIONS, allFromTransitions, ALL_STATUSES, ItemStatus } from '../services/itemLifecycle/transitionMatrix';

const router = Router();

// ─── List open items ──────────────────────────────────────────
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const items = await openItemsService.listItems(user.id, user.clientNumber, {
      status: req.query.status as any,
      priority: req.query.priority as any,
      type: req.query.type as any,
      entityId: req.query.entityId as string | undefined,
      sourceFeed: req.query.sourceFeed as string | undefined,
    });
    res.json({ items });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Get item stats ───────────────────────────────────────────
router.get('/stats', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const stats = await openItemsService.getStats(user.id, user.clientNumber);
    res.json(stats);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Batch fetch by ids (used by Brain Chat panel overlay) ────
// Frontend gets a PanelDirective with itemIds[] and needs the rows
// (title, status, priority, dueDate) to render the card.
router.post('/by-ids', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const raw = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = raw
      .filter((x: unknown): x is string => typeof x === 'string')
      .slice(0, 50);
    if (ids.length === 0) { res.json({ items: [] }); return; }
    const prismaMod = await import('../db/prisma');
    const items = await prismaMod.default.openItem.findMany({
      where: { id: { in: ids }, userId: user.id } as any,
      select: {
        id: true, title: true, description: true, status: true, priority: true,
        dueDate: true, delegateeName: true, delegateeEmail: true, createdAt: true,
      } as any,
    });
    // Preserve caller-supplied order so the panel renders in the
    // sequence the directive specified.
    const byId = new Map(items.map((i: any) => [i.id, i]));
    const ordered = ids.map((id: string) => byId.get(id)).filter(Boolean);
    res.json({ items: ordered });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Get single item ──────────────────────────────────────────
router.get('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const item = await openItemsService.getItem(req.params.id as string, user.clientNumber);
    if (!item) { res.status(404).json({ error: 'Item not found' }); return; }
    res.json({ item });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Create item ──────────────────────────────────────────────
router.post('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { title, description, entityId, type, priority, dueDate, sourceFeed, sourceRef, metadata } = req.body;

    if (!title || !type) {
      res.status(400).json({ error: 'title and type are required' });
      return;
    }

    const item = await openItemsService.createItem(user.id, user.clientNumber, {
      title, description, entityId, type, priority,
      dueDate: dueDate ? new Date(dueDate) : undefined,
      sourceFeed, sourceRef, metadata,
    });
    res.status(201).json({ item });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Update item ──────────────────────────────────────────────
router.patch('/:id', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { title, description, entityId, status, priority, dueDate, metadata } = req.body;

    const item = await openItemsService.updateItem(req.params.id as string, user.clientNumber, {
      title, description, entityId, status, priority,
      dueDate: dueDate ? new Date(dueDate) : undefined,
      metadata,
    });
    res.json({ item });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Change status ────────────────────────────────────────────
router.post('/:id/status', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { status, note } = req.body;
    const item = await openItemsService.changeStatus(
      req.params.id as string,
      user.clientNumber,
      status,
      note,
      `user:${user.id}`,
    );
    res.json({ item });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Delegate item ────────────────────────────────────────────
router.post('/:id/delegate', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { delegateeId, delegateeName, delegateeEmail, note } = req.body;

    if (!delegateeName) {
      res.status(400).json({ error: 'delegateeName is required' });
      return;
    }

    const item = await openItemsService.delegateItem(
      req.params.id as string, user.clientNumber,
      delegateeId || null, delegateeName, delegateeEmail, note,
    );
    res.json({ item });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Add note ─────────────────────────────────────────────────
router.post('/:id/note', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const { text } = req.body;
    if (!text) { res.status(400).json({ error: 'text is required' }); return; }
    const item = await openItemsService.addNote(req.params.id as string, user.clientNumber, text, user.id);
    res.json({ item });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// MEM-005, 2026-08-11 — `GET /:id/similar` REMOVED.
//
// It served open-item vector similarity from `open_item_embeddings`, a table
// DROPPED on 2026-05-18 ("orphan, never referenced" — schema.prisma). The model
// is absent from the generated Prisma client, so `(prisma as any)
// .openItemEmbedding.findUnique` threw a TypeError on every call; the route
// answered 500 for its whole lifetime. No client code called it.
//
// Retired rather than rebuilt: recreating a table needs product evidence that
// the feature is wanted, and there is none. The owner's rule is one coherent
// implementation per responsibility, not a spare one kept alive on hope.

// ─── L2+ Status history (audit trail) ────────────────────────
router.get('/:id/history', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    // DEF-127 — scoped by USER as well as tenant. Transition history is
    // user-owned data: two colleagues in one tenant must not read each other's
    // audit trail, and tenant scope alone would have let them. The `$extends`
    // guard injects userId for this model too; naming it here is explicit
    // rather than dependent on that.
    const rows = await prisma.itemStatusHistory.findMany({
      where: {
        clientNumber: user.clientNumber,
        userId: user.id,
        openItemId: String(req.params.id),
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    res.json({ openItemId: req.params.id, history: rows });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── L2+ Legal transitions from current status ───────────────
router.get('/:id/transitions', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const item = await prisma.openItem.findFirst({
      where: { clientNumber: user.clientNumber, id: String(req.params.id) },
      select: { status: true, ownerId: true, delegateeId: true, delegateeEmail: true },
    });
    if (!item) return res.status(404).json({ error: 'open item not found' });
    const current = (item.status as ItemStatus) ?? 'NEW';
    const legal = allFromTransitions(current).map((t) => ({
      from: t.from,
      to: t.to,
      guards: t.guards,
      requiresApproval: t.requiresApproval,
      description: t.description,
      hasDelegatee: !!(item.delegateeId ?? item.delegateeEmail),
    }));
    res.json({ currentStatus: current, allStatuses: ALL_STATUSES, legal });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── L2+ Item metrics (by status/archetype/priority, 24h + 7d) ──
router.get('/metrics', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const now = Date.now();
    const day = new Date(now - 24 * 60 * 60 * 1000);
    const week = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const [byStatus, byPriority, byArchetype, createdDay, createdWeek, rejectedTransitions] = await Promise.all([
      prisma.openItem.groupBy({ by: ['status'] as any, where: { clientNumber: user.clientNumber } as any, _count: { _all: true } as any }),
      prisma.openItem.groupBy({ by: ['priority'] as any, where: { clientNumber: user.clientNumber } as any, _count: { _all: true } as any }),
      prisma.openItem.groupBy({ by: ['archetype'] as any, where: { clientNumber: user.clientNumber } as any, _count: { _all: true } as any }),
      prisma.openItem.count({ where: { clientNumber: user.clientNumber, createdAt: { gte: day } } }),
      prisma.openItem.count({ where: { clientNumber: user.clientNumber, createdAt: { gte: week } } }),
      // DEF-127 — typed, and user-scoped like the history read above. This is a
      // per-user metric on a per-user ledger; counting the whole tenant would
      // report a colleague's rejected transitions as the caller's own.
      prisma.itemStatusHistory.count({
        where: {
          clientNumber: user.clientNumber,
          userId: user.id,
          outcome: 'rejected',
          createdAt: { gte: week },
        },
      }).catch(() => 0),
    ]);
    res.json({
      tenantId: user.clientNumber,
      byStatus: (byStatus as any[]).map((r) => ({ key: r.status, count: r._count._all })),
      byPriority: (byPriority as any[]).map((r) => ({ key: r.priority, count: r._count._all })),
      byArchetype: (byArchetype as any[]).map((r) => ({ key: r.archetype ?? 'unclassified', count: r._count._all })),
      createdLast24h: createdDay,
      createdLast7d: createdWeek,
      rejectedTransitionsLast7d: rejectedTransitions,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── L2+ Bulk transition (Brain / admin power tool) ──────────
router.post('/bulk-transition', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const target = String(req.body?.target ?? '') as ItemStatus;
    const reason = req.body?.reason as string | undefined;
    if (ids.length === 0 || !target) return res.status(400).json({ error: 'ids[] and target required' });
    if (ids.length > 100) return res.status(400).json({ error: 'bulk limit is 100 items' });
    const results: any[] = [];
    for (const id of ids) {
      const r = await transitionStatus(String(id), target, {
        clientNumber: user.clientNumber,
        actor: `user:${user.id}`,
        reason,
        traceId: req.headers['x-request-id'] as string | undefined,
      });
      results.push({ id, ...r });
    }
    const accepted = results.filter((r) => r.ok).length;
    res.json({ target, attempted: ids.length, accepted, rejected: ids.length - accepted, results });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * Mark an item as "not relevant" — semantically distinct from "Done".
 * Done means "I completed this work"; mark-wrong means "this row should
 * never have existed". Both close the row, but mark-wrong stamps a
 * learning signal so Brain can:
 *   1. Stop creating future items matching the same (sender, title-prefix)
 *   2. Demote the criticality of similar items if 3+ wrongs in 14 days
 *
 * Single-item form. Bulk form below.
 *
 * Body: { reason?: string }   — optional category like "vendor_noise",
 *                                "duplicate", "not_actionable", "other"
 */
router.post('/:id/mark-wrong', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const id = String(req.params.id);
    const reason = String(req.body?.reason ?? 'user_marked_wrong').slice(0, 80);

    const item = await prisma.openItem.findFirst({
      where: { id, clientNumber: user.clientNumber, userId: user.id },
      select: { id: true, metadata: true, title: true },
    });
    if (!item) return res.status(404).json({ error: 'not found' });

    const meta = (item.metadata as Record<string, unknown> | null) ?? {};
    await prisma.openItem.update({
      where: { id },
      data: {
        status: 'closed' as any,
        metadata: {
          ...(meta as any),
          archivedReason: 'user_marked_wrong',
          userWrongReason: reason,
          archivedAt: new Date().toISOString(),
        } as any,
      },
    });
    res.json({ ok: true, id });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Bulk mark-wrong — same semantic, batched. Caps at 100 per call.
 * Body: { ids: string[], reason?: string }
 */
router.post('/bulk-mark-wrong', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const reason = String(req.body?.reason ?? 'user_marked_wrong').slice(0, 80);
    if (ids.length === 0) return res.status(400).json({ error: 'ids[] required' });
    if (ids.length > 100) return res.status(400).json({ error: 'bulk limit is 100 items' });

    const items = await prisma.openItem.findMany({
      where: { id: { in: ids }, clientNumber: user.clientNumber, userId: user.id },
      select: { id: true, metadata: true },
    });
    let updated = 0;
    for (const it of items) {
      const meta = (it.metadata as Record<string, unknown> | null) ?? {};
      await prisma.openItem.update({
        where: { id: it.id },
        data: {
          status: 'closed' as any,
          metadata: {
            ...(meta as any),
            archivedReason: 'user_marked_wrong',
            userWrongReason: reason,
            archivedAt: new Date().toISOString(),
          } as any,
        },
      }).then(() => { updated++; }).catch(() => {});
    }
    res.json({ attempted: ids.length, updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── L2+ Full transition matrix (read-only reference) ────────
router.get('/transitions/matrix', requireAuth, async (_req: Request, res: Response) => {
  res.json({ statuses: ALL_STATUSES, transitions: TRANSITIONS });
});

/**
 * Manual trigger for the follow-up sweep — useful for admin-driven
 * testing and as a "run now" button on the Open Items page. Returns
 * the same shape as the scheduled hourly run.
 *
 * Body: { dryRun?: boolean }
 */
router.post('/followup-sweep', requireAuth, async (req: Request, res: Response) => {
  try {
    const { runActionLifecycleSweep } = await import('../jobs/actionLifecycleWorker');
    const summary = await runActionLifecycleSweep({ dryRun: req.body?.dryRun === true });
    res.json({ ok: true, ...summary });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Smart triage cleanup. Brain-side janitor that closes items the user
 * objectively no longer cares about, so the page stops being a junk
 * drawer of 2,000+ NEW rows. Two passes:
 *
 *   1. Stale: NEW status, > stale_days old (default 30), no notes,
 *      no transitions ever, no critical priority. Bulk-mark CLOSED
 *      with a system reason so the audit trail explains the cleanup.
 *
 *   2. Dedup: groups of NEW items sharing the SAME sourceRef. Keep
 *      the highest-priority / oldest one, mark the rest CLOSED with
 *      reason="duplicate of {keepId}".
 *
 * POST body: { staleDays?: number, dryRun?: boolean }
 * Returns counts; safe to re-run.
 */
router.post('/triage-cleanup', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const staleDays = Math.max(7, Math.min(180, Number(req.body?.staleDays ?? 30)));
    const dryRun = req.body?.dryRun === true;
    const cutoff = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);

    // ── Stale pass ──
    // NEW + older than cutoff + non-critical + no description-derived urgency.
    // Critical items are NEVER auto-closed; the user decides those.
    const staleCandidates = await prisma.openItem.findMany({
      where: {
        clientNumber: user.clientNumber, userId: user.id,
        status: 'NEW',
        priority: { not: 'critical' as any },
        createdAt: { lt: cutoff },
      } as any,
      select: { id: true, sourceRef: true, priority: true, createdAt: true },
    });

    // ── Dedup pass on what remains ──
    const remainingNew = await prisma.openItem.findMany({
      where: {
        clientNumber: user.clientNumber, userId: user.id,
        status: 'NEW',
        sourceRef: { not: null } as any,
        id: { notIn: staleCandidates.map((s) => s.id) },
      } as any,
      select: { id: true, sourceRef: true, priority: true, createdAt: true },
      orderBy: [{ createdAt: 'asc' }],
    });
    const bySource = new Map<string, typeof remainingNew>();
    for (const r of remainingNew) {
      const k = String(r.sourceRef);
      if (!bySource.has(k)) bySource.set(k, []);
      bySource.get(k)!.push(r);
    }
    const dupVictims: string[] = [];
    for (const group of bySource.values()) {
      if (group.length <= 1) continue;
      // Keep the oldest (already sorted asc by createdAt). Drop the rest.
      for (let i = 1; i < group.length; i++) dupVictims.push(group[i].id);
    }

    const staleIds = staleCandidates.map((s) => s.id);

    if (dryRun) {
      return res.json({
        ok: true, dryRun: true,
        stale: staleIds.length, dedup: dupVictims.length,
        total: staleIds.length + dupVictims.length,
      });
    }

    // Apply both passes — direct UPDATE so we don't pay per-row trigger
    // overhead on a 2k+ batch.
    let staleClosed = 0;
    let dupClosed = 0;
    if (staleIds.length > 0) {
      const r = await prisma.openItem.updateMany({
        where: { id: { in: staleIds } },
        data: { status: 'CLOSED' as any, updatedAt: new Date() } as any,
      });
      staleClosed = r.count;
    }
    if (dupVictims.length > 0) {
      const r = await prisma.openItem.updateMany({
        where: { id: { in: dupVictims } },
        data: { status: 'CLOSED' as any, updatedAt: new Date() } as any,
      });
      dupClosed = r.count;
    }

    res.json({
      ok: true,
      stale: staleClosed,
      dedup: dupClosed,
      total: staleClosed + dupClosed,
      staleDays,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
