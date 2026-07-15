DROP INDEX IF EXISTS entities_client_scope_type_idx;
DROP INDEX IF EXISTS entities_client_owner_type_idx;
ALTER TABLE entities DROP COLUMN IF EXISTS scope;
ALTER TABLE entities DROP COLUMN IF EXISTS owner_user_id;
