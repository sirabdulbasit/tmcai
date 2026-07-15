-- Repoint cross-user-leaked contacts (2026-05-25)
--
-- Symptom (reported by Basit 2026-05-25): incognito Contacts list shows
-- contacts like katja.kuhn@sap.com that Basit never corresponded with.
-- Investigation (this session) confirmed 29 entity_person rows owned by
-- user_id=2 (Basit) where the feed_events for the same email ONLY exist
-- under user_id=3 (Haseeb). Those rows came from Haseeb's Gmail but
-- got attributed to Basit due to:
--   (a) early sweep query used MIN(user_id) tenant-wide before the
--       2026-05-23 user-filter fix landed
--   (b) reset-and-rebuild before the user-filter fix walked the whole
--       tenant's feed_events but stamped them all to the caller
--   (c) conceptSynthesizer's findFirst({ userId: mdUser=lowest_active })
--       never finds the right-owner row, so leak self-perpetuates
--
-- This script: for every active entity_person row owned by user 2 where
-- the email has feed_events only from user 3 (and not from user 2),
-- reassign user_id to user 3. Archive the original row first.
--
-- Reversible: every modified row is in wiki_pages_repointed_2026_05_25
-- with its pre-repoint state, restore via:
--   UPDATE wiki_pages w
--      SET user_id = a.user_id
--     FROM wiki_pages_repointed_2026_05_25 a
--    WHERE w.id = a.id;

BEGIN;

-- Archive everything we're about to repoint.
CREATE TABLE IF NOT EXISTS wiki_pages_repointed_2026_05_25 AS
  SELECT *, NULL::int AS new_user_id FROM wiki_pages WHERE FALSE;

WITH owned_by_basit AS (
  SELECT id, lower(metadata->>'email') AS email
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
-- Rows to repoint: Basit owns them, email has feed_events from another
-- user, and ZERO feed_events from Basit himself.
to_repoint AS (
  SELECT o.id, o.email,
         (SELECT user_id FROM feed f
            WHERE f.email = o.email
            ORDER BY events DESC LIMIT 1) AS new_owner
  FROM owned_by_basit o
  WHERE EXISTS (
    SELECT 1 FROM feed f WHERE f.email = o.email AND f.user_id <> 2
  )
  AND NOT EXISTS (
    SELECT 1 FROM feed f WHERE f.email = o.email AND f.user_id = 2
  )
)
INSERT INTO wiki_pages_repointed_2026_05_25
SELECT w.*, t.new_owner AS new_user_id
FROM wiki_pages w
JOIN to_repoint t ON t.id = w.id;

\echo '── PRE-REPOINT: how many rows are about to flip, by new owner? ──'
SELECT new_user_id AS new_owner_user_id, COUNT(*) AS rows_to_repoint
FROM wiki_pages_repointed_2026_05_25
GROUP BY 1 ORDER BY 1;

-- Apply the repoint.
UPDATE wiki_pages w
   SET user_id = a.new_user_id,
       last_updated_at = NOW(),
       last_updated_by = 'repoint_leaked_2026_05_25'
  FROM wiki_pages_repointed_2026_05_25 a
 WHERE w.id = a.id
   AND w.user_id <> a.new_user_id;

\echo '── POST-REPOINT: distribution of entity_person ownership in this tenant ──'
SELECT user_id AS owner_user_id, COUNT(*) AS contacts
FROM wiki_pages
WHERE page_type='entity_person'
  AND client_number='TMC-0001'
  AND status='active'
GROUP BY 1 ORDER BY 2 DESC;

\echo '── How many active contacts you (Basit, user 2) now own? ──'
SELECT COUNT(*) AS basit_owned_active
FROM wiki_pages
WHERE page_type='entity_person'
  AND client_number='TMC-0001'
  AND user_id = 2
  AND status='active';

COMMIT;

\echo '── DONE. Archive table wiki_pages_repointed_2026_05_25 has the pre-repoint snapshot. ──'
