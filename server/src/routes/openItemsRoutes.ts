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

// ─── L2+ Similar items (vector memory) ──────────────────────
router.get('/:id/similar', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const limit = Math.min(parseInt(String(req.query.limit ?? '5'), 10) || 5, 25);
    const { findSimilar } = await import('../services/triage/openItemEmbeddingService');
    const matches = await findSimilar(user.clientNumber, String(req.params.id), limit);
    const ids = matches.map((m) => m.openItemId);
    const items = ids.length
      ? await prisma.openItem.findMany({
          where: { clientNumber: user.clientNumber, id: { in: ids } },
          select: { id: true, title: true, status: true, archetype: true, priority: true },
        })
      : [];
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));
    res.json({
      openItemId: req.params.id,
      matches: matches.map((m) => ({ ...m, item: byId[m.openItemId] ?? null })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── L2+ Status history (audit trail) ────────────────────────
router.get('/:id/history', requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const rows = await (prisma as any).itemStatusHistory.findMany({
      where: { clientNumber: user.clientNumber, openItemId: String(req.params.id) },
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
      (prisma as any).itemStatusHistory.count({
        where: { clientNumber: user.clientNumber, outcome: 'rejected', createdAt: { gte: week } },
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
    const { runFollowupSweep } = await import('../services/openItems/followupWorker');
    const summary = await runFollowupSweep({ dryRun: req.body?.dryRun === true });
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
