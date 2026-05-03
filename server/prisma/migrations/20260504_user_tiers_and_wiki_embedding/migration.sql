-- ============================================================
-- 20260504_user_tiers_and_wiki_embedding
--
-- Production drift catch-up. Two issues observed in prod logs:
--
-- 1. user_tiers table never had a formal migration — it lived only in
--    raw_tables.sql, which `prisma db push` syncs locally but prod
--    (which uses formal migrations) never picked up. /api/tiers 500'd.
--
-- 2. wiki_pages was missing 4 columns from the schema.prisma — added
--    to support pgvector embeddings but never migrated. The attachment
--    scribe pass for the historical pull failed with:
--      "The column `wiki_pages.embedding_model` does not exist"
--
-- All statements use IF NOT EXISTS / DO NOTHING — idempotent on local
-- DBs that already have these via prisma db push.
-- ============================================================

-- ── 1. user_tiers ──
CREATE TABLE IF NOT EXISTS user_tiers (
  id SERIAL PRIMARY KEY,
  client_number VARCHAR(50),
  tier_code VARCHAR(50),
  tier_name VARCHAR(100),
  description VARCHAR(500),
  price_per_seat NUMERIC(10, 2) DEFAULT 0,
  currency VARCHAR(10) DEFAULT 'USD',
  response_style VARCHAR(50) DEFAULT 'moderate',
  max_response_words INT DEFAULT 500,
  allow_widgets BOOLEAN DEFAULT true,
  allow_charts BOOLEAN DEFAULT true,
  allow_tables BOOLEAN DEFAULT true,
  allow_export BOOLEAN DEFAULT false,
  export_formats VARCHAR(100) DEFAULT 'csv',
  max_output_tokens INT DEFAULT 2048,
  allowed_providers VARCHAR(200) DEFAULT 'gemini-flash',
  allow_email_read BOOLEAN DEFAULT true,
  allow_email_write BOOLEAN DEFAULT false,
  allow_calendar_read BOOLEAN DEFAULT true,
  allow_calendar_write BOOLEAN DEFAULT false,
  max_queries_per_day INT DEFAULT 100,
  max_scheduled_tasks INT DEFAULT 0,
  sort_order INT DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(client_number, tier_code)
);

CREATE INDEX IF NOT EXISTS idx_user_tiers_client ON user_tiers(client_number);

-- ── 2. wiki_pages embedding columns ──
-- pgvector extension — NO-OP if already installed.
CREATE EXTENSION IF NOT EXISTS vector;

-- Add the four embedding-bookkeeping columns referenced by schema.prisma.
ALTER TABLE wiki_pages
  ADD COLUMN IF NOT EXISTS embedding vector(768),
  ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(40),
  ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS embedding_text_hash VARCHAR(64);

-- Index for ANN search (only created if the embedding column exists and
-- the index doesn't yet — IF NOT EXISTS guards both directions).
CREATE INDEX IF NOT EXISTS idx_wiki_pages_embedding ON wiki_pages
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
