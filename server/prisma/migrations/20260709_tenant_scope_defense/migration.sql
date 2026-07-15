-- ═══════════════════════════════════════════════════════════════════════════
-- 20260709_tenant_scope_defense — spec E3/E5: tenant-isolation defense in depth
--
-- Four tables had NO tenant column: action_definitions, domain_knowledge,
-- personal_documents, personal_chunks. Personal data was only user-scoped,
-- so a single wrong join or leaked userId crossed tenants unimpeded; the
-- action/domain tables were fully global with no way to ever pin a row to
-- a tenant. Add a NULLABLE client_number everywhere:
--
--   NULL = system/global row. Readers filter with
--   (client_number IS NULL OR client_number = :tenant) so global rows —
--   and any pre-backfill stragglers — keep working for every tenant.
--
-- VarChar(50) (vs users.client_number's VarChar(20)) matches the newer
-- v15 tenant-column convention; values are still the same tenant keys.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Columns ────────────────────────────────────────────────────────────────
-- IF EXISTS / IF NOT EXISTS: the migration ledger has known drift (old
-- unapplied entries — e.g. local dev DBs restored from dumps predate
-- 20260522_data_driven_brain, so action_definitions may not exist there
-- yet). The file must be safe to run via `prisma db execute` on any
-- environment and safe to re-run.
ALTER TABLE IF EXISTS action_definitions ADD COLUMN IF NOT EXISTS client_number VARCHAR(50);
ALTER TABLE IF EXISTS domain_knowledge   ADD COLUMN IF NOT EXISTS client_number VARCHAR(50);
ALTER TABLE IF EXISTS personal_documents ADD COLUMN IF NOT EXISTS client_number VARCHAR(50);
ALTER TABLE IF EXISTS personal_chunks    ADD COLUMN IF NOT EXISTS client_number VARCHAR(50);

-- ── Backfill (personal data ONLY) ──────────────────────────────────────────
-- personal_documents / personal_chunks always belong to exactly one user,
-- and that user belongs to exactly one tenant — so the owner's tenant is
-- the ground truth and we copy it in. The `client_number IS NULL` guard
-- makes the backfill idempotent and never overwrites a future writer.
UPDATE personal_documents pd
SET client_number = u.client_number
FROM users u
WHERE u.id = pd.user_id AND pd.client_number IS NULL;

UPDATE personal_chunks pc
SET client_number = u.client_number
FROM users u
WHERE u.id = pc.user_id AND pc.client_number IS NULL;

-- action_definitions and domain_knowledge get NO backfill on purpose:
-- every existing row is a system seed (global actions, global regulatory
-- knowledge). NULL = system IS the correct end state for them, not a
-- straggler to be cleaned up.

-- ── Indexes ────────────────────────────────────────────────────────────────
-- Names follow Prisma's default `<table>_<cols>_idx` convention so the
-- schema.prisma @@index declarations map onto them without drift.
-- action_definitions may be absent on drifted dev DBs (see column note
-- above) and CREATE INDEX has no IF EXISTS for the table — guard it.
DO $$
BEGIN
  IF to_regclass('public.action_definitions') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS "action_definitions_client_number_idx"
      ON action_definitions (client_number);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "domain_knowledge_client_number_idx"
  ON domain_knowledge (client_number);
-- Tenant-first composites matching the read paths (tenant → user → doc).
CREATE INDEX IF NOT EXISTS "personal_documents_client_number_user_id_idx"
  ON personal_documents (client_number, user_id);
CREATE INDEX IF NOT EXISTS "personal_chunks_client_number_user_id_document_id_idx"
  ON personal_chunks (client_number, user_id, document_id);
