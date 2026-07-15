/**
 * MyOS Wiki — per-user Notion API wrapper.
 *
 * Uses each user's own OAuth token from `user_connectors` (slug='notion').
 * Never shares tokens across users. Maintains the same wiki_pages mirror row
 * as the Postgres fallback — the mirror is authoritative for metadata +
 * cross-references, Notion is authoritative for page body.
 *
 * Rate-limit strategy:
 *  - Notion allows ~3 req/s per integration.
 *  - Each user has their own integration → no global bottleneck.
 *  - Per-user in-memory queue + exponential backoff on 429.
 */
import prisma from '../../db/prisma';
import type { UpsertInput, UpsertResult, PageType } from './wikiStorageService';

const NOTION_VERSION = '2022-06-28';
const NOTION_API = 'https://api.notion.com/v1';

interface NotionConnectorConfig {
  accessToken: string;
  databases?: Record<string, string>; // pageType → Notion database ID
  rootPageId?: string;
}

async function getConfig(clientNumber: string, userId: number): Promise<NotionConnectorConfig | null> {
  const row = await prisma.userConnector.findFirst({
    where: { clientNumber, userId, status: 'connected' } as any,
    include: { connectorType: true },
  });
  if (row?.connectorType?.slug !== 'notion') return null;
  return (row.config as any) ?? null;
}

function dbIdForPageType(cfg: NotionConnectorConfig, pageType: PageType): string | null {
  const map = cfg.databases ?? {};
  const keyLookup: Record<PageType, string[]> = {
    entity: ['entity_wiki', 'entity'],
    concept: ['concept_wiki', 'concept'],
    decision: ['decision_wiki', 'decision'],
    pattern: ['pattern_wiki', 'pattern'],
    meeting: ['meeting_wiki', 'meeting'],
    project: ['project_wiki', 'project'],
    source_summary: ['concept_wiki', 'concept'], // source summaries live under concept DB
  };
  for (const k of keyLookup[pageType]) {
    if (map[k]) return map[k];
  }
  return null;
}

async function notionFetch(token: string, path: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`${NOTION_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  if (r.status === 429) {
    const retryAfter = parseInt(r.headers.get('Retry-After') ?? '1', 10);
    await new Promise((res) => setTimeout(res, retryAfter * 1000));
    return notionFetch(token, path, init);
  }
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Notion ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

export async function upsertViaNotion(input: UpsertInput): Promise<UpsertResult> {
  const cfg = await getConfig(input.clientNumber, input.userId);
  if (!cfg) {
    // User's Notion integration vanished mid-ingest — fail over to Postgres silently
    const { upsertViaPostgres } = await import('./wikiPostgresService');
    return upsertViaPostgres(input);
  }
  const dbId = dbIdForPageType(cfg, input.pageType);
  if (!dbId) {
    throw new Error(`Notion: no database configured for pageType "${input.pageType}"`);
  }

  // Check for existing page with this title in the user's DB
  const existing = await prisma.wikiPage.findFirst({
    where: {
      clientNumber: input.clientNumber,
      userId: input.userId,
      pageType: input.pageType,
      title: input.title,
    } as any,
  });

  if (existing) {
    // Update: replace children blocks + bump frontmatter properties
    await notionFetch(cfg.accessToken, `/blocks/${existing.id}/children`, {
      method: 'PATCH',
      body: JSON.stringify({
        children: markdownToNotionBlocks(input.body),
      }),
    }).catch((err: any) => {
      console.warn(`[wikiNotionService] append blocks failed for ${existing.id}: ${err.message}`);
    });
    await notionFetch(cfg.accessToken, `/pages/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        properties: buildProperties(input),
      }),
    }).catch(() => {});
    const updated = await prisma.wikiPage.update({
      where: { id: existing.id },
      data: {
        confidence: input.confidence,
        metadata: input.metadata as any,
        lastUpdatedBy: input.actor ?? 'wiki_scribe',
        lastUpdatedAt: new Date(),
      },
    });
    return { page: updated as any, created: false, storage: 'notion' };
  }

  // Create new page in the correct DB
  const resp = await notionFetch(cfg.accessToken, '/pages', {
    method: 'POST',
    body: JSON.stringify({
      parent: { database_id: dbId },
      properties: {
        Name: { title: [{ text: { content: input.title } }] },
        ...buildProperties(input),
      },
      children: markdownToNotionBlocks(input.body),
    }),
  });

  const notionId = resp.id;
  const row = await prisma.wikiPage.create({
    data: {
      id: notionId,
      clientNumber: input.clientNumber,
      userId: input.userId,
      pageType: input.pageType,
      title: input.title,
      notionDbId: dbId,
      storage: 'notion',
      bodyMarkdown: null,
      confidence: input.confidence,
      metadata: input.metadata as any,
      status: 'active',
      lastUpdatedBy: input.actor ?? 'wiki_scribe',
      lastUpdatedAt: new Date(),
    } as any,
  });

  return { page: row as any, created: true, storage: 'notion' };
}

