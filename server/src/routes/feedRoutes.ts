import { Router, Request, Response } from 'express';
import prisma from '../db/prisma';
import { ingest, markProcessed, markSkipped, FeedSourceType, verifySourceIntegrity } from '../services/feed/feedIngestionService';
import { capabilities as adapterCapabilities, get as getAdapter, listAll as listAdapters } from '../services/adapters/adapterRegistry';

const router = Router();

/**
 * POST /api/v1/feed/ingest — agent-callable path that accepts a feed event
 * directly. Normally events flow in via connector-side `ingest()` calls;
 * this route is here for manual testing and for the Feed Curator agent if it
 * needs to re-ingest a corrected payload.
 */
router.post('/ingest', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const body = req.body ?? {};
  if (!body.sourceType || !body.sourceId) {
    return res.status(400).json({ error: 'sourceType and sourceId required' });
  }
  try {
    const result = await ingest({
      clientNumber: body.clientNumber ?? user.clientNumber,
      sourceType: body.sourceType,
      sourceId: String(body.sourceId),
      payload: body.payload ?? {},
      traceId: body.traceId,
    });
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/v1/feed/events/:id/processed — Feed Curator marks an event done
 * after promoting to an OpenItem (or skipped after deciding it's noise).
 */
router.post('/events/:id/processed', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const id = String(req.params.id);
  const body = req.body ?? {};
  try {
    await markProcessed(id, body.clientNumber ?? user.clientNumber, body.openItemId);
    res.json({ ok: true, feedEventId: id, linkedOpenItem: body.openItemId ?? null });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/events/:id/skipped', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const id = String(req.params.id);
  const reason = String(req.body?.reason ?? 'no reason given');
  try {
    await markSkipped(id, user.clientNumber, reason);
    res.json({ ok: true, feedEventId: id, reason });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/v1/feed/adapters — list registered adapters + their capability matrix.
 * Used by the admin UI to decide which backfill/teardown controls to render.
 */
router.get('/adapters', async (_req: Request, res: Response) => {
  res.json({ adapters: adapterCapabilities() });
});

/**
 * POST /api/v1/feed/backfill — replay historical events for a given source.
 * Body: { sourceType, since?, until?, maxEvents? }
 * Dispatches to adapter registry; returns 501 if adapter does not support backfill.
 */
router.post('/backfill', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const body = req.body ?? {};
  const sourceType = body.sourceType as FeedSourceType | undefined;
  if (!sourceType) return res.status(400).json({ error: 'sourceType required' });

  const adapter = getAdapter(sourceType);
  if (!adapter) return res.status(404).json({ error: `no adapter registered for "${sourceType}"` });
  if (!adapter.capabilities().backfill) {
    return res.status(501).json({ error: `adapter "${sourceType}" does not support backfill` });
  }

  try {
    const result = await adapter.backfill({
      tenantId: user.clientNumber,
      since: body.since ? new Date(body.since) : undefined,
      until: body.until ? new Date(body.until) : undefined,
      maxEvents: typeof body.maxEvents === 'number' ? body.maxEvents : undefined,
    });
    res.json({ ok: true, sourceType, result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/v1/feed/adapters/:sourceType/health — per-adapter health probe.
 * Powers the Steering Wheel Health Check tab's adapter row.
 */
router.get('/adapters/:sourceType/health', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const sourceType = req.params.sourceType as FeedSourceType;
  const adapter = getAdapter(sourceType);
  if (!adapter) return res.status(404).json({ error: `no adapter registered for "${sourceType}"` });
  try {
    const health = await adapter.health(user.clientNumber);
    res.json({ sourceType, displayName: adapter.displayName, health });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/v1/feed/events/:id/verify — L1.5 tamper-evidence check.
 * Recomputes the HMAC and constant-time-compares against source_integrity.
 */
router.get('/events/:id/verify', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const id = String(req.params.id);
  const row = await prisma.feedEvent.findFirst({
    where: { id, clientNumber: user.clientNumber },
    select: { sourceType: true, sourceId: true, contentHash: true, sourceIntegrity: true } as any,
  });
  if (!row) return res.status(404).json({ error: 'feed event not found' });
  const ok = verifySourceIntegrity(
    user.clientNumber,
    (row as any).sourceType,
    (row as any).sourceId,
    (row as any).contentHash,
    (row as any).sourceIntegrity,
  );
  res.json({
    feedEventId: id,
    ok,
    detail: ok ? 'HMAC matches — row not tampered since ingest' : 'HMAC mismatch or column unset — row may be tampered or pre-integrity',
    hasIntegrity: !!(row as any).sourceIntegrity,
  });
});

/**
 * GET /api/v1/feed/stats — per-source counts for the last 24h, used by the
 * Steering Wheel Health Check tab and by the Brain's snapshot_state tool.
 */
router.get('/stats', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await prisma.feedEvent.groupBy({
    by: ['sourceType', 'status'] as any,
    where: { clientNumber: user.clientNumber, createdAt: { gte: since } } as any,
    _count: { _all: true } as any,
  });
  const bySource: Record<string, Record<string, number>> = {};
  for (const r of rows as any[]) {
    bySource[r.sourceType] = bySource[r.sourceType] ?? {};
    bySource[r.sourceType][r.status] = r._count._all;
  }
  const dlqTotal = rows.filter((r: any) => r.status === 'dlq').reduce((s: number, r: any) => s + r._count._all, 0);
  res.json({
    tenantId: user.clientNumber,
    windowHours: 24,
    bySource,
    dlqTotal,
    registeredAdapters: listAdapters().map((a) => a.sourceType),
  });
});

/**
 * POST /api/v1/feed/adapters/:sourceType/teardown — disconnect a source for the
 * current tenant: revoke tokens, remove webhooks, clear per-tenant state.
 */
router.post('/adapters/:sourceType/teardown', async (req: Request, res: Response) => {
  const user = (req as any).user;
  if (!user?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  const sourceType = req.params.sourceType as FeedSourceType;
  const adapter = getAdapter(sourceType);
  if (!adapter) return res.status(404).json({ error: `no adapter registered for "${sourceType}"` });
  try {
    const result = await adapter.teardown(user.clientNumber);
    res.json({ ok: true, sourceType, result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
