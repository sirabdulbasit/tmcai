import { Router, Request, Response } from 'express';
import prisma from '../db/prisma';
import {
  upsertPage,
  readPage,
  queryIndex,
  linkPages,
  recordSource,
  PageType,
} from '../services/wiki/wikiStorageService';

const router = Router();

// All wiki endpoints enforce (clientNumber, userId) scope at the service layer.
// Requests authenticate as a specific user; queries are always for THAT user's wiki.
//
// Agents (wiki_scribe) call with the tenant's SA bearer + `X-On-Behalf-Of-User`
// header to operate on a specific user's wiki — this helper resolves the target
// user ID for both human and agent callers.
function resolveTargetUser(req: Request): { clientNumber: string; userId: number } | null {
  const user = (req as any).user;
  if (!user?.clientNumber) return null;
  const onBehalfRaw = req.headers['x-on-behalf-of-user'];
  if (onBehalfRaw) {
    const target = parseInt(Array.isArray(onBehalfRaw) ? onBehalfRaw[0] : String(onBehalfRaw), 10);
    if (Number.isFinite(target) && target > 0) {
      return { clientNumber: user.clientNumber, userId: target };
    }
  }
  if (!user.id) return null;
  return { clientNumber: user.clientNumber, userId: user.id };
}

/**
 * POST /api/v1/wiki/pages — upsert (create or update) a wiki page.
 * Body: { pageType, title, body, confidence?, metadata?, sourceIds?, outboundLinks? }
 */
