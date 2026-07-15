import { Client } from '@notionhq/client';
import { getConfig } from '../configService';

/**
 * HaseebOS v15 INT-3 — Notion connector.
 *
 * Per-tenant creds in SystemConfig:
 *   notion_api_key                — Notion internal integration token
 *   notion_data_source_thoughts   — data source ID (Notion v5 API; for single-data-source DBs this equals the DB ID)
 *
 * Bi-directional Thought Pipeline sync: tmcai pushes thought_entries as
 * Notion pages with a `tmcai_id` property for reverse lookup. A future
 * polling worker (session 8) can read back edits from Notion.
 *
 * Note: the Notion SDK v5 moved `.databases.query()` to `.dataSources.query()`.
 * For databases with a single data source the IDs are the same.
 */

async function getClient(clientNumber: string): Promise<Client> {
  const key = await getConfig(clientNumber, 'notion_api_key');
  if (!key) throw new Error('Notion not configured — set notion_api_key in tenant config');
  return new Client({ auth: key });
}

async function getThoughtsDataSourceId(clientNumber: string): Promise<string> {
  const dsId = await getConfig(clientNumber, 'notion_data_source_thoughts');
  if (!dsId) throw new Error('Notion thoughts data source not configured — set notion_data_source_thoughts');
  return dsId;
}

export interface ThoughtPushInput {
  tmcaiId: string;
  title: string;
  content: string;
  type: string;        // reflection_prompt | weekly_review | strategic_question | pattern_insight | user_note
  status: string;      // draft | published | dismissed | archived
  createdAt: Date;
  tags?: string[];
}

export interface PushResult {
  pageId: string;
  createdNew: boolean;
  url?: string;
}

/**
 * Idempotent push: looks up an existing Notion page by `tmcai_id` property.
 * Creates one if missing, updates otherwise.
 */
export async function pushThought(clientNumber: string, input: ThoughtPushInput): Promise<PushResult> {
  const notion = await getClient(clientNumber);
  const dataSourceId = await getThoughtsDataSourceId(clientNumber);

  // 1) look for existing page with matching tmcai_id
  const existing = await notion.dataSources.query({
    data_source_id: dataSourceId,
    filter: { property: 'tmcai_id', rich_text: { equals: input.tmcaiId } },
    page_size: 1,
  } as any);

  const properties = {
    Title: { title: [{ text: { content: input.title.slice(0, 1900) } }] },
    tmcai_id: { rich_text: [{ text: { content: input.tmcaiId } }] },
    Type: { select: { name: input.type } },
    Status: { select: { name: input.status } },
    CreatedAt: { date: { start: input.createdAt.toISOString() } },
    ...(input.tags ? { Tags: { multi_select: input.tags.map((t) => ({ name: t.slice(0, 100) })) } } : {}),
  } as any;

  if (existing.results.length > 0) {
    const pageId = existing.results[0].id;
    await notion.pages.update({ page_id: pageId, properties });
    // Replace children content
    const children = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });
    for (const c of children.results) {
      await notion.blocks.delete({ block_id: c.id }).catch(() => {});
    }
    await appendContent(notion, pageId, input.content);
    return { pageId, createdNew: false };
  }

  const created = await notion.pages.create({
    parent: { data_source_id: dataSourceId } as any,
    properties,
  });
  await appendContent(notion, created.id, input.content);
  return { pageId: created.id, createdNew: true, url: (created as any).url };
}

async function appendContent(notion: Client, pageId: string, content: string): Promise<void> {
  // Notion blocks have a 2000-char text limit. Split into paragraphs.
  const chunks = content.match(/[\s\S]{1,1900}/g) ?? [content];
  await notion.blocks.children.append({
    block_id: pageId,
    children: chunks.map((chunk) => ({
      object: 'block' as const,
      type: 'paragraph' as const,
      paragraph: { rich_text: [{ type: 'text' as const, text: { content: chunk } }] },
    })),
  });
}

export async function healthCheck(clientNumber: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const notion = await getClient(clientNumber);
    const dataSourceId = await getThoughtsDataSourceId(clientNumber);
    await notion.dataSources.retrieve({ data_source_id: dataSourceId });
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
}

export interface NotionPageSnapshot {
  pageId: string;
  tmcaiId: string | null;
  title: string | null;
  status: string | null;
  lastEditedAt: Date;
  properties: Record<string, unknown>;
}

/**
 * Query for pages in the thoughts data source that were edited since `since`.
 * Used by the reverse-sync worker to pull Notion-side edits back into ThoughtEntry.
 */
export async function listEditedSince(clientNumber: string, since: Date): Promise<NotionPageSnapshot[]> {
  const notion = await getClient(clientNumber);
  const dataSourceId = await getThoughtsDataSourceId(clientNumber);
  const out: NotionPageSnapshot[] = [];
  let cursor: string | undefined = undefined;
  do {
    const page: any = await notion.dataSources.query({
      data_source_id: dataSourceId,
      filter: { timestamp: 'last_edited_time', last_edited_time: { on_or_after: since.toISOString() } },
      sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
      start_cursor: cursor,
      page_size: 100,
    } as any);
    for (const r of page.results) {
      const props = (r as any).properties ?? {};
      const tmcaiId = extractRichText(props.tmcai_id);
      const title = extractTitle(props.Title ?? props.Name);
      const status = (props.Status?.select?.name as string | undefined) ?? null;
      out.push({
        pageId: r.id,
        tmcaiId,
        title,
        status,
        lastEditedAt: new Date((r as any).last_edited_time ?? Date.now()),
        properties: props,
      });
    }
    cursor = page.next_cursor ?? undefined;
  } while (cursor);
  return out;
}

/**
 * Fetch full page content (concatenated paragraph/heading/list blocks).
 */
export async function fetchPageContent(clientNumber: string, pageId: string): Promise<string> {
  const notion = await getClient(clientNumber);
  const blocks = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });
  const lines: string[] = [];
  for (const block of blocks.results) {
    const b = block as any;
    if (b.type === 'paragraph' && Array.isArray(b.paragraph?.rich_text)) {
      lines.push(b.paragraph.rich_text.map((t: any) => t.plain_text ?? '').join(''));
    } else if (b.type === 'heading_1' || b.type === 'heading_2' || b.type === 'heading_3') {
      const rt = b[b.type]?.rich_text ?? [];
      lines.push(rt.map((t: any) => t.plain_text ?? '').join(''));
    } else if (b.type === 'bulleted_list_item' || b.type === 'numbered_list_item') {
      const rt = b[b.type]?.rich_text ?? [];
      lines.push(`- ${rt.map((t: any) => t.plain_text ?? '').join('')}`);
    }
  }
  return lines.filter(Boolean).join('\n\n');
}

function extractRichText(prop: any): string | null {
  if (!prop?.rich_text) return null;
  const rt = Array.isArray(prop.rich_text) ? prop.rich_text : [];
  return rt.map((t: any) => t.plain_text ?? '').join('') || null;
}

function extractTitle(prop: any): string | null {
  if (!prop?.title) return null;
  const rt = Array.isArray(prop.title) ? prop.title : [];
  return rt.map((t: any) => t.plain_text ?? '').join('') || null;
}
