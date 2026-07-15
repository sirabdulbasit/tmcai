/**
 * Phase D — answer pages.
 *
 * When Brain composes a useful answer (factual/introspective intent with
 * at least one citation), we file the answer back as a wiki_page of type
 * `answer` so next time the same or a similar question is asked, the
 * planner can reuse the filed answer instead of re-deriving.
 *
 * Dedup key: (clientNumber, userId, 'answer', title) where title is the
 * question, truncated. Similar questions collide via title-normalization
 * (lowercase, collapse whitespace, strip punctuation). This is crude but
 * sufficient to catch the obvious repeats; fuzzy-dedup via pg_trgm can
 * follow in a later pass.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { BRAIN_SCHEMA_VERSION } from './brainSchema';

const log = createLogger('answer-page');

export interface FileAnswerParams {
  clientNumber: string;
  userId: number;
  question: string;
  answer: string;
  intent: string;
  citedPageIds: string[];
}

export async function fileAnswer(p: FileAnswerParams): Promise<string | null> {
  if (p.intent === 'casual' || p.citedPageIds.length === 0) return null;
  if (p.answer.length < 40) return null;           // trivial responses aren't worth filing
  if (p.answer.length > 8000) return null;          // overly long — unlikely reusable

  const title = normalizeTitle(p.question);
  if (!title) return null;
  const now = new Date();

  try {
    const existing = await prisma.wikiPage.findFirst({
      where: { clientNumber: p.clientNumber, userId: p.userId, pageType: 'answer', title },
      select: { id: true, metadata: true },
    });
    const body = renderAnswer(p, now);
    const metadata = {
      schemaVersion: BRAIN_SCHEMA_VERSION,
      scope: 'user',
      authoredBy: 'brain_composer',
      originalQuestion: p.question.slice(0, 400),
      intent: p.intent,
      citedPageIds: p.citedPageIds,
      hitCount: existing ? ((existing.metadata as any)?.hitCount ?? 1) + 1 : 1,
      lastAskedAt: now.toISOString(),
    };

    let pageId: string;
    if (existing) {
      await prisma.wikiPage.update({
        where: { id: existing.id },
        data: { bodyMarkdown: body, metadata, lastUpdatedAt: now, lastUpdatedBy: 'brain_composer', status: 'active' },
      });
      pageId = existing.id;
    } else {
      const created = await prisma.wikiPage.create({
        data: {
          clientNumber: p.clientNumber, userId: p.userId,
          pageType: 'answer', title,
          bodyMarkdown: body,
          metadata,
          storage: 'postgres',
          status: 'active',
          sourceCount: p.citedPageIds.length,
          lastUpdatedBy: 'brain_composer',
        },
      });
      pageId = created.id;
    }

    // Embed — so repeat questions hit this answer via semantic similarity.
    void (async () => {
      try {
        const { embedWikiPage } = await import('./wikiEmbeddingService');
        await embedWikiPage(pageId);
      } catch { /* best effort */ }
    })();

    // Graph: link answer → each cited source. Synthetic IDs used by the
    // composer (e.g. `entity:xxx` for rows from the entities table) have
    // no matching wiki_pages row and would violate the FK — filter them.
    for (const toId of p.citedPageIds) {
      if (typeof toId !== 'string' || toId.includes(':')) continue;
      await prisma.wikiPageLink.upsert({
        where: { fromPageId_toPageId_linkType: { fromPageId: pageId, toPageId: toId, linkType: 'related' } } as any,
        update: {},
        create: {
          clientNumber: p.clientNumber, userId: p.userId,
          fromPageId: pageId, toPageId: toId, linkType: 'related',
        },
      }).catch(() => {});
    }
    return pageId;
  } catch (err: any) {
    log.warn('answer page file failed', { error: err.message });
    return null;
  }
}

function normalizeTitle(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function renderAnswer(p: FileAnswerParams, now: Date): string {
  return [
    `# ${p.question.slice(0, 240)}`,
    '',
    `**Answered:** ${now.toISOString().slice(0, 16).replace('T', ' ')}`,
    `**Intent:** ${p.intent}`,
    '',
    '## Answer',
    p.answer,
    '',
    `## Sourced from`,
    ...p.citedPageIds.map((id) => `- \`${id}\``),
  ].join('\n');
}
