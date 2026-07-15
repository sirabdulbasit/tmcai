-- M1: pgvector column + IVFFlat index on `chunks`.
--
-- The Chunk model previously stored embeddings as `embedding JSON` (a float
-- array). Cosine similarity ran in JS on hot rows pulled into memory, which
-- couldn't scale past a few thousand chunks per tenant. WikiPage already
-- uses a vector(768) column with pgvector; this migration brings chunks
-- into line so DB-side ANN search becomes possible.
--
-- Strategy:
--   1) ensure pgvector extension is installed
--   2) add nullable `vector_embedding vector(768)` column
--   3) create IVFFlat index (cosine) — `lists=100` is a sane starting point
--      for tens of thousands of rows; tune as the corpus grows
--   4) leave the JSON `embedding` column in place as a fallback until the
--      backfill job (embeddingBackfill.ts) writes to vector_embedding for
--      every existing row
--
-- Embedding dim = 768 matches text-embedding-004 / Vertex gecko-003, which
-- is what `getEmbeddingModel()` returns by default.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS vector_embedding vector(768);

-- IVFFlat index for cosine distance. Use `vector_cosine_ops` so queries
-- written as `vector_embedding <=> $1::vector` use the index. `lists=100`
-- is the rule-of-thumb sqrt(N) for ~10K rows; raise to 1000 above 1M rows.
-- Index creation is non-blocking via CONCURRENTLY since chunks can be
-- a hot table.
CREATE INDEX IF NOT EXISTS chunks_vector_embedding_ivfflat
  ON chunks USING ivfflat (vector_embedding vector_cosine_ops)
  WITH (lists = 100);

-- For the planner: the JSON embedding column stays for now as fallback;
-- once vector_embedding is fully backfilled and wired into retriever.ts,
-- a follow-up migration drops `embedding`.
