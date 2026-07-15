-- Repoint cross-user-leaked contacts v4 (2026-05-25)
--
-- v3 missed rows with status='orphan'. Those rows are still VISIBLE in
-- the catalog list (entityCatalogRoutes only excludes archived/inactive
-- /deleted/contradicted), so they're part of the leak surface from the
-- user's POV. Concrete miss: rfurnivall@winterhawk.com — status=orphan,
-- owned by user 2, but the single feed_event for that address is owned
-- by user 3 (Haseeb).
--
-- v4: source set now is "every entity_person row this user can see and
-- is still considered live". Same unwrap + duplicate-bucket logic as v3.

BEGIN;

DROP TABLE IF EXISTS wiki_pages_repointed_v4_2026_05_25;
CREATE TABLE wiki_pages_repointed_v4_2026_05_25 AS
  SELECT *, NULL::int AS new_user_id, NULL::text AS action FROM wiki_pages WHERE FALSE;

WITH owned_by_basit AS (
  SELECT id, title, status, lower(metadata->>'email') AS email
  FROM wiki_pages
  WHERE page_type='entity_person'
    AND client_number='TMC-0001'
    AND user_id = 2
    AND status NOT IN ('archived','inactive','deleted','contradicted')
),
feed AS (
  SELECT lower(COALESCE(substring(sender_email FROM '<([^>]+)>'), sender_email)) AS email,
         user_id, COUNT(*) AS events
  FROM feed_events
  WHERE client_number='TMC-0001' AND sender_email IS NOT NULL
  GROUP BY 1, 2
),
to_repoint AS (
  SELECT o.id, o.title, o.status AS pre_status, o.email,
         (SELECT user_id FROM feed f
            WHERE f.email = o.email
            ORDER BY events DESC LIMIT 1) AS new_owner
  FROM owned_by_basit o
  WHERE EXISTS (SELECT 1 FROM feed f WHERE f.email = o.email AND f.user_id <> 2)
    AND NOT EXISTS (SELECT 1 FROM feed f WHERE f.email = o.email AND f.user_id = 2)
)
INSERT INTO wiki_pages_repointed_v4_2026_05_25
SELECT w.*, t.new_owner AS new_user_id,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM wiki_pages w2
       WHERE w2.client_number = w.client_number
         AND w2.user_id = t.new_owner
         AND w2.page_type = 'entity_person'
         AND w2.title = w.title
         AND w2.id <> w.id
    ) THEN 'archive_duplicate'
    ELSE 'repoint'
  END AS action
FROM wiki_pages w
JOIN to_repoint t ON t.id = w.id;

\echo '── v4 PLAN ──'
SELECT action, new_user_id AS new_owner, COUNT(*) AS rows
FROM wiki_pages_repointed_v4_2026_05_25
GROUP BY 1, 2 ORDER BY 1, 2;

\echo '── v4 SAMPLE (status mix) ──'
SELECT title, metadata->>'email' AS email, status AS pre_status, new_user_id, action
FROM wiki_pages_repointed_v4_2026_05_25
ORDER BY status, title
LIMIT 50;

UPDATE wiki_pages w
   SET status = 'archived',
       metadata = COALESCE(w.metadata, '{}'::jsonb) || jsonb_build_object(
         'archivedReason', 'leaked_duplicate_of_real_owner',
         'archivedAt',     NOW()::text,
         'archivedBy',     'repoint_v4_2026_05_25',
         'leakedFromUserId', 2,
         'realOwnerUserId',  a.new_user_id
       ),
       last_updated_at = NOW(),
       last_updated_by = 'repoint_v4_2026_05_25'
  FROM wiki_pages_repointed_v4_2026_05_25 a
 WHERE w.id = a.id AND a.action = 'archive_duplicate';

UPDATE wiki_pages w
   SET user_id = a.new_user_id,
       last_updated_at = NOW(),
       last_updated_by = 'repoint_v4_2026_05_25'
  FROM wiki_pages_repointed_v4_2026_05_25 a
 WHERE w.id = a.id AND a.action = 'repoint';

\echo '── POST-v4: ownership distribution (visible statuses) ──'
SELECT user_id AS owner, COUNT(*) AS contacts
FROM wiki_pages
WHERE page_type='entity_person'
  AND client_number='TMC-0001'
  AND status NOT IN ('archived','inactive','deleted','contradicted')
GROUP BY 1 ORDER BY 2 DESC;

\echo '── Remaining suspect rows after v4 (should be 0) ──'
WITH ob AS (
  SELECT id, lower(metadata->>'email') AS email FROM wiki_pages
  WHERE page_type='entity_person' AND client_number='TMC-0001'
    AND user_id = 2
    AND status NOT IN ('archived','inactive','deleted','contradicted')
),
f AS (
  SELECT lower(COALESCE(substring(sender_email FROM '<([^>]+)>'), sender_email)) AS email,
         user_id FROM feed_events
  WHERE client_number='TMC-0001' AND sender_email IS NOT NULL
)
SELECT COUNT(*) AS still_suspect FROM ob o
WHERE EXISTS (SELECT 1 FROM f WHERE f.email=o.email AND f.user_id<>2)
  AND NOT EXISTS (SELECT 1 FROM f WHERE f.email=o.email AND f.user_id=2);

COMMIT;

\echo '── DONE. Archive in wiki_pages_repointed_v4_2026_05_25. ──'
