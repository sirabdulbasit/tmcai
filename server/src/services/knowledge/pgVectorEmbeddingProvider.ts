/**
 * pgVectorEmbeddingProvider — the single owner of embedding-provider behaviour
 * for the two `vector(768)` pgvector consumers: `wiki_pages.embedding` and
 * `chunks.vector_embedding`.
 *
 * WHY THIS EXISTS. Three services each owned a private copy of the provider
 * call, the model constant, the normalisation and the stub. MEM-001 fixed one
 * of them when Google retired `text-embedding-004`; the other two kept POSTing
 * to the retired endpoint for another 28 days. Nothing was wrong with the fix —
 * it simply had no way to reach the copies. One implementation per
 * responsibility is the only structural answer to that.
 *
 * SCOPE — 768 DIMENSIONS, DELIBERATELY. This provider serves the pgvector
 * columns, which are declared `vector(768)` with matching HNSW/IVFFlat indexes.
 * `gemini-embedding-001` returns 3072 natively, so 768 is requested explicitly
 * via `outputDimensionality`.
 *
 * `pipeline/embedder.ts` is a SEPARATE live pipeline that uses the same model at
 * its native 3072 dims (`EMBEDDING_DIMS` in config/models.ts). It is not merged
 * here and must not be: the two have different storage contracts, and collapsing
 * them would silently change one of the vector column widths. This module
 * therefore reuses `MODEL_EMBEDDING` — one model constant for the repository —
 * but owns its own dimension, because the dimension is a property of the
 * DESTINATION, not of the model.
 *
 * FAIL CLOSED. A provider failure returns null. Callers must then leave the
 * stored vector alone: a stale vector is worse than a missing one, because
 * distances between two embedding spaces are not comparable and return
 * confident nonsense instead of nothing. Stubs are never written in production
 * (hardening audit 2026-07-14 #7); degradation and recovery are reported
 * exclusively through the existing `embeddingGuard`, which already owns durable
 * health state — this module adds no competing mechanism.
 */
import { MODEL_EMBEDDING } from '../../config/models';

/** The model every pgvector row is written and searched with. Shared with the
 *  rest of the repository; never redeclared locally. */
export const PGVECTOR_EMBEDDING_MODEL = MODEL_EMBEDDING;

/** Width of the `vector(768)` columns. NOT `EMBEDDING_DIMS` (3072) — that
 *  belongs to the separate pipeline/embedder.ts path. */
export const PGVECTOR_EMBEDDING_DIM = 768;

/** Model tag for development stub vectors, so retrieval can exclude them by
 *  the same model predicate that excludes any superseded model. */
export const PGVECTOR_STUB_MODEL = 'stub-768';

/** Gemini's embed models cap around ~2048 tokens, and the most salient content
 *  is at the top of a page or chunk anyway. */
const DEFAULT_MAX_EMBED_CHARS = 6000;

/** Which consumer is asking — used only as the embeddingGuard health key. */
export type PgVectorEmbeddingService = 'wiki' | 'chunks';

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  dim: number;
}

/**
 * Scale a vector to unit length so cosine, dot product and magnitude agree.
 *
 * Truncated `gemini-embedding-001` vectors are NOT unit length — measured L2
 * 0.5888 at 768 dims, where `text-embedding-004` returned unit vectors.
 * pgvector's `<=>` normalises internally, but anything reading these as inner
 * products or comparing magnitudes would be quietly wrong.
 *
 * A zero or non-finite vector is returned unchanged rather than divided into
 * NaNs — poisoning a stored vector with NaN is unrecoverable, whereas a zero
 * vector merely fails to match.
 */
export function unitNormalise(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return v;
  return v.map((x) => x / norm);
}

/** Format a number array as a pgvector text literal: `[0.1,0.2,...]`.
 *  Non-finite components become 0 so a malformed vector can never produce
 *  invalid SQL. */
export function toVectorLiteral(vec: number[]): string {
  return '[' + vec.map((v) => (Number.isFinite(v) ? v.toFixed(6) : '0')).join(',') + ']';
}

/**
 * Embed text for a pgvector column.
 *
 * Returns null when the real provider is unavailable and stubs are forbidden
 * (production). Callers MUST treat null as "leave storage untouched".
 */
export async function embedTextForPgVector(
  text: string,
  service: PgVectorEmbeddingService,
  options: { maxChars?: number } = {},
): Promise<EmbeddingResult | null> {
  const { stubsAllowed, recordEmbeddingDegradation, recordEmbeddingRecovery } = await import('./embeddingGuard');

  const bounded = String(text ?? '').slice(0, options.maxChars ?? DEFAULT_MAX_EMBED_CHARS);
  if (!bounded.trim()) return null;

  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  let lastError = 'no GEMINI_API_KEY/GOOGLE_API_KEY configured';

  if (key) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${PGVECTOR_EMBEDDING_MODEL}:embedContent?key=${key}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // outputDimensionality keeps us at 768 so the pgvector columns and
          // their indexes survive the model change untouched.
          body: JSON.stringify({
            content: { parts: [{ text: bounded }] },
            outputDimensionality: PGVECTOR_EMBEDDING_DIM,
          }),
        },
      );
      if (r.ok) {
        const j: any = await r.json();
        const raw = j?.embedding?.values ?? j?.embedding ?? [];
        // Shape is validated before anything is trusted: a 200 carrying the
        // wrong width is a provider change, not a vector.
        const vec: number[] = Array.isArray(raw) && raw.every((n: unknown) => typeof n === 'number') ? raw : [];
        if (vec.length === PGVECTOR_EMBEDDING_DIM) {
          // Recovery is stamped only here — after a REAL provider success of the
          // expected shape. The stub path below never reaches it.
          recordEmbeddingRecovery(service);
          return {
            embedding: unitNormalise(vec),
            model: PGVECTOR_EMBEDDING_MODEL,
            dim: PGVECTOR_EMBEDDING_DIM,
          };
        }
        lastError = `unexpected embedding shape (len=${Array.isArray(raw) ? raw.length : 'n/a'})`;
      } else {
        lastError = `HTTP ${r.status}`;
      }
    } catch (e: any) {
      lastError = e?.message ?? 'fetch failed';
    }
  }

  if (stubsAllowed()) {
    return { embedding: stubEmbed(bounded), model: PGVECTOR_STUB_MODEL, dim: PGVECTOR_EMBEDDING_DIM };
  }
  await recordEmbeddingDegradation(service, lastError);
  return null;
}

/** Deterministic 768-dim stub, used only outside production (or with an
 *  explicit operator opt-in). Same token-hash construction the wiki and chunk
 *  services each carried privately, so existing dev vectors stay comparable. */
function stubEmbed(text: string): number[] {
  const vec = new Array(PGVECTOR_EMBEDDING_DIM).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const tok of tokens) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) h = (h ^ tok.charCodeAt(i)) * 16777619 >>> 0;
    vec[h % PGVECTOR_EMBEDDING_DIM] += 1;
  }
  return unitNormalise(vec);
}
