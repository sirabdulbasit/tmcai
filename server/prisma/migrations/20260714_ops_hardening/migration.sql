-- 20260714_ops_hardening — formal schema for the hardening-audit
-- operational tables (previously created by runtime DDL, which assumed
-- the app role could CREATE TABLE — removed; audit item #2).
--
-- Repeatability: every statement is IF NOT EXISTS / idempotent — safe
-- to apply to an empty database AND to a database where the old
-- runtime DDL already created job_runs/self_heal_log.
--
-- Rollback (manual, non-destructive order):
--   DROP TABLE IF EXISTS job_leases;
--   DROP TABLE IF EXISTS ops_health_state;
--   DROP TABLE IF EXISTS self_heal_log;
--   DROP TABLE IF EXISTS job_runs;
--   ALTER TABLE chunks DROP COLUMN IF EXISTS embedding_model;
--   ALTER TABLE action_definitions DROP COLUMN IF EXISTS operational_metadata;
--   ALTER TABLE users DROP COLUMN IF EXISTS timezone_is_explicit;
--   ALTER TABLE users ALTER COLUMN timezone SET DEFAULT 'Asia/Karachi';

-- ── #4: background-job run ledger ───────────────────────────────────
CREATE TABLE IF NOT EXISTS job_runs (
  name                 TEXT PRIMARY KEY,
  job_class            TEXT NOT NULL DEFAULT 'maintenance'
                       CHECK (job_class IN ('maintenance','important','critical')),
  last_started_at      TIMESTAMPTZ,
  last_completed_at    TIMESTAMPTZ,
  last_status          TEXT
                       CHECK (last_status IN ('ok','failed','running','skipped_no_lock','lease_lost','schema_missing')),
  last_error           TEXT,
  last_duration_ms     INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  runs_completed       BIGINT  NOT NULL DEFAULT 0,
  attempts_total       BIGINT  NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Older runtime-DDL installs lack the attempts column.
ALTER TABLE job_runs ADD COLUMN IF NOT EXISTS attempts_total BIGINT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS job_runs_status_idx ON job_runs (last_status, updated_at DESC);

-- ── #4: durable job leases (replaces transaction-held advisory locks
--        for job bodies that call slow external providers) ───────────
CREATE TABLE IF NOT EXISTS job_leases (
  name        TEXT PRIMARY KEY,
  owner       TEXT NOT NULL,
  fence       BIGINT NOT NULL DEFAULT 1,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS job_leases_expiry_idx ON job_leases (expires_at);

-- ── #5: self-heal audit ledger ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS self_heal_log (
  id            BIGSERIAL PRIMARY KEY,
  rule_id       TEXT NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','tenant','user')),
  client_number TEXT,
  user_id       INTEGER,
  outcome       TEXT NOT NULL CHECK (outcome IN (
    'healed','verify_failed','apply_failed','skipped_cooldown',
    'skipped_exhausted','detect_failed','audit_unavailable')),
  summary       TEXT,
  before_state  JSONB,
  after_state   JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE self_heal_log ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'global';
ALTER TABLE self_heal_log ADD COLUMN IF NOT EXISTS user_id INTEGER;
CREATE INDEX IF NOT EXISTS self_heal_log_rule_time_idx  ON self_heal_log (rule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS self_heal_log_scope_idx      ON self_heal_log (rule_id, client_number, created_at DESC);

-- ── #10: durable component health (survives restarts) ───────────────
CREATE TABLE IF NOT EXISTS ops_health_state (
  component  TEXT PRIMARY KEY,
  status     TEXT NOT NULL CHECK (status IN ('healthy','degraded','down','unknown')),
  detail     TEXT,
  since      TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── #9: per-vector embedding model on chunks (wiki_pages already has
--        one; chunks was the unguarded mixing surface) ───────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='chunks') THEN
    ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(50);
    CREATE INDEX IF NOT EXISTS chunks_embedding_model_idx
      ON chunks (client_number, embedding_model) WHERE vector_embedding IS NOT NULL;
  END IF;
END $$;

-- ── #7: operational metadata on action definitions (connector
--        requirements etc. live WITH the action, not in a side map) ──
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='action_definitions') THEN
    ALTER TABLE action_definitions ADD COLUMN IF NOT EXISTS operational_metadata JSONB;
  END IF;
END $$;

-- ── #13: explicit-vs-inherited timezone. The old column default made
--        every row look chosen; new semantics: timezone participates
--        in resolution only when the user explicitly picked it. ──────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='public' AND table_name='users' AND column_name='timezone') THEN
    ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone_is_explicit BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE users ALTER COLUMN timezone DROP DEFAULT;
  END IF;
END $$;
