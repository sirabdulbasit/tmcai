-- DEF-362 — Integrations Stage 1b: API document → REST connection; remarks, filters, connect
-- instructions; KPI or Context mapping. Spec: server/docs/INTEGRATIONS_DESIGN.md §2b.
--
-- ADDITIVE on top of 20261026_integrations_core (deployed with DEF-354). Hand-written and
-- idempotent: columns are ADD COLUMN IF NOT EXISTS; a widened CHECK is DROP CONSTRAINT IF EXISTS
-- followed by a guarded ADD inside one DO $$ block, so a re-apply drops and re-adds the SAME
-- (wider) rule and every existing Stage 1 row ('gsheet' / 'kpi') still satisfies it.
-- Matches the IntegrationSync / IntegrationSuggestion / IntegrationRunChange models in
-- schema.prisma column for column. kpi_readings and kpi_definitions are untouched.
--
-- Why these live in the database, not only in code:
--   * secret_enc holds ciphertext only ('v1:<iv>:<tag>:<ct>', AES-256-GCM, store/secretStore.ts).
--     There is no plaintext column at all, so no code path can store one by mistake.
--   * approved_filter is written ONLY by approving a filter suggestion (vm §9 "approval is the
--     only write permission"); the client whitelist (types.ts INTEGRATION_INPUT_KEYS) never names it.
--   * the CHECKs keep source kinds / target kinds / target-key forms closed: a writer that invents
--     a new kind fails at INSERT instead of producing rows no reader understands.

-- ── integration_syncs: the API source, the document the AI read, the admin's words ────────────
ALTER TABLE integration_syncs ADD COLUMN IF NOT EXISTS api_doc_name         VARCHAR(255);
ALTER TABLE integration_syncs ADD COLUMN IF NOT EXISTS api_doc_text         TEXT;
ALTER TABLE integration_syncs ADD COLUMN IF NOT EXISTS api_doc_reading      JSONB;
ALTER TABLE integration_syncs ADD COLUMN IF NOT EXISTS filter_instructions  TEXT;
ALTER TABLE integration_syncs ADD COLUMN IF NOT EXISTS connect_instructions TEXT;
ALTER TABLE integration_syncs ADD COLUMN IF NOT EXISTS api_config           JSONB;
ALTER TABLE integration_syncs ADD COLUMN IF NOT EXISTS secret_enc           TEXT;
ALTER TABLE integration_syncs ADD COLUMN IF NOT EXISTS secret_set_at        TIMESTAMPTZ(6);
ALTER TABLE integration_syncs ADD COLUMN IF NOT EXISTS approved_filter      JSONB;

-- source_kind widens from ('gsheet') to ('gsheet','api'); every other enum is unchanged.
DO $$ BEGIN
  ALTER TABLE integration_syncs DROP CONSTRAINT IF EXISTS integration_syncs_enums_check;
  BEGIN
    ALTER TABLE integration_syncs ADD CONSTRAINT integration_syncs_enums_check CHECK (
          status IN ('DRAFT','ACTIVE','PAUSED')
      AND frequency IN ('daily','weekly','monthly','once')
      AND source_kind IN ('gsheet','api')
      AND blank_policy IN ('normal','abnormal')
      AND (last_run_status IS NULL OR last_run_status IN ('RUNNING','SUCCESS','PARTIAL','FAILED','ABORTED'))
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

-- A stored secret always carries the instant it was set, and is always the v1 envelope.
DO $$ BEGIN
  ALTER TABLE integration_syncs ADD CONSTRAINT integration_syncs_secret_check
    CHECK (secret_enc IS NULL OR (secret_enc LIKE 'v1:%' AND secret_set_at IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── integration_suggestions: KPI, Context or the structured filter; which words it followed ────
ALTER TABLE integration_suggestions ADD COLUMN IF NOT EXISTS followed TEXT;

-- target_kind widens to ('kpi','context','filter'); each kind has exactly one key form:
--   kpi     → 'kpi:<key>' | 'kpi:new:<key>'      (Stage 1)
--   context → 'context:per_record' | 'context:table'
--   filter  → 'filter'
DO $$ BEGIN
  ALTER TABLE integration_suggestions DROP CONSTRAINT IF EXISTS integration_suggestions_enums_check;
  BEGIN
    ALTER TABLE integration_suggestions ADD CONSTRAINT integration_suggestions_enums_check CHECK (
          target_kind IN ('kpi','context','filter')
      AND status IN ('PENDING','APPROVED','REJECTED','SET_ASIDE','BLANK')
      AND (   (target_kind = 'kpi'     AND target_key LIKE 'kpi:%')
           OR (target_kind = 'context' AND target_key IN ('context:per_record','context:table'))
           OR (target_kind = 'filter'  AND target_key = 'filter'))
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

-- ── integration_run_changes: the context writer's outcome rows ─────────────────────────────────
-- The context writer records what it wrote in the same transaction, like the KPI writer (AGENTS
-- §2.6 "no mutation without its ledger"). A record that disappeared is marked stale, never
-- deleted (spec §2b), and that marking is itself a change the admin must be able to see.
DO $$ BEGIN
  ALTER TABLE integration_run_changes DROP CONSTRAINT IF EXISTS integration_run_changes_enums_check;
  BEGIN
    ALTER TABLE integration_run_changes ADD CONSTRAINT integration_run_changes_enums_check
      CHECK (target_kind IN ('kpi','context') AND op IN ('create','update','stale'));
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;
