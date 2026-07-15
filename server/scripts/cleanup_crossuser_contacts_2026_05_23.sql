-- 2026-05-23: clean up contacts that Basit's reset-and-rebuild
-- incorrectly claimed from Haseeb's feed events.
--
-- The bug: sweepForTenant (pre-fix) queried feed_events tenant-wide,
-- then forceOwnerUserId=2 assigned everything to Basit. Result:
-- contacts that surfaced from Haseeb's (user_id=3) Gmail/Calendar got
-- created with owner=Basit but `metadata.discovered_by_users` showed
-- [3, 2] (Haseeb first, Basit added second).
--
-- This script finds those rows and deletes them. After deploy + a
-- clean re-run of reset-and-rebuild with the fixed sweep, Basit's
-- contacts will rebuild only from HIS own feed.
--
-- Per Basit 2026-05-23: "these contacts are not related to me i never
-- contact them through email, from where you get it??"
--
-- ARCHIVE BEFORE DELETE for 7-day rollback.

BEGIN;

-- Archive
CREATE TABLE IF NOT EXISTS wiki_pages_crossuser_cleanup_2026_05_23 AS
  SELECT * FROM wiki_pages WHERE FALSE;
INSERT INTO wiki_pages_crossuser_cleanup_2026_05_23
SELECT * FROM wiki_pages
WHERE client_number='TMC-0001'
  AND page_type='entity_person'
  AND user_id=2 -- Basit
  AND metadata->'discovered_by_users' IS NOT NULL
  AND jsonb_array_length(metadata->'discovered_by_users') > 0
  -- The discriminator: first element of discovered_by_users is NOT user 2.
  -- That means another user surfaced this contact first; Basit's
  -- rebuild claimed it incorrectly.
  AND (metadata->'discovered_by_users'->0)::int != 2
  -- Defensive: never delete contacts the user explicitly marked Public or Private.
  AND COALESCE(metadata->>'scope', 'normal') = 'normal'
  -- Defensive: never delete if user touched it (added a star, edited).
  AND COALESCE((metadata->>'userStars')::int, 0) = 0;

\echo '── PRE-CLEANUP COUNTS ──'
SELECT COUNT(*) AS contaminated_rows_about_to_delete
FROM wiki_pages
WHERE client_number='TMC-0001'
  AND page_type='entity_person'
  AND user_id=2
  AND metadata->'discovered_by_users' IS NOT NULL
  AND jsonb_array_length(metadata->'discovered_by_users') > 0
  AND (metadata->'discovered_by_users'->0)::int != 2
  AND COALESCE(metadata->>'scope', 'normal') = 'normal'
  AND COALESCE((metadata->>'userStars')::int, 0) = 0;

SELECT 'Basit contacts BEFORE' AS state, COUNT(*) AS count
FROM wiki_pages
WHERE client_number='TMC-0001' AND page_type='entity_person' AND user_id=2;

DELETE FROM wiki_pages
WHERE client_number='TMC-0001'
  AND page_type='entity_person'
  AND user_id=2
  AND metadata->'discovered_by_users' IS NOT NULL
  AND jsonb_array_length(metadata->'discovered_by_users') > 0
  AND (metadata->'discovered_by_users'->0)::int != 2
  AND COALESCE(metadata->>'scope', 'normal') = 'normal'
  AND COALESCE((metadata->>'userStars')::int, 0) = 0;

\echo '── POST-CLEANUP COUNTS ──'
SELECT 'Basit contacts AFTER' AS state, COUNT(*) AS count
FROM wiki_pages
WHERE client_number='TMC-0001' AND page_type='entity_person' AND user_id=2;

SELECT 'Archive table row count' AS state, COUNT(*) AS count
FROM wiki_pages_crossuser_cleanup_2026_05_23;

COMMIT;

\echo '── DONE. To restore: INSERT INTO wiki_pages SELECT * FROM wiki_pages_crossuser_cleanup_2026_05_23. ──'
