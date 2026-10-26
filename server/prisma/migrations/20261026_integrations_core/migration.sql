-- DEF-354 — Integrations Stage 1 core (Admin → Integrations: Google Sheet → KPI numbers → Brain).
-- Spec: server/docs/INTEGRATIONS_DESIGN.md §2.1. Ported from vm 06_INTEGRATION.md §8/§9.
--
-- Hand-written and idempotent (CREATE ... IF NOT EXISTS; constraints in DO $$ ... EXCEPTION WHEN
-- duplicate_object), so a re-apply is a no-op. Matches the IntegrationSync /
-- IntegrationMappingVersion / IntegrationSuggestion / IntegrationRun / IntegrationRunChange /
-- KpiDefinition / KpiReading models in schema.prisma column for column, index name for index name.
--
-- Why the database, not only code, carries these rules:
--   * one APPROVED mapping version per integration (partial unique) — "approval is the only write
--     permission, version-scoped" must not depend on two writers agreeing;
--   * one RUNNING run per integration (partial unique) — the INSERT of the run row IS the run
--     mutex; a second concurrent start gets 23505 → RunBusyError, never a double write;
--   * ACTIVE ⇒ activated_at AND approved_version_id (CHECK) — enabling is never half-done, and the
--     dispatcher never owes a slot before activated_at (vm §9 "enabling never triggers a run");
--   * every timestamp TIMESTAMPTZ (vm §5) — schedule slots are compared across zones.
--     kpi_readings.period_start is a DATE on purpose: a period is a calendar day, not an instant.
--   * children ON DELETE CASCADE; deleting an integration removes versions, suggestions and run
--     history but NOT the kpi_readings it wrote (no FK there, spec §5 q3), and frees its KPI
--     definitions (source_integration_id SET NULL).
--
-- `kpi_values` (Steering Wheel ops metrics, no unique key) is deliberately untouched.

