-- DEF-368 — Integrations: an uploaded Excel (.xlsx, .xls) or CSV file as a source.
-- Owner 2026-10-31: "there should be integration source that can be Googlesheet / API
-- documentation file / Excel file with data". vm §7: "A spreadsheet attached in the document
-- box is uploaded and kept; every run reads the stored copy, so a newer version is uploaded
-- the same way."
--
-- ADDITIVE on top of 20261026_integrations_core / 20261026b_integrations_api /
-- 20261030_integrations_doc_keys. Hand-written and idempotent: the widened CHECK is
-- DROP CONSTRAINT IF EXISTS followed by a guarded ADD inside one DO $$ block (so a re-apply
-- drops and re-adds the SAME wider rule, and every existing 'gsheet' / 'api' row still
-- satisfies it); the table is CREATE TABLE IF NOT EXISTS; every other constraint is a
-- guarded ADD. Matches the IntegrationSourceFile model in schema.prisma column for column.
--
--   * integration_source_files holds THE stored copy, one per integration (the primary key
--     is the integration id): a newer upload replaces it. Every run reads this copy, never
--     the admin's disk. Deleting the integration deletes the file (ON DELETE CASCADE).
--   * client_number is carried on the row (TENANT_SCOPED_MODELS) so every query is
--     tenant-filtered like the other integration tables.
--   * sha256 is the copy's identity: integration_syncs.source_config {fileName, sheetName?,
--     sha256} names it, and the connection fingerprint covers sha256 + sheetName — a new
--     upload or another tab clears the connection test.
--   * The bytes are never returned by the API (the DTO carries name, size and date only).

-- ── integration_syncs: source_kind widens from ('gsheet','api') to ('gsheet','api','file') ──
DO $$ BEGIN
  ALTER TABLE integration_syncs DROP CONSTRAINT IF EXISTS integration_syncs_enums_check;
  BEGIN
    ALTER TABLE integration_syncs ADD CONSTRAINT integration_syncs_enums_check CHECK (
          status IN ('DRAFT','ACTIVE','PAUSED')
      AND frequency IN ('daily','weekly','monthly','once')
      AND source_kind IN ('gsheet','api','file')
      AND blank_policy IN ('normal','abnormal')
      AND (last_run_status IS NULL OR last_run_status IN ('RUNNING','SUCCESS','PARTIAL','FAILED','ABORTED'))
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

-- ── integration_source_files: the uploaded spreadsheet, one per integration ─────────────────
CREATE TABLE IF NOT EXISTS integration_source_files (
  integration_id TEXT         PRIMARY KEY,
  client_number  VARCHAR(20)  NOT NULL,
  filename       VARCHAR(255),
  mime           VARCHAR(120),
  bytes          BYTEA        NOT NULL,
  size_bytes     INT,
  sha256         CHAR(64),
  uploaded_by    INT,
  uploaded_at    TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS integration_source_files_tenant_idx
  ON integration_source_files (client_number);

DO $$ BEGIN
  ALTER TABLE integration_source_files ADD CONSTRAINT integration_source_files_integration_id_fkey
    FOREIGN KEY (integration_id) REFERENCES integration_syncs(id) ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- The identity is always a lowercase hex sha256 when present; the size is never negative.
DO $$ BEGIN
  ALTER TABLE integration_source_files ADD CONSTRAINT integration_source_files_shape_check
    CHECK ((sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$') AND (size_bytes IS NULL OR size_bytes >= 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
