/**
 * Phase C — Ingest propagation.
 *
 * When a feed_event lands, sender_history + sender_topic + entity pages
 * are already updated by their respective services. This service
 * propagates a new source to OTHER relevant pages:
 *
 *   - `project` wiki pages   — extracted from subject/snippet by Flash
 *   - `policy` wiki pages    — touched when the content references a known policy
 *   - `wiki_page_links` rows — so the graph reflects the new reference
 *
 * Cheap and bounded:
 *   - One Flash call per ingest (≈300 ms, cost negligible on Gemini Flash).
 *   - Fire-and-forget from the ingest path.
 *   - No-op if content is empty / snippet-less.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { callLLM } from '../llmRouter';
import { BRAIN_SCHEMA_VERSION } from './brainSchema';

const log = createLogger('propagation');

interface PropagateParams {
  clientNumber: string;
  userId: number;
  feedEventId: string;
  sourceType: string;
  subject?: string | null;
  snippet?: string | null;
  senderEmail?: string | null;
  senderName?: string | null;
  receivedAt: Date;
}

/**
 * Extract project/policy references using Flash and upsert matching wiki
 * pages. Pages are tenant-shared (scoped to the tenant, readable by all
 * users) so Basit's ingest can grow a project page that Abdul's Brain
 * can also see.
 */
export async function propagateFeedEvent(p: PropagateParams): Promise<void> {
  const text = `${p.subject ?? ''}\n${p.snippet ?? ''}`.trim();
  if (text.length < 20) return;

  const extract = await llmExtract(text, p.clientNumber, p.userId);
  if (!extract) return;

  const now = new Date();
  const touchedIds: string[] = [];

  for (const name of extract.projects) {
    const id = await upsertProject(p.clientNumber, name, p, now);
    if (id) touchedIds.push(id);
  }
  for (const name of extract.policies) {
    const id = await upsertPolicy(p.clientNumber, name, p, now);
    if (id) touchedIds.push(id);
  }

  // Link from the sender's page (user-scoped) to each propagated page
  // so the graph reflects the new reference.
  if (touchedIds.length > 0 && p.senderEmail) {
    const senderPage = await prisma.wikiPage.findFirst({
      where: { clientNumber: p.clientNumber, userId: p.userId, pageType: 'sender_history', title: p.senderEmail },
      select: { id: true },
    }).catch(() => null);
    if (senderPage) {
      for (const toId of touchedIds) {
        await prisma.wikiPageLink.upsert({
          where: { fromPageId_toPageId_linkType: { fromPageId: senderPage.id, toPageId: toId, linkType: 'related' } } as any,
          update: {},
          create: {
            clientNumber: p.clientNumber, userId: p.userId,
            fromPageId: senderPage.id, toPageId: toId, linkType: 'related',
          },
        }).catch(() => {});
      }
    }
  }
}

async function llmExtract(
  text: string,
  clientNumber: string,
  userId: number,
): Promise<{ projects: string[]; policies: string[] } | null> {
  const sys = `You are an information-extraction pass. Read the email/message excerpt and identify:
- project_names: specific named projects, initiatives, deals, or implementations mentioned (e.g. "Voyage AI", "Pak Railways ERP", "PGC SAP"). Proper noun + action only — NOT generic phrases like "the project" or "sales pipeline".
- policy_names: specific policies, SOPs, or rules referenced by name (e.g. "TMC Pricing Policy", "Leave Policy").
If none, return empty arrays. Output JSON only, no prose.
Shape: {"projects":[string],"policies":[string]}`;
  try {
    const r = await callLLM(sys, text.slice(0, 2000), {
      maxTokens: 256,
      providers: ['gemini-flash', 'gemini', 'claude'],
      userId, clientNumber, purpose: 'propagation_extract',
    });
    const match = r.text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const obj = JSON.parse(match[0]);
    const projects = Array.isArray(obj.projects) ? obj.projects.filter((x: unknown) => typeof x === 'string').slice(0, 4).map((s: string) => s.trim()).filter(Boolean) : [];
    const policies = Array.isArray(obj.policies) ? obj.policies.filter((x: unknown) => typeof x === 'string').slice(0, 4).map((s: string) => s.trim()).filter(Boolean) : [];
    return { projects, policies };
  } catch (err: any) {
    log.warn('llmExtract failed', { error: err.message });
    return null;
  }
}

