/**
 * Wiki embeddings — semantic retrieval for wiki_pages.
 *
 * The vector is written straight into `wiki_pages.embedding` (pgvector column)
 * so retrieval can `ORDER BY embedding <=> $query` via the HNSW index.
 *
 * Embedding provider: `pgVectorEmbeddingProvider` — the single owner of the
 * model, the 768-dim contract, normalisation, the dev stub, and embeddingGuard
 * degradation/recovery reporting. This file owns STORAGE and RETRIEVAL only.
 *
 * Idempotency: hash (title + body_markdown) with SHA-256 and skip write
 * if the hash hasn't changed. Keeps backfill + rerun cheap.
 *
 * Call points: every writer that upserts a wiki_page calls
 * `embedWikiPage(pageId)` fire-and-forget after the write. That way the
 * page becomes retrievable on the next turn without blocking the caller.
 */
import crypto from 'crypto';
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('wiki-embed');

// MEM-001, 2026-08-10: `text-embedding-004` was RETIRED by Google. The endpoint
// answers HTTP 404 — "not found for API version v1beta" — so embedding stopped
// dead on 2026-07-14 and nothing was indexed for 25 days. The code behaved
// correctly (it refuses to write a vector it could not compute), which is
// exactly why the failure was silent: memory kept being written, and none of it
// was reachable.
//
// MEM-005, 2026-08-11: that fix reached only this file. The model, the request
// shape, the normalisation and the stub now live in ONE provider, so the next
// provider change cannot leave a copy behind.
import {
  PGVECTOR_EMBEDDING_MODEL as MODEL_GEMINI,
  PGVECTOR_EMBEDDING_DIM as DIM,
  embedTextForPgVector,
  toVectorLiteral as vectorLiteral,
} from './pgVectorEmbeddingProvider';

// Embeddable text is capped — Gemini embed model has a token limit of
// ~2048, and we want the most salient content anyway. Title + first
// ~6KB of body is plenty for semantic retrieval.
const MAX_EMBED_CHARS = 6000;

