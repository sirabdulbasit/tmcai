-- One-shot revert: the 2026-05-23 wipe script over-promoted all orphan
-- `entity_type='contact'` rows to scope='tenant' (Public). Per Basit's
-- "contacts private by default" rule, that's wrong — contacts should be
-- user-scoped, and tenant-wide visibility is opt-in via the publish
-- endpoint.
--
-- This script:
--   1. Identifies contacts that have scope='tenant' + owner_user_id IS NULL
--      (the signature of my over-promotion — legitimate tenant contacts
--      have an explicit owner who published them).
--   2. Sets owner_user_id=2 (Basit, the single user in TMC-0001 today).
--   3. Resets scope='user'.
--
-- For the single-user tenant this is safe: all contacts belong to Basit
-- and are private to him. When TMC adds more users later, the proper
-- per-user ownership backfill is a separate workstream.
--
-- Accounts (entity_type='account') remain scope='tenant' — they're
-- legitimately org-shared.

BEGIN;

-- Archive before revert
CREATE TABLE IF NOT EXISTS entities_overpromoted_2026_05_23 AS
  SELECT * FROM entities WHERE FALSE;
INSERT INTO entities_overpromoted_2026_05_23
SELECT * FROM entities
WHERE entity_type='contact'
  AND client_number='TMC-0001'
  AND scope='tenant'
  AND owner_user_id IS NULL;

\echo '── PRE-REVERT COUNTS ──'
SELECT
  'contacts scope=tenant owner=null (over-promoted)' AS state,
  COUNT(*) AS count
FROM entities
WHERE entity_type='contact' AND client_number='TMC-0001'
  AND scope='tenant' AND owner_user_id IS NULL;

-- Revert
UPDATE entities
SET owner_user_id = 2,
    scope = 'user'
WHERE entity_type='contact'
  AND client_number='TMC-0001'
  AND scope='tenant'
  AND owner_user_id IS NULL;

\echo '── POST-REVERT COUNTS ──'
SELECT entity_type, scope, COUNT(*)
FROM entities
WHERE client_number='TMC-0001'
GROUP BY entity_type, scope
ORDER BY entity_type, scope;

COMMIT;

\echo '── DONE. Archive table entities_overpromoted_2026_05_23 retains pre-revert state. ──'
