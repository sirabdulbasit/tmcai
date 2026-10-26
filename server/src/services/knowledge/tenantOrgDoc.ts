/**
 * DEF-362 — the ONE writer of tenant-wide `org_doc` knowledge pages.
 *
 * Extracted from folderScribeService (FACL scribe) so the scribe and the
 * Integrations context writer (engine/contextWriter.ts) share a single code
 * path instead of growing a second knowledge writer (spec
 * INTEGRATIONS_DESIGN.md §2b "Context writer"). Behaviour is the scribe's,
 * unchanged:
 *   - a page is (clientNumber, userId, pageType 'org_doc', title) — the
 *     wiki_pages unique key;
 *   - scope 'tenant' is set EXPLICITLY on create (every user in the tenant must
 *     see it — never left to the page-type heuristic);
 *   - unchanged content (metadata.contentHash) is not rewritten;
 *   - a written page is re-embedded in the background (best effort), so
 *     semantic retrieval sees the new text.
 *
 * Two additions the context writer needs, both inert for the scribe:
 *   - `existing` lets a caller that already looked the page up (the scribe
 *     checks the hash BEFORE paying for an LLM summary; the context writer keys
 *     pages by record id in metadata, not by title) pass it in, so the lookup is
 *     not repeated and a renamed record keeps its page;
 *   - a page marked 'stale' (its record vanished from the source) is
 *     re-activated even when its content hash is unchanged — otherwise a record
 *     that comes back would stay invisible for ever.
 *
 * This module imports no AI provider: embedding is queued through a dynamic
 * import, exactly as the scribe did, so engine/** may call it.
 */
import prisma from '../../db/prisma';
import type { TenantOrgDocModule } from '../integrations/types';

/** The fields of an existing page the upsert needs. */
export interface ExistingOrgDoc {
  id: string;
  title?: string;
  status?: string | null;
  metadata: unknown;
}

export interface TenantOrgDocInput {
  userId: number;
  title: string;
  body: string;
  metadata: Record<string, unknown>;
  contentHash: string;
  /** wiki_pages.last_updated_by — 'facl_scribe' for the scribe, 'integration' for the context writer. */
  lastUpdatedBy?: string;
  /** Already looked up by the caller (undefined ⇒ look it up by title here). */
  existing?: ExistingOrgDoc | null;
}

/** The scribe's lookup, verbatim: by title, failures read as "no page". */
export async function findTenantOrgDoc(cn: string, userId: number, title: string): Promise<ExistingOrgDoc | null> {
  return prisma.wikiPage.findFirst({
    where: { clientNumber: cn, userId, pageType: 'org_doc', title } as any,
    select: { id: true, title: true, status: true, metadata: true },
  }).catch(() => null);
}

function queueEmbedding(pageId: string): void {
  void (async () => {
    try {
      const { embedWikiPage } = await import('./wikiEmbeddingService');
      await embedWikiPage(pageId);
    } catch { /* best effort — retrieval falls back to keyword search */ }
  })();
}

/**
 * Upsert one tenant org_doc page. Returns `changed:false` (nothing written)
 * when the stored contentHash equals `contentHash` and the page is not stale.
 */
export async function upsertTenantOrgDoc(cn: string, doc: TenantOrgDocInput): Promise<{ id: string; changed: boolean }> {
  const lastUpdatedBy = doc.lastUpdatedBy ?? 'facl_scribe';
  const existing = doc.existing !== undefined ? doc.existing : await findTenantOrgDoc(cn, doc.userId, doc.title);

  if (existing) {
    const prevMeta = (existing.metadata ?? {}) as Record<string, unknown>;
    // integrationStale (DEF-362 review): the integration writer's stale mark
    // lives in metadata, because the hourly linter overwrites status — a
    // record that came back must be rewritten (its body carries a stale note).
    if (prevMeta.contentHash === doc.contentHash && existing.status !== 'stale' && prevMeta.integrationStale !== true) {
      return { id: existing.id, changed: false };
    }
    await prisma.wikiPage.update({
      where: { id: existing.id },
      data: {
        // The title is only rewritten when it actually changed (a renamed
        // record); the scribe looks pages up BY title, so for it this is a no-op.
        ...(existing.title !== undefined && existing.title !== doc.title ? { title: doc.title } : {}),
        bodyMarkdown: doc.body, metadata: doc.metadata as any, lastUpdatedBy, lastUpdatedAt: new Date(), status: 'active',
      },
    });
    queueEmbedding(existing.id);
    return { id: existing.id, changed: true };
  }

  const created = await prisma.wikiPage.create({
    data: {
      clientNumber: cn, userId: doc.userId, pageType: 'org_doc', title: doc.title,
      storage: 'postgres', bodyMarkdown: doc.body, metadata: doc.metadata as any,
      lastUpdatedBy, status: 'active',
      // Explicit — these are tenant knowledge; every page must be visible to
      // every user in the tenant. Don't rely on the page-type heuristic alone.
      scope: 'tenant',
    } as any,
  });
  queueEmbedding(created.id);
  return { id: created.id, changed: true };
}

/** Compile-time pin to the shared contract (integrations/types.ts). */
export const tenantOrgDoc: TenantOrgDocModule = { upsertTenantOrgDoc };