function composeEmbedText(title: string, body: string | null): string {
  const t = (title ?? '').trim();
  const b = (body ?? '').trim();
  if (!t && !b) return '';
  const combined = t ? `${t}\n\n${b}` : b;
  return combined.slice(0, MAX_EMBED_CHARS);
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Embed a single wiki page if its text has changed since last time.
 * Safe to call concurrently from multiple writers; last-write-wins.
 *
 * DEF-118 — the freshness check must include the MODEL, not just the text.
 *
 * It used to be `hash matches && embedding is not null → return`. A page
 * embedded by a superseded model or by the local stub satisfies both: its text
 * has not changed and it holds a vector. So it was skipped forever, and no
 * amount of sweeping could repair it.
 *
 * That is the exact shape this file's sweep exists to fix. `sweepWikiEmbeddings`
 * selects on `embedding_model IS DISTINCT FROM MODEL_GEMINI` and its own comment
 * names priority 2 as "pages embedded by a SUPERSEDED model" — but it delegates
 * the write to this function, which could not act on that predicate. Two
 * definitions of "this page needs embedding", disagreeing: the fifth recurrence
 * of `protection-with-two-implementations`.
 *
 * Measured on production 2026-08-11: 7,893 of 12,483 pages (63%) carried
 * `stub-768` — deterministic hash noise, not meaning. The sweep had been
 * selecting 200 of them every ~50 minutes for 21 hours, embedding none, and
 * filing `embedding_provider_degraded` each time while the provider was healthy
 * (verified HTTP 200 against gemini-embedding-001). A row-count check reported
 * this memory as fully indexed, because `embedding IS NOT NULL` is true of a
 * stub vector.
 */
export async function embedWikiPage(pageId: string): Promise<void> {
  try {
    // Raw SQL so we can cheaply read the hash + embedding-null check in one hop.
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT title, body_markdown AS "bodyMarkdown",
              embedding_text_hash AS "hash",
              embedding_model AS "model",
              (embedding IS NULL) AS "embeddingNull"
         FROM wiki_pages WHERE id = $1`,
      pageId,
    );
    const page = rows[0];
    if (!page) return;
    const text = composeEmbedText(page.title, page.bodyMarkdown);
    if (!text) return;

    const h = hashText(text);
    // Unchanged text is only reason to skip if the vector was produced by the
    // model we currently search with. Distances between two embedding spaces
    // are not comparable, so a stale vector is worse than a missing one.
    if (page.hash === h && !page.embeddingNull && page.model === MODEL_GEMINI) return;

    const res = await embed(text);
    if (!res || res.embedding.length !== DIM) return; // provider down in prod → no write, backfill re-embeds later
    const { embedding, model } = res;

    // Write via raw SQL — Prisma has no native vector type and `Unsupported`
    // fields can't be assigned through the generated client. Cast to pgvector.
    await prisma.$executeRawUnsafe(
      `UPDATE wiki_pages
         SET embedding = $1::vector,
             embedding_model = $2,
             embedding_text_hash = $3,
             embedded_at = NOW()
       WHERE id = $4`,
      vectorLiteral(embedding), model, h, pageId,
    );
  } catch (err: any) {
    log.warn('embedWikiPage failed', { pageId, error: err.message });
  }
}

export interface WikiVectorHit {
  id: string;
  title: string;
  pageType: string;
  bodyMarkdown: string | null;
  userId: number;
  /** Cosine distance [0..2]; 0 = identical, 2 = opposite. */
  distance: number;
  /** Convenience: 1 - distance/2, in [0..1] where 1 = identical. */
  score: number;
}

/**
 * Vector-rank wiki pages by cosine distance to the query. Respects
 * multi-tenant rules: user's own pages + tenant-shared pages across
 * users, never another tenant's rows.
 */
export async function searchWikiByVector(
  clientNumber: string,
  userId: number,
  query: string,
  opts: { limit?: number; pageTypes?: string[]; minScore?: number } = {},
): Promise<WikiVectorHit[]> {
  const text = query.trim();
  if (!text) return [];

  const res = await embed(text.slice(0, MAX_EMBED_CHARS));
  if (!res || res.embedding.length !== DIM) return []; // degraded: callers fall back to keyword retrieval
  const { embedding, model } = res;

  const limit = Math.min(opts.limit ?? 20, 50);
  // gap pages are meta-notes about what Brain DOESN'T know — they often
  // contain the question keyword ("Fahim's communication content") and
  // outrank the real sender_topic pages in cosine similarity. Exclude
  // them from default search. Callers can include them explicitly.
  const typeFilter = opts.pageTypes && opts.pageTypes.length > 0
    ? `AND page_type IN (${opts.pageTypes.map((t) => `'${t.replace(/'/g, "''")}'`).join(',')})`
    : `AND page_type NOT IN ('gap','tenant_index','tenant_log')`;

  // Visibility filter — see services/knowledge/wikiScope.ts:
  //   (scope='tenant' OR (scope='user' AND user_id=$me))
  // The previous version inferred this from page_type, which broke the
  // moment a user's personal answer/gap page slipped into the planner's
  // index for another user.
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, title, page_type AS "pageType", body_markdown AS "bodyMarkdown", user_id AS "userId",
            scope AS "scope",
            embedding <=> $1::vector AS distance,
            embedding_model AS model
       FROM wiki_pages
      WHERE client_number = $2
        AND status NOT IN ('superseded','deleted')
        AND embedding IS NOT NULL
        AND embedding_model = $3
        AND (
          scope = 'tenant'
          OR (scope = 'user' AND user_id = $4)
        )
        ${typeFilter}
      ORDER BY embedding <=> $1::vector
      LIMIT $5`,
    vectorLiteral(embedding), clientNumber, model, userId, limit,
  ).catch((err) => { log.warn('vector search failed', { error: err.message }); return [] as any[]; });

  const minScore = opts.minScore ?? 0;
  return rows
    .map((r: any) => {
      const distance = Number(r.distance);
      const score = Math.max(0, 1 - distance / 2);
      return {
        id: r.id,
        title: r.title,
        pageType: r.pageType,
        bodyMarkdown: r.bodyMarkdown ?? null,
        userId: r.userId,
        distance,
        score,
      } as WikiVectorHit;
    })
    .filter((h) => h.score >= minScore);
}

// ─── internals ───────────────────────────────────────────────────

/** Storage-local wrapper around the shared provider. null = provider
 *  unavailable in production (stubs forbidden there — audit 2026-07-14 #7);
 *  callers skip the write / degrade retrieval. */
async function embed(text: string): Promise<{ embedding: number[]; model: string } | null> {
  return embedTextForPgVector(text, 'wiki', { maxChars: MAX_EMBED_CHARS });
}

/**
 * MEM-001 — make "memory is reachable" a guaranteed property, not a side effect.
 *
 * Embedding used to happen only where somebody remembered to call
 * `embedWikiPage` — a handful of write sites. Pages created by any other path
 * were never indexed, and when the model was retired on 2026-07-14 the whole
 * pipeline stopped with nothing to notice it. Twenty-five days later 3,167
 * pages were WHOLLY unreachable: no embedding to find them by meaning, no links
 * to find them by association. Brain was not forgetting; it was holding memory
 * it had no path back to.
 *
 * A sweep makes it a property of the system rather than of any writer's
 * diligence. Two priorities, in order:
 *   1. pages with no embedding at all — invisible to semantic search;
 *   2. pages embedded by a SUPERSEDED model — worse than useless, because
 *      distances between two different embedding spaces are not comparable, so
 *      a stale vector returns confident nonsense rather than nothing.
 *
 * Bounded per run. The point is to converge steadily without hammering the
 * provider or starving live traffic of rate limit.
 */
export async function sweepWikiEmbeddings(limit = 200): Promise<{ attempted: number; embedded: number; degraded: boolean }> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; client_number: string }>>(
    `SELECT id, client_number FROM wiki_pages
      WHERE body_markdown IS NOT NULL AND length(body_markdown) > 20
        AND (embedded_at IS NULL OR embedding_model IS DISTINCT FROM $1)
      ORDER BY (embedded_at IS NULL) DESC, last_updated_at DESC
      LIMIT $2`,
    MODEL_GEMINI, limit,
  ).catch(() => []);

  if (rows.length === 0) return { attempted: 0, embedded: 0, degraded: false };

  let embedded = 0;
  let tried = 0;
  for (const row of rows) {
    tried += 1;
    await embedWikiPage(row.id);
    // Re-read rather than trust the call: embedWikiPage swallows provider
    // failures by design, so "it returned" is not evidence it wrote anything.
    const [check] = await prisma.$queryRawUnsafe<Array<{ ok: boolean }>>(
      `SELECT (embedding_model = $1) AS ok FROM wiki_pages WHERE id = $2`,
      MODEL_GEMINI, row.id,
    ).catch(() => [{ ok: false }]);
    if (check?.ok) embedded += 1;
    else break; // provider is down — stop the batch rather than burn 200 failures
  }

  // A dead embedder is invisible from the outside: writes keep succeeding and
  // only retrieval quietly gets worse. That is exactly how this went unnoticed
  // for 25 days, so it becomes a finding the watcher and the notifier can see.
  const degraded = embedded < rows.length;
  if (degraded) {
    const { recordFinding } = await import('../selfheal/healthFindingService');
    void recordFinding({
      clientNumber: rows[0].client_number,
      kind: 'embedding_provider_degraded',
      severity: 'error',
      source: 'wiki-embedding',
      // DEF-118: `attempted` used to report the SELECTED count, but the loop
      // breaks on the first failure — so a healthy provider skipping one page
      // was filed as 200 failed attempts. A finding that overstates its own
      // evidence sends every reader looking at the provider, which is where 21
      // hours went on 2026-08-11.
      summary: `wiki embedding is not writing vectors — ${tried - embedded} of ${tried} attempted pages stayed unindexed (${rows.length} selected)`,
      evidence: { model: MODEL_GEMINI, selected: rows.length, attempted: tried, embedded },
    });
  }
  return { attempted: rows.length, embedded, degraded };
}

/** How reachable is memory right now? Feeds the daily digest. */
export async function memoryReachability(clientNumber?: string): Promise<{
  pages: number; embedded: number; orphaned: number; unreachable: number;
}> {
  const [r] = await prisma.$queryRawUnsafe<Array<any>>(
    `SELECT count(*)::int AS pages,
            count(*) FILTER (WHERE embedding_model = $1)::int AS embedded,
            count(*) FILTER (WHERE inbound_links = 0 AND outbound_links = 0)::int AS orphaned,
            count(*) FILTER (WHERE embedding_model IS DISTINCT FROM $1
                               AND inbound_links = 0 AND outbound_links = 0)::int AS unreachable
       FROM wiki_pages
      WHERE ($2::text IS NULL OR client_number = $2)`,
    MODEL_GEMINI, clientNumber ?? null,
  ).catch(() => [{ pages: 0, embedded: 0, orphaned: 0, unreachable: 0 }]);
  return r;
}
