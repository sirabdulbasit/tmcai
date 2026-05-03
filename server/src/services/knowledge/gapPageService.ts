/**
 * Honesty rule H2: when Brain can't answer from opened pages, the missing
 * topic becomes a first-class `gap` wiki page so next week's Brain sees
 * the hole instead of re-bluffing the answer.
 *
 * Gap pages are deduped by a normalized title — repeat asks bump the hit
 * count in metadata instead of creating duplicates.
 */
import prisma from '../../db/prisma';
import { BRAIN_SCHEMA_VERSION } from './brainSchema';

export async function recordGaps(
  clientNumber: string,
  userId: number,
  gaps: string[],
  triggeringQuestion: string,
): Promise<string[]> {
  const createdOrBumped: string[] = [];
  for (const raw of gaps) {
    const phrase = String(raw).trim();
    if (!phrase) continue;
    const title = `gap: ${phrase.slice(0, 240)}`;

    const existing = await prisma.wikiPage.findFirst({
      where: { clientNumber, userId, pageType: 'gap', title },
      select: { id: true, bodyMarkdown: true, metadata: true },
    }).catch(() => null);

    const now = new Date();
    if (existing) {
      const meta: any = existing.metadata ?? {};
      meta.hitCount = (meta.hitCount ?? 1) + 1;
      meta.lastAskedAt = now.toISOString();
      meta.lastAskedQuestion = triggeringQuestion.slice(0, 240);
      const newBody =
        (existing.bodyMarkdown ?? '') +
        `\n- Asked again ${meta.lastAskedAt.slice(0, 16)} — "${meta.lastAskedQuestion}"`;
      await prisma.wikiPage.update({
        where: { id: existing.id },
        data: { bodyMarkdown: newBody, metadata: meta, lastUpdatedAt: now, lastUpdatedBy: 'brain_composer' },
      }).catch(() => {});
      createdOrBumped.push(existing.id);
    } else {
      const body = [
        `# ${title}`,
        '',
        `**Gap first noticed:** ${now.toISOString().slice(0, 16)}`,
        `**Triggering question:** "${triggeringQuestion.slice(0, 240)}"`,
        '',
        `This page was filed automatically because Brain couldn't answer the above question from its currently opened wiki pages. Fill this gap by:`,
        `- connecting the source system that holds this data, or`,
        `- scribing a document that captures it into FACL, or`,
        `- answering the question once manually so it becomes an \`answer\` page for next time.`,
        '',
        `## Related`,
        `- Ask log: see tenant_log`,
      ].join('\n');
      const created = await prisma.wikiPage.create({
        data: {
          clientNumber, userId, pageType: 'gap', title,
          bodyMarkdown: body,
          metadata: {
            schemaVersion: BRAIN_SCHEMA_VERSION,
            scope: 'user',
            authoredBy: 'brain_composer',
            hitCount: 1,
            firstAskedAt: now.toISOString(),
            lastAskedAt: now.toISOString(),
            lastAskedQuestion: triggeringQuestion.slice(0, 240),
          },
          storage: 'postgres', status: 'active', lastUpdatedBy: 'brain_composer',
        },
      }).catch(() => null);
      if (created?.id) {
        createdOrBumped.push(created.id);
        // Embed the gap so future questions about the same missing data
        // find and re-trigger this gap page.
        void (async () => {
          try {
            const { embedWikiPage } = await import('./wikiEmbeddingService');
            await embedWikiPage(created.id);
          } catch { /* best effort */ }
        })();
      }
    }
  }
  return createdOrBumped;
}