router.post('/pages', async (req: Request, res: Response) => {
  const ctx = resolveTargetUser(req);
  if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
  const body = req.body ?? {};
  const pageType = body.pageType as PageType | undefined;
  if (!pageType || !body.title || typeof body.body !== 'string') {
    return res.status(400).json({ error: 'pageType, title, body are required' });
  }

  try {
    const result = await upsertPage({
      clientNumber: ctx.clientNumber,
      userId: ctx.userId,
      pageType,
      title: String(body.title),
      body: String(body.body),
      confidence: typeof body.confidence === 'number' ? body.confidence : undefined,
      metadata: body.metadata,
      sourceIds: Array.isArray(body.sourceIds) ? body.sourceIds : undefined,
      actor: body.actor ?? `user:${ctx.userId}`,
    });
    if (Array.isArray(body.outboundLinks)) {
      for (const l of body.outboundLinks) {
        if (!l.toTitle || !l.toPageType) continue;
        const target = await prisma.wikiPage.findFirst({
          where: {
            clientNumber: ctx.clientNumber,
            userId: ctx.userId,
            pageType: l.toPageType,
            title: l.toTitle,
          } as any,
          select: { id: true },
        });
        if (target) {
          await linkPages(ctx.clientNumber, ctx.userId, result.page.id, target.id, l.linkType ?? 'related');
        }
      }
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/pages/:id', async (req: Request, res: Response) => {
  const ctx = resolveTargetUser(req);
  if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
  const page = await readPage(ctx.clientNumber, ctx.userId, String(req.params.id));
  if (!page) return res.status(404).json({ error: 'page not found' });
  res.json(page);
});

router.get('/index', async (req: Request, res: Response) => {
  const ctx = resolveTargetUser(req);
  if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
  const q = String(req.query.q ?? '');
  const limit = Math.min(parseInt(String(req.query.limit ?? '5'), 10) || 5, 25);
  const matches = await queryIndex(ctx.clientNumber, ctx.userId, q, limit);
  res.json({ query: q, matches });
});

router.get('/pages', async (req: Request, res: Response) => {
  const ctx = resolveTargetUser(req);
  if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
  const take = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 200);

  // Visibility — see services/knowledge/wikiScope.ts:
  //   tenant pages are visible to every user in the tenant
  //   user pages are private to the owning user_id
  // The optional `?scope=user|tenant` query param narrows the visible
  // set further (powering the My Wiki / Tenant Wiki tabs in the UI).
  const scopeFilter = String(req.query.scope ?? '');
  const where: any = { clientNumber: ctx.clientNumber };
  if (scopeFilter === 'tenant') {
    where.scope = 'tenant';
  } else if (scopeFilter === 'user') {
    where.scope = 'user';
    where.userId = ctx.userId;
  } else {
    where.OR = [
      { scope: 'tenant' },
      { scope: 'user', userId: ctx.userId },
    ];
  }
  if (req.query.pageType) where.pageType = String(req.query.pageType);
  if (req.query.status) where.status = String(req.query.status);

  const rows = await prisma.wikiPage.findMany({
    where,
    take,
    orderBy: { lastUpdatedAt: 'desc' },
    select: {
      id: true, pageType: true, title: true, status: true, confidence: true,
      inboundLinks: true, outboundLinks: true, sourceCount: true,
      lastUpdatedAt: true, createdAt: true, storage: true,
      scope: true, userId: true,
    },
  });
  res.json({ pages: rows });
});

router.post('/pages/:id/sources', async (req: Request, res: Response) => {
  const ctx = resolveTargetUser(req);
  if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
  const ref = req.body ?? {};
  await recordSource(ctx.clientNumber, ctx.userId, String(req.params.id), {
    feedEventId: ref.feedEventId,
    decisionLogId: ref.decisionLogId,
    openItemId: ref.openItemId,
  });
  res.json({ ok: true });
});

router.post('/links', async (req: Request, res: Response) => {
  const ctx = resolveTargetUser(req);
  if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
  const { fromPageId, toPageId, linkType } = req.body ?? {};
  if (!fromPageId || !toPageId) return res.status(400).json({ error: 'fromPageId + toPageId required' });
  await linkPages(ctx.clientNumber, ctx.userId, String(fromPageId), String(toPageId), linkType ?? 'related');
  res.json({ ok: true });
});

/**
 * POST /api/v1/wiki/index/refresh — rebuild the user's "MyOS Index" page from
 * the current set of wiki_pages rows. wiki_scribe calls this at the end of
 * every ingest.
 */
router.post('/index/refresh', async (req: Request, res: Response) => {
  const ctx = resolveTargetUser(req);
  if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
  try {
    const { refreshIndex } = await import('../services/wiki/wikiIndexLogService');
    await refreshIndex(ctx.clientNumber, ctx.userId);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/v1/wiki/log/append — append an entry to the user's "MyOS Log".
 * Body: { kind: 'ingest'|'query'|'lint', title, details? }
 */
router.post('/log/append', async (req: Request, res: Response) => {
  const ctx = resolveTargetUser(req);
  if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
  const { kind, title, details } = req.body ?? {};
  if (!kind || !title) return res.status(400).json({ error: 'kind + title required' });
  try {
    const { appendToLog } = await import('../services/wiki/wikiIndexLogService');
    await appendToLog(ctx.clientNumber, ctx.userId, { kind, title, details });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', async (req: Request, res: Response) => {
  const ctx = resolveTargetUser(req);
  if (!ctx) return res.status(401).json({ error: 'unauthenticated' });
  const [byType, byStatus, totalSources, totalLinks] = await Promise.all([
    prisma.wikiPage.groupBy({
      by: ['pageType'] as any,
      where: { clientNumber: ctx.clientNumber, userId: ctx.userId } as any,
      _count: { _all: true } as any,
    }),
    prisma.wikiPage.groupBy({
      by: ['status'] as any,
      where: { clientNumber: ctx.clientNumber, userId: ctx.userId } as any,
      _count: { _all: true } as any,
    }),
    (prisma as any).wikiPageSource.count({ where: { clientNumber: ctx.clientNumber, userId: ctx.userId } }),
    (prisma as any).wikiPageLink.count({ where: { clientNumber: ctx.clientNumber, userId: ctx.userId } }),
  ]);
  res.json({
    byType: (byType as any[]).map((r) => ({ key: r.pageType, count: r._count._all })),
    byStatus: (byStatus as any[]).map((r) => ({ key: r.status, count: r._count._all })),
    totalSources,
    totalLinks,
  });
});

export default router;
