-- 2026-05-13 three-state contact scope migration.
--
-- Old model: metadata.scope ∈ { 'user', 'tenant' }
--   'user'   = owner-only visibility (Brain still processed it)
--   'tenant' = tenant-shared
--
-- New model: metadata.scope ∈ { 'private', 'normal', 'tenant' }
--   'private' = Brain ignores entirely (out of My Attention, no WA
--               brain, no Day Brief, no Open Items)
--   'normal'  = default — owner-only, Brain processes normally
--   'tenant'  = tenant-shared, Brain on
--
-- This script renames every legacy scope='user' row to scope='normal'.
-- It MUST run BEFORE the new code is deployed (or immediately after),
-- otherwise rows with the old 'user' value would not match any
-- frontend branch and would display as Normal anyway (the compat
-- shim in projectListItem handles that) — but the audit trail is
-- cleaner if the underlying data matches the new vocabulary.
--
-- Idempotent: re-running is safe (the WHERE clause filters to only
-- legacy 'user' rows).
--
-- Run on Ubuntu prod:
--   PGPASSWORD=... psql -U postgres -d tmcai -f migrate_scope_user_to_normal.sql

BEGIN;

UPDATE wiki_pages
   SET metadata = jsonb_set(metadata, '{scope}', '"normal"', false),
       last_updated_at = NOW()
 WHERE page_type = 'entity_person'
   AND metadata->>'scope' = 'user';

-- Sanity: count what's left in each bucket so the operator can confirm.
SELECT metadata->>'scope' AS scope, COUNT(*)
  FROM wiki_pages
 WHERE page_type = 'entity_person'
 GROUP BY metadata->>'scope'
 ORDER BY metadata->>'scope';

COMMIT;
