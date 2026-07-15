/**
 * MyOS Wiki — storage-agnostic facade.
 *
 * Routes wiki reads/writes to the correct backend for a given user:
 *   - Notion (when user_connectors has a connected 'notion' row)
 *   - Postgres markdown fallback (otherwise)
 *
 * All tools in wiki_scribe + wiki REST routes call this module; they never
 * talk to Notion or Postgres directly. Enforces the tenant + user isolation
 * rule stated in SCHEMA.md.
 */
import prisma from '../../db/prisma';

export type PageType =
  | 'entity'
  | 'concept'
  | 'decision'
  | 'pattern'
  | 'meeting'
  | 'project'
  | 'source_summary';

export interface WikiPage {
  id: string;
  clientNumber: string;
  userId: number;
  pageType: PageType;
  title: string;
  notionDbId: string | null;
  storage: 'notion' | 'postgres';
  bodyMarkdown: string | null;
  inboundLinks: number;
  outboundLinks: number;
  sourceCount: number;
  status: string;
  confidence: number | null;
  metadata: Record<string, unknown> | null;
  lastUpdatedBy: string | null;
  lastUpdatedAt: Date;
  createdAt: Date;
}

export interface UpsertInput {
  clientNumber: string;
  userId: number;
  pageType: PageType;
  title: string;
  body: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
  sourceIds?: { feedEventId?: string; decisionLogId?: string; openItemId?: string }[];
  outboundLinks?: Array<{ toTitle: string; toPageType: PageType; linkType?: string }>;
  actor?: string;
}

export interface UpsertResult {
  page: WikiPage;
  created: boolean;
  storage: 'notion' | 'postgres';
}

/**
 * Returns true if the user has a connected Notion integration.
 * Reads user_connectors + connector_types — falls back to 'postgres' storage
 * if either the connector row is missing or the status is not 'connected'.
 */
export async function chooseStorage(clientNumber: string, userId: number): Promise<'notion' | 'postgres'> {
  try {
    const row = await prisma.userConnector.findFirst({
      where: { clientNumber, userId, status: 'connected' } as any,
      include: { connectorType: true },
    });
    if (row?.connectorType?.slug === 'notion') return 'notion';
  } catch { /* fall through */ }
  return 'postgres';
}

export async function upsertPage(input: UpsertInput): Promise<UpsertResult> {
  const storage = await chooseStorage(input.clientNumber, input.userId);
  if (storage === 'notion') {
    const { upsertViaNotion } = await import('./wikiNotionService');
    return upsertViaNotion(input);
  }
  const { upsertViaPostgres } = await import('./wikiPostgresService');
  return upsertViaPostgres(input);
}

export async function readPage(clientNumber: string, userId: number, pageId: string): Promise<WikiPage | null> {
  // Visibility: tenant-scoped pages are readable by anyone in the
  // tenant; user-scoped only by their owner. See wikiScope.ts.
  const row = await prisma.wikiPage.findFirst({
    where: {
      id: pageId, clientNumber,
      OR: [
        { scope: 'tenant' },
        { scope: 'user', userId },
      ],
    } as any,
  });
  if (!row) return null;
  if (row.storage === 'notion' && !row.bodyMarkdown) {
    // Pull fresh body from Notion — mirror lives only in metadata for notion-backed pages
    const { fetchNotionBody } = await import('./wikiNotionService');
    const body = await fetchNotionBody(clientNumber, userId, pageId);
    return { ...(row as any), bodyMarkdown: body };
  }
  return row as any;
}

export async function queryIndex(
  clientNumber: string,
  userId: number,
  question: string,
  limit = 5,
): Promise<Array<{ id: string; title: string; pageType: PageType; summary: string }>> {
  // Minimal first-pass: title-word overlap scoring against the user's pages.
  // Phase 3 will replace this with pgvector similarity + Notion search.
  const tokens = question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [];
  const allPages = await prisma.wikiPage.findMany({
    where: { clientNumber, userId, status: { not: 'stale' } } as any,
    select: { id: true, title: true, pageType: true, metadata: true },
    take: 500,
    orderBy: { lastUpdatedAt: 'desc' },
  });
  const scored = allPages.map((p) => {
    const titleLower = p.title.toLowerCase();
    const score = tokens.reduce((s, t) => s + (titleLower.includes(t) ? 1 : 0), 0);
    return { ...p, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((p) => ({
    id: p.id,
    title: p.title,
    pageType: p.pageType as PageType,
    summary: ((p.metadata as any)?.summary as string) ?? '',
  }));
}

export async function linkPages(
  clientNumber: string,
  userId: number,
  fromPageId: string,
  toPageId: string,
  linkType: 'related' | 'supersedes' | 'contradicts' | 'parent' | 'child' = 'related',
): Promise<void> {
  await (prisma as any).wikiPageLink.upsert({
    where: {
      fromPageId_toPageId_linkType: { fromPageId, toPageId, linkType },
    },
    update: {},
    create: { clientNumber, userId, fromPageId, toPageId, linkType },
  }).catch(async () => {
    // Fallback: composite unique may not exist yet as a named Prisma index
    await prisma.$executeRawUnsafe(
      `INSERT INTO wiki_page_links (client_number, user_id, from_page_id, to_page_id, link_type)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (from_page_id, to_page_id, link_type) DO NOTHING`,
      clientNumber, userId, fromPageId, toPageId, linkType,
    );
  });
  // Recompute link counts cheaply
  await prisma.$executeRawUnsafe(
    `UPDATE wiki_pages SET outbound_links = (
        SELECT COUNT(*) FROM wiki_page_links WHERE from_page_id = wiki_pages.id
      ) WHERE id = $1`,
    fromPageId,
  );
  await prisma.$executeRawUnsafe(
    `UPDATE wiki_pages SET inbound_links = (
        SELECT COUNT(*) FROM wiki_page_links WHERE to_page_id = wiki_pages.id
      ) WHERE id = $1`,
    toPageId,
  );
}

export async function recordSource(
  clientNumber: string,
  userId: number,
  wikiPageId: string,
  ref: { feedEventId?: string; decisionLogId?: string; openItemId?: string },
): Promise<void> {
  await (prisma as any).wikiPageSource.create({
    data: {
      clientNumber,
      userId,
      wikiPageId,
      feedEventId: ref.feedEventId,
      decisionLogId: ref.decisionLogId,
      openItemId: ref.openItemId,
    },
  }).catch(() => {});
  await prisma.$executeRawUnsafe(
    `UPDATE wiki_pages SET source_count = (
        SELECT COUNT(*) FROM wiki_page_sources WHERE wiki_page_id = wiki_pages.id
      ) WHERE id = $1`,
    wikiPageId,
  );
}
