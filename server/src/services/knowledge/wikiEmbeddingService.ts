/**
 * Wiki embeddings — semantic retrieval for wiki_pages.
 *
 * Pattern: reuse the openItemEmbeddingService approach but write the
 * vector straight into `wiki_pages.embedding` (pgvector column) so we can
 * do `ORDER BY embedding <=> $query` at retrieval time via the HNSW index.
 *
 * Embedding model: Gemini `text-embedding-004` (768 dims). Dev fallback:
 * deterministic hash-based 768-dim stub so local runs work without an API
 * key, though quality will be poor.
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

const MODEL_GEMINI = 'text-embedding-004';
const MODEL_STUB = 'stub-768';
const DIM = 768;

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
 */
export async function embedWikiPage(pageId: string): Promise<void> {
  try {
    // Raw SQL so we can cheaply read the hash + embedding-null check in one hop.
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT title, body_markdown AS "bodyMarkdown",
              embedding_text_hash AS "hash",
              (embedding IS NULL) AS "embeddingNull"
         FROM wiki_pages WHERE id = $1`,
      pageId,
    );
    const page = rows[0];
    if (!page) return;
    const text = composeEmbedText(page.title, page.bodyMarkdown);
    if (!text) return;

    const h = hashText(text);
    if (page.hash === h && !page.embeddingNull) return;

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

/** null = provider unavailable in production (stubs forbidden there —
 *  audit 2026-07-14 #7). Callers skip the write / degrade retrieval. */
async function embed(text: string): Promise<{ embedding: number[]; model: string } | null> {
  const { stubsAllowed, recordEmbeddingDegradation, recordEmbeddingRecovery } = await import('./embeddingGuard');
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  let lastError = 'no GEMINI_API_KEY/GOOGLE_API_KEY configured';
  if (key) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: { parts: [{ text }] } }),
        },
      );
      if (r.ok) {
        const j: any = await r.json();
        const vec: number[] = j.embedding?.values ?? j.embedding ?? [];
        if (vec.length === DIM) {
          recordEmbeddingRecovery('wiki');
          return { embedding: vec, model: MODEL_GEMINI };
        }
        lastError = `unexpected embedding shape (len=${vec.length})`;
      } else {
        lastError = `HTTP ${r.status}`;
      }
    } catch (e: any) {
      lastError = e?.message ?? 'fetch failed';
    }
  }
  if (stubsAllowed()) return { embedding: stubEmbed(text), model: MODEL_STUB };
  await recordEmbeddingDegradation('wiki', lastError);
  return null;
}

/** Deterministic 768-dim stub used only when Gemini key is missing. */
function stubEmbed(text: string): number[] {
  const vec = new Array(DIM).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) h = (h ^ tok.charCodeAt(i)) * 16777619 >>> 0;
    vec[h % DIM] += 1;
  }
  // L2 normalize so cosine distance behaves
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

/** Format a number array as a pgvector text literal: `[0.1,0.2,...]` */
function vectorLiteral(vec: number[]): string {
  return '[' + vec.map((v) => (Number.isFinite(v) ? v.toFixed(6) : '0')).join(',') + ']';
}
