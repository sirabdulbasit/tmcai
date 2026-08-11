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
 * Embedding provider is `pgVectorEmbeddingProvider`, shared with
 * wikiEmbeddingService — one model, one 768-dim contract, one normalisation,
 * one stub policy. This file owns storage and retrieval only.
 *
 * MEM-005, 2026-08-11: this file used to POST to `text-embedding-004`, retired
 * by Google on 2026-07-14. MEM-001 fixed the wiki copy and could not reach this
 * one, because the provider logic was duplicated rather than shared.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import {
  PGVECTOR_EMBEDDING_MODEL as MODEL_GEMINI,
  PGVECTOR_EMBEDDING_DIM as DIM,
  embedTextForPgVector,
  toVectorLiteral as vectorLiteral,
} from './pgVectorEmbeddingProvider';

const log = createLogger('chunk-vector');

const MAX_EMBED_CHARS = 6000;

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
        // #9: legacy JSON vectors have no provenance — stamp them
        // 'legacy-unknown'. Retrieval filters by model, so unknowns
        // never participate; the nightly re-embed pass replaces them
        // from content with the real model.
        await prisma.$executeRawUnsafe(
          `UPDATE chunks SET vector_embedding = $1::vector, embedding_model = 'legacy-unknown' WHERE id = $2`,
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
  const { embedding, model } = res;
  const limit = Math.min(opts.limit ?? 20, 50);
  const sourceFilter = opts.source ? `AND source = $4` : '';
  const args: any[] = [vectorLiteral(embedding), clientNumber, model];
  if (opts.source) args.push(opts.source);
  args.push(limit);
  const limitParam = `$${args.length}`;
  // #9: model-compatibility filter — only vectors produced by the SAME
  // model as the query embedding participate. Legacy/unknown vectors
  // ('legacy-unknown' or NULL) are excluded until re-embedded.
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, document_id AS "documentId", content, source,
            vector_embedding <=> $1::vector AS distance
       FROM chunks
      WHERE client_number = $2
        AND vector_embedding IS NOT NULL
        AND embedding_model = $3
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

/**
 * SQL predicate for "this chunk's vector was not produced by the model we
 * currently search with". Exported so the scheduler's tenant-discovery query
 * and this sweep cannot disagree about what "stale" means.
 *
 * MEM-005 — the predicate used to be an explicit list:
 *   `embedding_model IS NULL OR embedding_model = 'legacy-unknown'`
 *
 * That named the two stale models known when it was written and silently
 * excluded every model retired afterwards. `text-embedding-004` rows were
 * therefore STRANDED: `searchChunksByVector` filters `embedding_model = $current`
 * so they could never be returned, and the sweep meant to repair them never
 * selected them. Invisible and unrepairable at the same time.
 *
 * `IS DISTINCT FROM` is the honest form — anything that is not the current model
 * is stale, including NULL, 'legacy-unknown', 'stub-768', 'text-embedding-004'
 * and whatever supersedes the current model next. Rows already on the current
 * model are untouched, which is what keeps the sweep idempotent and convergent.
 */
export const STALE_CHUNK_MODEL_SQL = 'embedding_model IS DISTINCT FROM $MODEL$';

/**
 * #9 — bounded re-embedding of stale-model vectors. Replaces them from chunk
 * CONTENT using the REAL provider only (a stub result is never written here,
 * even in dev — re-embedding exists to raise fidelity, not to churn rows).
 * Idempotent: keyed per chunk id; a re-run finds fewer candidates.
 * Wired into the nightly cron:chunk_vector_backfill after the copy pass.
 */
export async function reembedUnknownChunkVectors(
  clientNumber: string,
  limit = 100,
): Promise<{ scanned: number; reembedded: number; skipped: number; degraded: boolean }> {
  let scanned = 0, reembedded = 0, skipped = 0;
  const cap = Math.min(Math.max(limit, 1), 500);
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT id, content FROM chunks
      WHERE client_number = $1
        AND vector_embedding IS NOT NULL
        AND embedding_model IS DISTINCT FROM $2
      ORDER BY id ASC
      LIMIT $3`,
    clientNumber, MODEL_GEMINI, cap,
  ).catch(() => [] as any[]);

  let degraded = false;
  for (const r of rows) {
    scanned += 1;
    const res = await embed(String(r.content ?? '').slice(0, MAX_EMBED_CHARS));
    // A null result means the PROVIDER failed, and it has already filed one
    // degradation through embeddingGuard. Continuing would file one per row —
    // up to `cap` identical findings and `cap` wasted provider calls for a
    // provider we already know is down. Stop the batch; the next nightly run
    // picks up exactly where this left off.
    if (!res) { degraded = true; break; }
    // A stub is not an upgrade. Skip without counting it against the provider.
    if (res.model !== MODEL_GEMINI || res.embedding.length !== DIM) { skipped += 1; continue; }
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE chunks SET vector_embedding = $1::vector, embedding_model = $2 WHERE id = $3`,
        vectorLiteral(res.embedding), res.model, r.id,
      );
      reembedded += 1;
    } catch (err: any) {
      skipped += 1;
      log.warn('re-embed row failed', { id: r.id, error: err.message });
    }
  }
  if (reembedded > 0) log.info('stale-model chunk vectors re-embedded', { clientNumber, scanned, reembedded, skipped });
  return { scanned, reembedded, skipped, degraded };
}

// ─── internals ───────────────────────────────────────────────────

/** Storage-local wrapper around the shared provider. null = provider
 *  unavailable in production; retrieval degrades and the re-embed sweep stops
 *  rather than burning its whole batch on a dead provider. */
async function embed(text: string): Promise<{ embedding: number[]; model: string } | null> {
  return embedTextForPgVector(text, 'chunks', { maxChars: MAX_EMBED_CHARS });
}
