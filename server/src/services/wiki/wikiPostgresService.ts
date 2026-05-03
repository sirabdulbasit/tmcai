/**
 * MyOS Wiki — Postgres markdown fallback.
 *
 * For users without a connected Notion workspace. Stores the full markdown
 * body inside wiki_pages.body_markdown. Notion DB ID is null; the storage
 * column is 'postgres'.
 */
import prisma from '../../db/prisma';
import type { UpsertInput, UpsertResult } from './wikiStorageService';

export async function upsertViaPostgres(input: UpsertInput): Promise<UpsertResult> {
  const existing = await prisma.wikiPage.findFirst({
    where: {
      clientNumber: input.clientNumber,
      userId: input.userId,
      pageType: input.pageType,
      title: input.title,
    } as any,
  });

  const data = {
    clientNumber: input.clientNumber,
    userId: input.userId,
    pageType: input.pageType,
    title: input.title,
    storage: 'postgres',
    bodyMarkdown: input.body,
    confidence: input.confidence,
    metadata: (input.metadata ?? {}) as any,
    lastUpdatedBy: input.actor ?? 'wiki_scribe',
    lastUpdatedAt: new Date(),
  };

  let page;
  let created = false;
  if (existing) {
    page = await prisma.wikiPage.update({
      where: { id: existing.id },
      data,
    });
  } else {
    created = true;
    page = await prisma.wikiPage.create({
      data: { ...data, status: 'active' } as any,
    });
  }

  // Record source lineage
  if (input.sourceIds && input.sourceIds.length > 0) {
    for (const ref of input.sourceIds) {
      await (prisma as any).wikiPageSource.create({
        data: {
          wikiPageId: page.id,
          clientNumber: input.clientNumber,
          userId: input.userId,
          feedEventId: ref.feedEventId,
          decisionLogId: ref.decisionLogId,
          openItemId: ref.openItemId,
        },
      }).catch(() => {});
    }
    await prisma.$executeRawUnsafe(
      `UPDATE wiki_pages SET source_count = (
        SELECT COUNT(*) FROM wiki_page_sources WHERE wiki_page_id = wiki_pages.id
      ) WHERE id = $1`,
      page.id,
    );
  }

  return { page: page as any, created, storage: 'postgres' };
}

export async function fetchPostgresBody(pageId: string): Promise<string | null> {
  const row = await prisma.wikiPage.findUnique({ where: { id: pageId } });
  return row?.bodyMarkdown ?? null;
}
