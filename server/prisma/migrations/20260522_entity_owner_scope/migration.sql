-- P0 (2026-05-22): Entity per-user scope, after cross-user data leak.
-- Basit (user 2) saw Ali Numan contact + email that belonged to Haseeb's
-- ingested data. Root cause: contactResolver queried entities filtered by
-- clientNumber only (tenant-wide); Haseeb's auto-discovered contacts
-- appeared in Basit's results.
--
-- Adds:
--   - owner_user_id: the user this row belongs to (NULL = legacy)
--   - scope: 'user' (private) | 'tenant' (org-shared)
--
-- Backfill policy (conservative):
--   - All existing rows default to scope='user' so nothing becomes
--     instantly cross-user-readable.
--   - owner_user_id populated from created_by where present;
--     legacy rows with NULL created_by stay NULL (the resolver falls
--     back to createdBy = userId for those).

ALTER TABLE entities
  ADD COLUMN IF NOT EXISTS owner_user_id INTEGER,
  ADD COLUMN IF NOT EXISTS scope VARCHAR(20) NOT NULL DEFAULT 'user';

-- Backfill: any row with created_by gets owner_user_id = created_by.
UPDATE entities
   SET owner_user_id = created_by
 WHERE owner_user_id IS NULL AND created_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS entities_client_owner_type_idx
  ON entities(client_number, owner_user_id, entity_type);

CREATE INDEX IF NOT EXISTS entities_client_scope_type_idx
  ON entities(client_number, scope, entity_type);