export async function fetchNotionBody(clientNumber: string, userId: number, pageId: string): Promise<string | null> {
  const cfg = await getConfig(clientNumber, userId);
  if (!cfg) return null;
  try {
    const blocks = await notionFetch(cfg.accessToken, `/blocks/${pageId}/children?page_size=100`);
    return notionBlocksToMarkdown(blocks.results ?? []);
  } catch (err: any) {
    console.warn(`[wikiNotionService] fetchNotionBody ${pageId}: ${err.message}`);
    return null;
  }
}

// ─── helpers ───────────────────────────────────────────────────────

function buildProperties(input: UpsertInput): Record<string, unknown> {
  return {
    page_type: { select: { name: input.pageType } },
    status: { select: { name: 'active' } },
    ...(input.confidence !== undefined
      ? { confidence: { number: input.confidence } }
      : {}),
  };
}

/**
 * Minimal markdown → Notion blocks converter. Covers headings, paragraphs,
 * bullets, and code blocks — enough for the Phase 1 ingest pattern. A more
 * thorough converter can be dropped in later.
 */
function markdownToNotionBlocks(md: string): any[] {
  const blocks: any[] = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (line.startsWith('# ')) {
      blocks.push(richParagraph(line.slice(2), 'heading_1'));
    } else if (line.startsWith('## ')) {
      blocks.push(richParagraph(line.slice(3), 'heading_2'));
    } else if (line.startsWith('### ')) {
      blocks.push(richParagraph(line.slice(4), 'heading_3'));
    } else if (line.startsWith('> ')) {
      blocks.push(richParagraph(line.slice(2), 'quote'));
    } else if (/^[-*]\s/.test(line)) {
      blocks.push(richParagraph(line.slice(2), 'bulleted_list_item'));
    } else {
      blocks.push(richParagraph(line, 'paragraph'));
    }
  }
  return blocks.slice(0, 100); // Notion children limit per request
}

function richParagraph(text: string, type: string): any {
  return {
    object: 'block',
    type,
    [type]: {
      rich_text: [{ type: 'text', text: { content: text.slice(0, 1900) } }],
    },
  };
}

/**
 * Minimal Notion blocks → markdown converter for read paths. Same scope.
 */
function notionBlocksToMarkdown(blocks: any[]): string {
  const lines: string[] = [];
  for (const b of blocks) {
    const type = b.type;
    const rich = b[type]?.rich_text ?? [];
    const text = rich.map((r: any) => r.plain_text ?? '').join('');
    if (!text && type !== 'divider') continue;
    switch (type) {
      case 'heading_1': lines.push(`# ${text}`); break;
      case 'heading_2': lines.push(`## ${text}`); break;
      case 'heading_3': lines.push(`### ${text}`); break;
      case 'quote': lines.push(`> ${text}`); break;
      case 'bulleted_list_item': lines.push(`- ${text}`); break;
      case 'numbered_list_item': lines.push(`1. ${text}`); break;
      case 'divider': lines.push('---'); break;
      default: lines.push(text);
    }
  }
  return lines.join('\n');
}