-- ── integration_syncs ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS integration_syncs (
  id                     TEXT PRIMARY KEY,
  client_number          VARCHAR(20)  NOT NULL,
  name                   VARCHAR(200) NOT NULL,
  purpose                TEXT,
  admin_brief            TEXT,
  source_kind            VARCHAR(20)  NOT NULL DEFAULT 'gsheet',
  source_config          JSONB        NOT NULL DEFAULT '{}',
  status                 VARCHAR(10)  NOT NULL DEFAULT 'DRAFT',
  frequency              VARCHAR(10)  NOT NULL DEFAULT 'weekly',
  run_time               VARCHAR(5)   NOT NULL DEFAULT '02:00',
  day_of_week            INTEGER,
  day_of_month           INTEGER,
  timezone               VARCHAR(64)  NOT NULL DEFAULT 'Asia/Karachi',
  change_cap_pct         INTEGER      NOT NULL DEFAULT 25,
  blank_policy           VARCHAR(10)  NOT NULL DEFAULT 'abnormal',
  connection_tested_at   TIMESTAMPTZ(6),
  connection_fingerprint VARCHAR(64),
  activated_at           TIMESTAMPTZ(6),
  approved_version_id    TEXT,
  last_slot_at           TIMESTAMPTZ(6),
  next_run_at            TIMESTAMPTZ(6),
  last_run_at            TIMESTAMPTZ(6),
  last_run_status        VARCHAR(10),
  created_by             INTEGER      NOT NULL,
  created_at             TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS integration_syncs_tenant_name_key
  ON integration_syncs (client_number, name);
CREATE UNIQUE INDEX IF NOT EXISTS integration_syncs_approved_version_id_key
  ON integration_syncs (approved_version_id);
CREATE INDEX IF NOT EXISTS integration_syncs_tenant_status_idx
  ON integration_syncs (client_number, status);
-- The dispatcher's one cross-tenant read (spec §2.5): ACTIVE integrations only.
CREATE INDEX IF NOT EXISTS integration_syncs_active_due_idx
  ON integration_syncs (next_run_at) WHERE status = 'ACTIVE';

DO $$ BEGIN
  ALTER TABLE integration_syncs ADD CONSTRAINT integration_syncs_enums_check CHECK (
        status IN ('DRAFT','ACTIVE','PAUSED')
    AND frequency IN ('daily','weekly','monthly','once')
    AND source_kind IN ('gsheet')
    AND blank_policy IN ('normal','abnormal')
    AND (last_run_status IS NULL OR last_run_status IN ('RUNNING','SUCCESS','PARTIAL','FAILED','ABORTED'))
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- vm controller :328-331 never validated these; Nexeo validates in code AND here.
DO $$ BEGIN
  ALTER TABLE integration_syncs ADD CONSTRAINT integration_syncs_schedule_check CHECK (
        run_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    AND (day_of_week IS NULL OR day_of_week BETWEEN 0 AND 6)
    AND (day_of_month IS NULL OR day_of_month = -1 OR day_of_month BETWEEN 1 AND 31)
    AND change_cap_pct BETWEEN 1 AND 100
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE integration_syncs ADD CONSTRAINT integration_syncs_active_needs_approval_check
    CHECK (status <> 'ACTIVE' OR (activated_at IS NOT NULL AND approved_version_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── integration_mapping_versions ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS integration_mapping_versions (
  id             TEXT PRIMARY KEY,
  client_number  VARCHAR(20) NOT NULL,
  integration_id TEXT        NOT NULL,
  version        INTEGER     NOT NULL,
  spec           JSONB       NOT NULL DEFAULT '{}',
  status         VARCHAR(12) NOT NULL DEFAULT 'DRAFT',
  admin_prompt   TEXT,
  ai_summary     TEXT,
  created_by     INTEGER,
  approved_by    INTEGER,
  approved_at    TIMESTAMPTZ(6),
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS integration_mapping_versions_integ_version_key
  ON integration_mapping_versions (integration_id, version);
CREATE INDEX IF NOT EXISTS integration_mapping_versions_tenant_integ_idx
  ON integration_mapping_versions (client_number, integration_id);
-- One APPROVED version per integration (spec §2.1).
CREATE UNIQUE INDEX IF NOT EXISTS integration_mapping_versions_one_approved
  ON integration_mapping_versions (integration_id) WHERE status = 'APPROVED';

DO $$ BEGIN
  ALTER TABLE integration_mapping_versions ADD CONSTRAINT integration_mapping_versions_enums_check
    CHECK (status IN ('DRAFT','APPROVED','SUPERSEDED') AND version >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE integration_mapping_versions ADD CONSTRAINT integration_mapping_versions_integration_id_fkey
    FOREIGN KEY (integration_id) REFERENCES integration_syncs(id) ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Added after both tables exist. SET NULL: the pointer never dangles.
DO $$ BEGIN
  ALTER TABLE integration_syncs ADD CONSTRAINT integration_syncs_approved_version_id_fkey
    FOREIGN KEY (approved_version_id) REFERENCES integration_mapping_versions(id) ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── integration_suggestions (one row per FIELD decision, never per record) ─────────────────────
CREATE TABLE IF NOT EXISTS integration_suggestions (
  id                 TEXT PRIMARY KEY,
  client_number      VARCHAR(20)  NOT NULL,
  integration_id     TEXT         NOT NULL,
  mapping_version_id TEXT         NOT NULL,
  target_kind        VARCHAR(12)  NOT NULL DEFAULT 'kpi',
  source_field       VARCHAR(255) NOT NULL,
  target_key         VARCHAR(200) NOT NULL,
  transform          JSONB,
  coverage           JSONB,
  samples            JSONB,
  new_kpi            JSONB,
  status             VARCHAR(10)  NOT NULL DEFAULT 'PENDING',
  reason             TEXT,
  carried_from_id    TEXT,
  decided_by         INTEGER,
  decided_at         TIMESTAMPTZ(6),
  created_at         TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS integration_suggestions_tenant_version_idx
  ON integration_suggestions (client_number, mapping_version_id, status);
CREATE INDEX IF NOT EXISTS integration_suggestions_tenant_integ_idx
  ON integration_suggestions (client_number, integration_id, status);

-- target_kind is 'kpi' only in Stage 1; a later stage widens this CHECK in its own migration.
DO $$ BEGIN
  ALTER TABLE integration_suggestions ADD CONSTRAINT integration_suggestions_enums_check CHECK (
        target_kind IN ('kpi')
    AND status IN ('PENDING','APPROVED','REJECTED','SET_ASIDE','BLANK')
    AND target_key LIKE 'kpi:%'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE integration_suggestions ADD CONSTRAINT integration_suggestions_integration_id_fkey
    FOREIGN KEY (integration_id) REFERENCES integration_syncs(id) ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE integration_suggestions ADD CONSTRAINT integration_suggestions_mapping_version_id_fkey
    FOREIGN KEY (mapping_version_id) REFERENCES integration_mapping_versions(id) ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── integration_runs ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS integration_runs (
  id                     TEXT PRIMARY KEY,
  client_number          VARCHAR(20)  NOT NULL,
  integration_id         TEXT         NOT NULL,
  mapping_version_id     TEXT,
  connection_fingerprint VARCHAR(64),
  dry_run                BOOLEAN      NOT NULL DEFAULT FALSE,
  trigger                VARCHAR(10)  NOT NULL,
  triggered_by           VARCHAR(255) NOT NULL,
  status                 VARCHAR(10)  NOT NULL DEFAULT 'RUNNING',
  records_read           INTEGER      NOT NULL DEFAULT 0,
  records_filtered_out   INTEGER      NOT NULL DEFAULT 0,
  subjects_affected      INTEGER      NOT NULL DEFAULT 0,
  writes                 INTEGER      NOT NULL DEFAULT 0,
  skipped                INTEGER      NOT NULL DEFAULT 0,
  set_aside              INTEGER      NOT NULL DEFAULT 0,
  blanks                 INTEGER      NOT NULL DEFAULT 0,
  change_percent         DECIMAL(6,2),
  result                 JSONB,
  error_message          TEXT,
  started_at             TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  finished_at            TIMESTAMPTZ(6)
);

CREATE INDEX IF NOT EXISTS integration_runs_tenant_history_idx
  ON integration_runs (client_number, integration_id, dry_run, started_at DESC);
-- THE run mutex (spec §2.4 step 2): one RUNNING run per integration, dry or live.
CREATE UNIQUE INDEX IF NOT EXISTS integration_runs_one_running
  ON integration_runs (integration_id) WHERE status = 'RUNNING';

DO $$ BEGIN
  ALTER TABLE integration_runs ADD CONSTRAINT integration_runs_enums_check CHECK (
        trigger IN ('manual','scheduled')
    AND status IN ('RUNNING','SUCCESS','PARTIAL','FAILED','ABORTED')
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE integration_runs ADD CONSTRAINT integration_runs_integration_id_fkey
    FOREIGN KEY (integration_id) REFERENCES integration_syncs(id) ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── integration_run_changes (OUTCOME rows; TEXT cuid id — a BIGINT id cannot be JSON-serialised) ─
-- DB default id: the live writer inserts these with raw SQL inside the KPI transaction (Prisma
-- supplies its own cuid on prisma.*.create; the default only covers raw INSERTs).
CREATE TABLE IF NOT EXISTS integration_run_changes (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  client_number  VARCHAR(20)  NOT NULL,
  integration_id TEXT         NOT NULL,
  run_id         TEXT         NOT NULL,
  target_kind    VARCHAR(12)  NOT NULL DEFAULT 'kpi',
  op             VARCHAR(8)   NOT NULL,
  subject_key    VARCHAR(255) NOT NULL,
  subject_label  VARCHAR(255),
  target_key     VARCHAR(200) NOT NULL,
  source_key     VARCHAR(255),
  before_value   TEXT,
  after_value    TEXT,
  created_at     TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS integration_run_changes_tenant_run_idx
  ON integration_run_changes (client_number, run_id, target_kind);

DO $$ BEGIN
  ALTER TABLE integration_run_changes ADD CONSTRAINT integration_run_changes_enums_check
    CHECK (target_kind IN ('kpi') AND op IN ('create','update'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE integration_run_changes ADD CONSTRAINT integration_run_changes_run_id_fkey
    FOREIGN KEY (run_id) REFERENCES integration_runs(id) ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── kpi_definitions (tenant KPI catalogue) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kpi_definitions (
  id                    TEXT PRIMARY KEY,
  client_number         VARCHAR(20)  NOT NULL,
  kpi_key               VARCHAR(80)  NOT NULL,
  label                 VARCHAR(200) NOT NULL,
  unit                  VARCHAR(20),
  direction             VARCHAR(10)  NOT NULL DEFAULT 'up',
  grain                 VARCHAR(10)  NOT NULL DEFAULT 'month',
  source_integration_id TEXT,
  is_active             BOOLEAN      NOT NULL DEFAULT TRUE,
  created_by            INTEGER,
  created_at            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS kpi_definitions_tenant_key_key
  ON kpi_definitions (client_number, kpi_key);
CREATE INDEX IF NOT EXISTS kpi_definitions_tenant_active_idx
  ON kpi_definitions (client_number, is_active);

-- kpi_key pattern mirrors KPI_KEY_RE in services/integrations/types.ts.
DO $$ BEGIN
  ALTER TABLE kpi_definitions ADD CONSTRAINT kpi_definitions_enums_check CHECK (
        direction IN ('up','down')
    AND grain IN ('day','week','month')
    AND kpi_key ~ '^[a-z][a-z0-9_]{0,79}$'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- One KPI, one feeding integration (vm §9 "one field, one owner"); deleting it frees the KPI.
DO $$ BEGIN
  ALTER TABLE kpi_definitions ADD CONSTRAINT kpi_definitions_source_integration_id_fkey
    FOREIGN KEY (source_integration_id) REFERENCES integration_syncs(id) ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── kpi_readings (dated measurements; a missing reading is NO ROW, never 0) ────────────────────
CREATE TABLE IF NOT EXISTS kpi_readings (
  id             TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,  -- raw ON CONFLICT upsert
  client_number  VARCHAR(20)   NOT NULL,
  kpi_key        VARCHAR(80)   NOT NULL,
  period_start   DATE          NOT NULL,
  dimension_key  VARCHAR(200)  NOT NULL DEFAULT '',
  value          DECIMAL(20,6) NOT NULL,
  integration_id TEXT          NOT NULL,
  run_id         TEXT,
  written_at     TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

-- The ON CONFLICT target of the live writer (spec §2.4 step 7).
CREATE UNIQUE INDEX IF NOT EXISTS kpi_readings_tenant_key_period_dim_key
  ON kpi_readings (client_number, kpi_key, period_start, dimension_key);
CREATE INDEX IF NOT EXISTS kpi_readings_tenant_integ_idx
  ON kpi_readings (client_number, integration_id);
