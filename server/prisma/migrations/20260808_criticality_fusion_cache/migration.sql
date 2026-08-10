-- OPT-003 — stop paying to re-derive what Brain already worked out.
--
-- Measured 2026-08-08: `criticality_fuse` made 17,087 LLM calls in 24 hours,
-- 21.1M tokens, at a steady ~700/hour around the clock. That is a background
-- loop, not conversation — only 302 of 7,413 feed events are from the last
-- week, so Brain has been re-scoring months-old email every hour and arriving
-- at the same answer every time. Total LLM spend was running at ~$19.84/day for
-- a single user.
--
-- The cache key is the PROMPT, not the event. Criticality legitimately changes
-- as signals change — a deadline approaches, an open item closes, the sender
-- goes quiet — so caching on feed_event_id would freeze a score that ought to
-- move. But `buildUserPrompt(input, signals)` produces the exact string sent to
-- the model: if those bytes are identical, every input the model sees is
-- identical, and so is the answer. Content-addressing is therefore correct by
-- construction rather than by assumption, and a changed signal misses the cache
-- automatically.
--
-- Scoped by client_number in the KEY, not just the row: a cache shared across
-- tenants would be a cross-tenant read of the worst kind — one tenant's email
-- content deciding another tenant's score.

CREATE TABLE IF NOT EXISTS criticality_fusion_cache (
  -- sha256 of (prompt_version || client_number || user_prompt). Tenant is
  -- inside the hash so a collision cannot cross a tenant boundary.
  cache_key      CHAR(64)     PRIMARY KEY,
  client_number  VARCHAR(20)  NOT NULL,
  -- Bumped whenever the fusion prompt or the dimension set changes. Without
  -- it, a prompt improvement would silently serve stale answers from before
  -- the change — the cache would quietly undo the upgrade.
  prompt_version VARCHAR(16)  NOT NULL,
  -- The full fuseAndScore return value: dimensions, reasons, story,
  -- confidence, substantive, substantiveWhy.
  result         JSONB        NOT NULL,
  hits           INTEGER      NOT NULL DEFAULT 0,
  created_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_hit_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Eviction sweep: oldest-first within a tenant.
CREATE INDEX IF NOT EXISTS criticality_fusion_cache_age_ix
  ON criticality_fusion_cache (client_number, created_at);

-- Deliberately NO index on last_hit_at or hits. They are written on every hit
-- and read only by a human curious about hit rate; indexing them would
-- reintroduce exactly the write-amplification this table exists to remove
-- (see OPT-001: 791 MB of indexes nobody ever read).
