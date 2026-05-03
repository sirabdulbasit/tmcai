/**
 * MyOS Wiki — per-user "MyOS Index" and "MyOS Log" maintenance.
 *
 * Index is content-oriented (catalog of pages). Log is chronological.
 * Both live in the user's own backing storage (Notion page or Postgres markdown).
 * Re-rendered on every ingest via `refreshIndexAndLog(clientNumber, userId)`.
 *
 * Called from wiki_scribe's `append_to_index` and `append_to_log` tools,
 * surfaced via POST /api/v1/wiki/index/refresh and /wiki/log/append.
 */
import prisma from '../../db/prisma';
import { upsertPage } from './wikiStorageService';

const INDEX_TITLE = 'MyOS Index';
const LOG_TITLE = 'MyOS Log';

export async function refreshIndex(clientNumber: string, userId: number): Promise<void> {
  const pages = await prisma.wikiPage.findMany({
    where: {
      clientNumber,
      userId,
      status: { not: 'stale' },
      title: { notIn: [INDEX_TITLE, LOG_TITLE] },
    } as any,
    select: { id: true, title: true, pageType: true, lastUpdatedAt: true, sourceCount: true },
    orderBy: { lastUpdatedAt: 'desc' },
  });

  const byType = pages.reduce<Record<string, typeof pages>>((acc, p) => {
    const k = p.pageType;
    acc[k] = acc[k] ?? [];
    acc[k].push(p);
    return acc;
  }, {});

  const sections = [
    '# MyOS Index',
    '',
    `> Auto-maintained catalog of every page in your wiki. Updated on every ingest.`,
    `> Last refreshed: ${new Date().toISOString()}.`,
    `> Total pages: ${pages.length}`,
    '',
  ];

  const order = ['entity', 'concept', 'decision', 'pattern', 'project', 'meeting', 'source_summary'];
  for (const t of order) {
    const rows = byType[t] ?? [];
    if (rows.length === 0) continue;
    sections.push(`## ${t.charAt(0).toUpperCase() + t.slice(1).replace('_', ' ')} (${rows.length})`);
    for (const r of rows) {
      const sources = r.sourceCount > 0 ? ` · ${r.sourceCount} source${r.sourceCount > 1 ? 's' : ''}` : '';
      sections.push(`- [[${r.title}]]${sources}`);
    }
    sections.push('');
  }

  await upsertPage({
    clientNumber,
    userId,
    pageType: 'concept',
    title: INDEX_TITLE,
    body: sections.join('\n'),
    confidence: 1.0,
    actor: 'wiki_index',
    metadata: { generated: true, pageCount: pages.length },
  });
}

export async function appendToLog(
  clientNumber: string,
  userId: number,
  entry: { kind: 'ingest' | 'query' | 'lint'; title: string; details?: string },
): Promise<void> {
  const existing = await prisma.wikiPage.findFirst({
    where: {
      clientNumber,
      userId,
      pageType: 'concept',
      title: LOG_TITLE,
    } as any,
  });

  const ts = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const newLine = `## [${ts}] ${entry.kind} | ${entry.title.slice(0, 120)}`;
  const detailLine = entry.details ? `\n${entry.details.slice(0, 400)}\n` : '\n';

  const prior = existing?.bodyMarkdown ?? '';
  const header = prior.startsWith('# MyOS Log')
    ? ''
    : '# MyOS Log\n\n> Append-only chronicle of every ingest, query, and lint pass.\n\n';

  const updated = `${header}${prior ? prior + '\n' : ''}${newLine}${detailLine}`;

  // Trim to last 500 entries (~200 KB) to keep page size bounded
  const blocks = updated.split(/(?=^## \[)/m);
  const trimmed = blocks.length > 500
    ? [blocks[0], ...blocks.slice(blocks.length - 499)].join('')
    : updated;

  await upsertPage({
    clientNumber,
    userId,
    pageType: 'concept',
    title: LOG_TITLE,
    body: trimmed,
    confidence: 1.0,
    actor: 'wiki_log',
    metadata: { generated: true, entryCount: blocks.length },
  });
}