async function upsertProject(
  clientNumber: string,
  name: string,
  p: PropagateParams,
  now: Date,
): Promise<string | null> {
  try {
    const existing = await prisma.wikiPage.findFirst({
      where: { clientNumber, pageType: 'project', title: name },
      select: { id: true, bodyMarkdown: true, metadata: true, sourceCount: true },
    });
    const newBullet = `- ${now.toISOString().slice(0, 10)} · ${p.sourceType} · ${p.senderEmail ?? 'system'}${p.subject ? ` · ${p.subject.slice(0, 120)}` : ''}`;
    if (existing) {
      const body = (existing.bodyMarkdown ?? '') + '\n' + newBullet;
      await prisma.wikiPage.update({
        where: { id: existing.id },
        data: {
          bodyMarkdown: body.slice(0, 40_000),
          sourceCount: { increment: 1 },
          lastUpdatedAt: now,
          lastUpdatedBy: 'propagation',
        },
      });
      void (async () => {
        try {
          const { embedWikiPage } = await import('./wikiEmbeddingService');
          await embedWikiPage(existing.id);
        } catch { /* best effort */ }
      })();
      return existing.id;
    }
    const created = await prisma.wikiPage.create({
      data: {
        clientNumber, userId: p.userId,
        pageType: 'project', title: name.slice(0, 300),
        bodyMarkdown: `# ${name}\n\n**First seen:** ${now.toISOString().slice(0, 16)}\n**First source:** ${p.sourceType} from ${p.senderEmail ?? 'system'}\n\n## Mentions\n${newBullet}`,
        metadata: {
          schemaVersion: BRAIN_SCHEMA_VERSION,
          scope: 'tenant',
          authoredBy: 'propagation',
          firstSeenAt: now.toISOString(),
        },
        storage: 'postgres',
        status: 'active',
        sourceCount: 1,
        lastUpdatedBy: 'propagation',
      },
    });
    // Embed for semantic retrieval + schedule topic concept synthesis.
    void (async () => {
      try {
        const { embedWikiPage } = await import('./wikiEmbeddingService');
        await embedWikiPage(created.id);
        const { enqueueSynthesis } = await import('./conceptSynthesizerService');
        enqueueSynthesis({ clientNumber, kind: 'topic', id: name });
      } catch { /* best effort */ }
    })();
    return created.id;
  } catch (err: any) {
    log.warn('project upsert failed', { name, error: err.message });
    return null;
  }
}

async function upsertPolicy(
  clientNumber: string,
  name: string,
  p: PropagateParams,
  now: Date,
): Promise<string | null> {
  try {
    const existing = await prisma.wikiPage.findFirst({
      where: { clientNumber, pageType: 'policy', title: name },
      select: { id: true, bodyMarkdown: true, sourceCount: true },
    });
    const newBullet = `- ${now.toISOString().slice(0, 10)} · referenced by ${p.senderEmail ?? p.sourceType}${p.subject ? ` (${p.subject.slice(0, 120)})` : ''}`;
    if (existing) {
      const body = (existing.bodyMarkdown ?? '') + '\n' + newBullet;
      await prisma.wikiPage.update({
        where: { id: existing.id },
        data: {
          bodyMarkdown: body.slice(0, 40_000),
          sourceCount: { increment: 1 },
          lastUpdatedAt: now,
          lastUpdatedBy: 'propagation',
        },
      });
      void (async () => {
        try {
          const { embedWikiPage } = await import('./wikiEmbeddingService');
          await embedWikiPage(existing.id);
        } catch { /* best effort */ }
      })();
      return existing.id;
    }
    const created = await prisma.wikiPage.create({
      data: {
        clientNumber, userId: p.userId,
        pageType: 'policy', title: name.slice(0, 300),
        bodyMarkdown: `# ${name}\n\n**First referenced:** ${now.toISOString().slice(0, 16)}\n\n## References\n${newBullet}`,
        metadata: {
          schemaVersion: BRAIN_SCHEMA_VERSION,
          scope: 'tenant',
          authoredBy: 'propagation',
        },
        storage: 'postgres',
        status: 'active',
        sourceCount: 1,
        lastUpdatedBy: 'propagation',
      },
    });
    // Embed for semantic retrieval — fire-and-forget.
    void (async () => {
      try {
        const { embedWikiPage } = await import('./wikiEmbeddingService');
        await embedWikiPage(created.id);
      } catch { /* best effort */ }
    })();
    return created.id;
  } catch (err: any) {
    log.warn('policy upsert failed', { name, error: err.message });
    return null;
  }
}
