-- Repoint cross-user-leaked contacts v2 (2026-05-25)
--
-- v1 hit `wiki_pages_user_title_idx` (UNIQUE on
-- (client_number, user_id, page_type, title)) — the real-owner row
-- already exists in many cases (entitySweepService created it
-- correctly), and conceptSynthesizer created a duplicate under user 2.
-- A plain UPDATE user_id collides with the real row.
--
-- v2: for each leaked row, decide:
--   - if target owner already has a row with the same title (duplicate
--     of a real one)  →  mark the leaked row status='archived' with
--     metadata.archivedReason='leaked_duplicate'. Real row keeps the
--     interaction history.
--   - else (no real row yet)  →  flip user_id to the actual feeder.
--
-- Reversible: every modified row's pre-state is in
-- wiki_pages_repointed_v2_2026_05_25 along with the chosen action.

BEGIN;

DROP TABLE IF EXISTS wiki_pages_repointed_v2_2026_05_25;
CREATE TABLE wiki_pages_repointed_v2_2026_05_25 AS
  SELECT *, NULL::int AS new_user_id, NULL::text AS action FROM wiki_pages WHERE FALSE;

WITH owned_by_basit AS (
  SELECT id, title, lower(metadata->>'email') AS email
  FROM wiki_pages
  WHERE page_type='entity_person'
    AND client_number='TMC-0001'
    AND user_id = 2
    AND status='active'
),
feed AS (
  SELECT lower(sender_email) AS email, user_id, COUNT(*) AS events
  FROM feed_events
  WHERE client_number='TMC-0001' AND sender_email IS NOT NULL
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
INSERT INTO wiki_pages_repointed_v2_2026_05_25
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

\echo '── PLAN: how many rows in each bucket? ──'
SELECT action, new_user_id AS new_owner, COUNT(*) AS rows
FROM wiki_pages_repointed_v2_2026_05_25
GROUP BY 1, 2
ORDER BY 1, 2;

-- Bucket A: archive the leaked duplicate (real row already exists at
-- new_owner). Stamp metadata so we can recover or audit.
UPDATE wiki_pages w
   SET status = 'archived',
       metadata = COALESCE(w.metadata, '{}'::jsonb) || jsonb_build_object(
         'archivedReason', 'leaked_duplicate_of_real_owner',
         'archivedAt',     NOW()::text,
         'archivedBy',     'repoint_v2_2026_05_25',
         'leakedFromUserId', 2,
         'realOwnerUserId',  a.new_user_id
       ),
       last_updated_at = NOW(),
       last_updated_by = 'repoint_v2_2026_05_25'
  FROM wiki_pages_repointed_v2_2026_05_25 a
 WHERE w.id = a.id
   AND a.action = 'archive_duplicate';

-- Bucket B: flip user_id (no collision — Basit's row was the only one).
UPDATE wiki_pages w
   SET user_id = a.new_user_id,
       last_updated_at = NOW(),
       last_updated_by = 'repoint_v2_2026_05_25'
  FROM wiki_pages_repointed_v2_2026_05_25 a
 WHERE w.id = a.id
   AND a.action = 'repoint';

\echo '── POST-REPOINT: entity_person ownership distribution (active only) ──'
SELECT user_id AS owner_user_id, COUNT(*) AS contacts
FROM wiki_pages
WHERE page_type='entity_person'
  AND client_number='TMC-0001'
  AND status='active'
GROUP BY 1 ORDER BY 2 DESC;

\echo '── Basit (user 2) active contacts after repoint ──'
SELECT COUNT(*) FROM wiki_pages
WHERE page_type='entity_person' AND client_number='TMC-0001'
  AND user_id = 2 AND status='active';

\echo '── Any remaining suspect rows? (Basit owns, no Basit feed) ──'
WITH suspect AS (
  SELECT o.id, o.title, o.email FROM (
    SELECT id, title, lower(metadata->>'email') AS email FROM wiki_pages
    WHERE page_type='entity_person' AND client_number='TMC-0001'
      AND user_id = 2 AND status='active'
  ) o
  WHERE EXISTS (SELECT 1 FROM feed_events f
                 WHERE f.client_number='TMC-0001'
                   AND lower(f.sender_email)=o.email AND f.user_id<>2)
    AND NOT EXISTS (SELECT 1 FROM feed_events f
                     WHERE f.client_number='TMC-0001'
                       AND lower(f.sender_email)=o.email AND f.user_id=2)
)
SELECT COUNT(*) AS still_suspect FROM suspect;

COMMIT;

\echo '── DONE. Archive in wiki_pages_repointed_v2_2026_05_25 (action column = repoint or archive_duplicate) ──'
