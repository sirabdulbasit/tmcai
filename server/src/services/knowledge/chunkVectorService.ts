/**
 * M1 — pgvector access layer for the `chunks` table.
 *
 * The Chunk model still carries a JSON `embedding` column for backwards
 * compatibility with the legacy retrieval path. The new
 * `chunks.vector_embedding` (vector(768)) column lets retrieval run
 * IVFFlat-indexed cosine search inside Postgres instead of pulling rows
 * into JS. This module:
 *
 *   1) `backfillChunkVectors(clientNumber)` — for every chunk where
 *      vector_embedding IS NULL but the JSON `embedding` array is
 *      populated, parse the array and write it into the vector column.
 *      Idempotent and safe to re-run.
 *
 *   2) `searchChunksByVector(clientNumber, query, limit)` — embed the
 *      query and ORDER BY `vector_embedding <=> $vec` to return the
 *      nearest chunks. Falls back to an empty array if the corpus
 *      isn't backfilled yet.
 *
 * Embedding model is shared with wikiEmbeddingService (text-embedding-004,
 * 768 dim) so the same vector index strategy applies.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('chunk-vector');

const DIM = 768;
const MAX_EMBED_CHARS = 6000;
const MODEL_GEMINI = 'text-embedding-004';
const MODEL_STUB = 'stub-768';

export interface ChunkVectorHit {
  id: number;
  documentId: number;
  content: string;
  source: string;
  /** Cosine distance [0..2]; 0 = identical. */
  distance: number;
  /** 1 - distance/2 in [0..1]. */
  score: number;
}

/**
 * Backfill `vector_embedding` from the legacy JSON `embedding` column for
 * one tenant. Returns counts so callers can log progress. Run nightly
 * until the legacy column is dropped.
 */
export async function backfillChunkVectors(
  clientNumber: string,
  batchSize = 200,
): Promise<{ scanned: number; written: number; skipped: number }> {
  let scanned = 0, written = 0, skipped = 0;
  // Process in pages so we don't load the whole corpus into memory.
  let cursor = 0;
  while (true) {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id, embedding
         FROM chunks
        WHERE client_number = $1
          AND vector_embedding IS NULL
          AND id > $2
        ORDER BY id ASC
        LIMIT $3`,
      clientNumber, cursor, batchSize,
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      scanned += 1;
      cursor = Number(r.id);
      const arr: unknown = r.embedding;
      if (!Array.isArray(arr) || arr.length !== DIM) { skipped += 1; continue; }
      const numeric = (arr as unknown[]).every((v) => typeof v === 'number');
      if (!numeric) { skipped += 1; continue; }
      try {
        await prisma.$executeRawUnsafe(
          `UPDATE chunks SET vector_embedding = $1::vector WHERE id = $2`,
          vectorLiteral(arr as number[]), r.id,
        );
        written += 1;
      } catch (err: any) {
        skipped += 1;
        log.warn('vector backfill row failed', { id: r.id, error: err.message });
      }
    }
  }
  log.info('chunk vector backfill complete', { clientNumber, scanned, written, skipped });
  return { scanned, written, skipped };
}

/**
 * Cosine-search chunks for a tenant. Returns up to `limit` hits ordered
 * by distance ascending (closest first).
 */
export async function searchChunksByVector(
  clientNumber: string,
  query: string,
  opts: { limit?: number; minScore?: number; source?: string } = {},
): Promise<ChunkVectorHit[]> {
  const text = query.trim();
  if (!text) return [];
  const res = await embed(text.slice(0, MAX_EMBED_CHARS));
  if (!res || res.embedding.length !== DIM) return []; // degraded: caller falls back to keyword retrieval
  const { embedding } = res;
  const limit = Math.min(opts.limit ?? 20, 50);
  const sourceFilter = opts.source ? `AND source = $3` : '';
  const args: any[] = [vectorLiteral(embedding), clientNumber];
  if (opts.source) args.push(opts.source);
  args.push(limit);
  const limitParam = `$${args.length}`;
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, document_id AS "documentId", content, source,
            vector_embedding <=> $1::vector AS distance
       FROM chunks
      WHERE client_number = $2
        AND vector_embedding IS NOT NULL
        ${sourceFilter}
      ORDER BY vector_embedding <=> $1::vector
      LIMIT ${limitParam}`,
    ...args,
  ).catch((err) => { log.warn('chunk vector search failed', { error: err.message }); return [] as any[]; });

  const minScore = opts.minScore ?? 0;
  return rows
    .map((r: any) => {
      const distance = Number(r.distance);
      const score = Math.max(0, 1 - distance / 2);
      return { id: Number(r.id), documentId: Number(r.documentId), content: r.content, source: r.source, distance, score } as ChunkVectorHit;
    })
    .filter((h) => h.score >= minScore);
}

// ─── internals (mirrors wikiEmbeddingService.embed) ─────────────────

/** null = provider unavailable in production. The chunks table has NO
 *  per-vector model column, so a stub query vector compared against
 *  real stored vectors returns silently garbage-ranked results — the
 *  exact failure #7 forbids. Outside production stubs remain fine
 *  because stored dev vectors are stubs too. */
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
          recordEmbeddingRecovery('chunks');
          return { embedding: vec, model: MODEL_GEMINI };
        }
        lastError = `unexpected embedding shape (len=${vec.length})`;
      } else {
        lastError = `HTTP ${r.status}`;
      }
    } catch (e: any) { lastError = e?.message ?? 'fetch failed'; }
  }
  if (stubsAllowed()) return { embedding: stubEmbed(text), model: MODEL_STUB };
  await recordEmbeddingDegradation('chunks', lastError);
  return null;
}

function stubEmbed(text: string): number[] {
  const vec = new Array(DIM).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) h = (h ^ tok.charCodeAt(i)) * 16777619 >>> 0;
    vec[h % DIM] += 1;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

function vectorLiteral(vec: number[]): string {
  return '[' + vec.map((v) => (Number.isFinite(v) ? v.toFixed(6) : '0')).join(',') + ']';
}
