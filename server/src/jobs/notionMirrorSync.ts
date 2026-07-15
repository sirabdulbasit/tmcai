/**
 * MyOS — Notion Mirror Sync.
 *
 * Pushes Postgres-backed wiki_pages to the user's Notion workspace
 * (if they have a connected Notion connector). Runs every 10 min.
 *
 * Gracefully no-ops when:
 *   - The user has no Notion connector connected (status != 'connected'),
 *   - Or the connector config lacks a valid accessToken.
 *
 * Sync strategy:
 *   - Walk wiki_pages with storage='postgres', lastUpdatedAt > last_sync.
 *   - For each, call upsertViaNotion (existing helper handles page mapping).
 *   - On success, re-tag page storage='notion' so subsequent writes go to
 *     Notion directly.
 *   - Failures logged and retried on next tick — no hard failure.
 */
import prisma from '../db/prisma';
import { upsertViaNotion } from '../services/wiki/wikiNotionService';

export interface NotionMirrorResult {
  userId: number;
  clientNumber: string;
  pushed: number;
  skipped: number;
  errors: number;
  durationMs: number;
}

export async function mirrorAllTenants(): Promise<NotionMirrorResult[]> {
  const t0All = Date.now();

  // Find every user with a connected Notion connector
  const connectors = await prisma.userConnector.findMany({
    where: { status: 'connected' },
    include: { connectorType: true },
  });
  const notionConnectors = connectors.filter((c) => c.connectorType.slug === 'notion' || c.connectorType.slug === 'notion_personal');
  if (notionConnectors.length === 0) return [];

  const results: NotionMirrorResult[] = [];
  for (const uc of notionConnectors) {
    const t0 = Date.now();
    const res: NotionMirrorResult = { userId: uc.userId, clientNumber: uc.clientNumber, pushed: 0, skipped: 0, errors: 0, durationMs: 0 };

    const cfg = (uc.config as any) ?? {};
    if (!cfg?.accessToken || String(cfg.accessToken).startsWith('REPLACE_')) {
      // No real token — can't push. Skip quietly.
      res.skipped = -1;
      results.push(res);
      continue;
    }

    // Pages needing push: postgres-backed, for this user, updated since last sync
    const pages = await prisma.wikiPage.findMany({
      where: {
        clientNumber: uc.clientNumber,
        userId: uc.userId,
        storage: 'postgres',
        status: { in: ['active', 'stale', 'contradicted'] },
      },
      orderBy: { lastUpdatedAt: 'desc' },
      take: 25,
      select: { id: true, title: true, pageType: true, bodyMarkdown: true, metadata: true },
    });

    for (const p of pages) {
      try {
        const r: any = await upsertViaNotion({
          clientNumber: uc.clientNumber,
          userId: uc.userId,
          pageType: p.pageType as any,
          title: p.title,
          body: p.bodyMarkdown ?? '',
          actor: 'notion_mirror',
        } as any);
        if (r?.page?.id) {
          res.pushed += 1;
          // Flip storage to 'notion'; id stays (upsertViaNotion handled the
          // wiki_pages row internally).
          await prisma.wikiPage.update({
            where: { id: p.id },
            data: { storage: 'notion', lastUpdatedBy: 'notion_mirror' } as any,
          }).catch(() => {});
        } else {
          res.errors += 1;
        }
      } catch (err: any) {
        res.errors += 1;
        console.warn(`[notionMirror] page=${p.id} failed: ${err.message}`);
      }
    }
    res.durationMs = Date.now() - t0;
    results.push(res);
  }

  if (results.length > 0) {
    const total = results.reduce((s, r) => s + r.pushed, 0);
    console.log(`[notionMirror] users=${results.length} pushed=${total} ${Date.now() - t0All}ms`);
  }
  return results;
}
