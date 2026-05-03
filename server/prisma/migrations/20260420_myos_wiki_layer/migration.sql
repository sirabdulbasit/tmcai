-- MyOS Wiki layer — per-user, multi-tenant knowledge wiki
-- Spec: reference/required_brain.md §6.3

CREATE TABLE IF NOT EXISTS "wiki_pages" (
  "id"              TEXT PRIMARY KEY,
  "client_number"   VARCHAR(20) NOT NULL,
  "user_id"         INTEGER NOT NULL,
  "page_type"       VARCHAR(30) NOT NULL,
  "title"           VARCHAR(300) NOT NULL,
  "notion_db_id"    VARCHAR(50),
  "storage"         VARCHAR(20) NOT NULL,
  "body_markdown"   TEXT,
  "inbound_links"   INTEGER NOT NULL DEFAULT 0,
  "outbound_links"  INTEGER NOT NULL DEFAULT 0,
  "source_count"    INTEGER NOT NULL DEFAULT 0,
  "status"          VARCHAR(20) NOT NULL DEFAULT 'active',
  "confidence"      DOUBLE PRECISION,
  "metadata"        JSONB,
  "last_updated_by" VARCHAR(50),
  "last_updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "wiki_pages_user_title_idx"
  ON "wiki_pages"("client_number", "user_id", "page_type", "title");
CREATE INDEX IF NOT EXISTS "wiki_pages_user_type_idx"
  ON "wiki_pages"("client_number", "user_id", "page_type");
CREATE INDEX IF NOT EXISTS "wiki_pages_user_status_idx"
  ON "wiki_pages"("client_number", "user_id", "status");

CREATE TABLE IF NOT EXISTS "wiki_page_sources" (
  "id"               SERIAL PRIMARY KEY,
  "wiki_page_id"     TEXT NOT NULL REFERENCES "wiki_pages"("id") ON DELETE CASCADE,
  "feed_event_id"    TEXT,
  "decision_log_id"  TEXT,
  "open_item_id"     TEXT,
  "client_number"    VARCHAR(20) NOT NULL,
  "user_id"          INTEGER NOT NULL,
  "cited_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "wiki_page_sources_page_idx" ON "wiki_page_sources"("wiki_page_id");
CREATE INDEX IF NOT EXISTS "wiki_page_sources_user_idx"
  ON "wiki_page_sources"("client_number", "user_id", "cited_at");

CREATE TABLE IF NOT EXISTS "wiki_page_links" (
  "id"            SERIAL PRIMARY KEY,
  "client_number" VARCHAR(20) NOT NULL,
  "user_id"       INTEGER NOT NULL,
  "from_page_id"  TEXT NOT NULL REFERENCES "wiki_pages"("id") ON DELETE CASCADE,
  "to_page_id"    TEXT NOT NULL REFERENCES "wiki_pages"("id") ON DELETE CASCADE,
  "link_type"     VARCHAR(30),
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wiki_page_links_unique" UNIQUE("from_page_id", "to_page_id", "link_type")
);
CREATE INDEX IF NOT EXISTS "wiki_page_links_user_idx"
  ON "wiki_page_links"("client_number", "user_id");

-- Seed: the Notion connector type (creates a canonical entry the UserConnector
-- rows will reference). Idempotent.
INSERT INTO "connector_types" (id, slug, name, description, category, scope, auth_method, config_schema, capabilities, is_active, created_at)
VALUES (
  'notion',
  'notion',
  'Notion',
  'Notion workspace used as the wiki storage backend for a user',
  'notes',
  'personal',
  'oauth2',
  '{}'::jsonb,
  '["read","write"]'::jsonb,
  true,
  CURRENT_TIMESTAMP
)
ON CONFLICT (slug) DO NOTHING;
