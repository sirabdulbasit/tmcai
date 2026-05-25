-- Repoint cross-user-leaked contacts v3 (2026-05-25)
--
-- v2 missed rows whose feed_events.sender_email is in RFC2822 wrap
-- format like '"Last, First" <email@x>'. The bare lower() match failed
-- because the column contained the whole display-name+email string.
-- Concrete miss: balram.singh@sap.com — Haseeb's feed_events all have
-- sender_email = '"Singh, Balram (external - Service)" <balram.singh@sap.com>'.
--
-- v3: extract the bare email from sender_email using
-- substring(sender_email FROM '<([^>]+)>') when wrapped, else use the
-- raw column. Idempotent — re-running after v2 only acts on newly-
-- caught rows.

BEGIN;

-- Use a fresh archive table for v3 so v2's archive stays intact.
DROP TABLE IF EXISTS wiki_pages_repointed_v3_2026_05_25;
CREATE TABLE wiki_pages_repointed_v3_2026_05_25 AS
  SELECT *, NULL::int AS new_user_id, NULL::text AS action FROM wiki_pages WHERE FALSE;

WITH owned_by_basit AS (
  SELECT id, title, lower(metadata->>'email') AS email
  FROM wiki_pages
  WHERE page_type='entity_person'
    AND client_number='TMC-0001'
    AND user_id = 2
    AND status='active'
),
-- Strip RFC2822 wrap: '"Name" <email>' → 'email'. Falls back to raw
-- sender_email when no <...> wrap is present.
feed AS (
  SELECT
    lower(COALESCE(
      substring(sender_email FROM '<([^>]+)>'),
      sender_email
    )) AS email,
    user_id,
    COUNT(*) AS events
  FROM feed_events
  WHERE client_number='TMC-0001'
    AND sender_email IS NOT NULL
  GROUP BY 1, 2
),
to_repoint AS (
  SELECT o.id, o.title, o.email,
         (SELECT user_id FROM feed f
            WHERE f.email = o.email
            ORDER BY events DESC LIMIT 1) AS new_owner
  FROM owned_by_basit o
  WHERE EXISTS (SELECT 1 FROM feed f WHERE f.email = o.email AND f.user_id <> 2)
    AND NOT EXISTS (SELECT 1 FROM feed f WHERE f.email = o.email AND f.user_id = 2)
)
INSERT INTO wiki_pages_repointed_v3_2026_05_25
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

\echo '── v3 PLAN: how many newly-caught rows in each bucket? ──'
SELECT action, new_user_id AS new_owner, COUNT(*) AS rows
FROM wiki_pages_repointed_v3_2026_05_25
GROUP BY 1, 2
ORDER BY 1, 2;

\echo '── v3 SAMPLE rows (first 30) ──'
SELECT title, metadata->>'email' AS email, new_user_id, action
FROM wiki_pages_repointed_v3_2026_05_25
ORDER BY action, title
LIMIT 30;

-- Bucket A: archive duplicates.
UPDATE wiki_pages w
   SET status = 'archived',
       metadata = COALESCE(w.metadata, '{}'::jsonb) || jsonb_build_object(
         'archivedReason', 'leaked_duplicate_of_real_owner',
         'archivedAt',     NOW()::text,
         'archivedBy',     'repoint_v3_2026_05_25',
         'leakedFromUserId', 2,
         'realOwnerUserId',  a.new_user_id
       ),
       last_updated_at = NOW(),
       last_updated_by = 'repoint_v3_2026_05_25'
  FROM wiki_pages_repointed_v3_2026_05_25 a
 WHERE w.id = a.id
   AND a.action = 'archive_duplicate';

-- Bucket B: repoint user_id.
UPDATE wiki_pages w
   SET user_id = a.new_user_id,
       last_updated_at = NOW(),
       last_updated_by = 'repoint_v3_2026_05_25'
  FROM wiki_pages_repointed_v3_2026_05_25 a
 WHERE w.id = a.id
   AND a.action = 'repoint';

\echo '── POST-v3: entity_person ownership distribution (active only) ──'
SELECT user_id AS owner_user_id, COUNT(*) AS contacts
FROM wiki_pages
WHERE page_type='entity_person'
  AND client_number='TMC-0001'
  AND status='active'
GROUP BY 1 ORDER BY 2 DESC;

\echo '── Remaining suspect rows after v3 (should be 0) ──'
WITH owned_by_basit AS (
  SELECT id, lower(metadata->>'email') AS email FROM wiki_pages
  WHERE page_type='entity_person' AND client_number='TMC-0001'
    AND user_id = 2 AND status='active'
),
feed AS (
  SELECT lower(COALESCE(substring(sender_email FROM '<([^>]+)>'), sender_email)) AS email,
         user_id
  FROM feed_events
  WHERE client_number='TMC-0001' AND sender_email IS NOT NULL
)
SELECT COUNT(*) AS still_suspect FROM owned_by_basit o
WHERE EXISTS (SELECT 1 FROM feed f WHERE f.email=o.email AND f.user_id<>2)
  AND NOT EXISTS (SELECT 1 FROM feed f WHERE f.email=o.email AND f.user_id=2);

COMMIT;

\echo '── DONE. Archive in wiki_pages_repointed_v3_2026_05_25. ──'
