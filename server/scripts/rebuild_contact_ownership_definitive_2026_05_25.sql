-- DEFINITIVE contact ownership rebuild (2026-05-25)
--
-- Replaces the v2/v3/v4 incremental scripts with one comprehensive
-- evidence-based rebuild that handles every entity_person row in the
-- tenant in one pass.
--
-- Rule (explicit, auditable):
--   For each entity_person row R, compute per-user claims:
--     claim_score = (feed_events count for user matching R's email/phone)
--                 + (10 if user has any user-action audit field on R)
--                 + (5  if R was imported by user via google_contacts)
--                 + (1  if R was manually added by user)
--   Owner = argmax(claim_score) over users in the tenant.
--   Tiebreaker: lowest user_id (consistent with sweep).
--   No claim from any user → archive with archivedReason='no_evidence'.
--
-- Operations are wrapped in a single transaction. If anything fails,
-- nothing changes. Pre-state archived to wiki_pages_definitive_rebuild_2026_05_25.

BEGIN;

DROP TABLE IF EXISTS wiki_pages_definitive_rebuild_2026_05_25;
CREATE TABLE wiki_pages_definitive_rebuild_2026_05_25 AS
  SELECT *,
         NULL::int  AS new_user_id,
         NULL::text AS action,
         NULL::jsonb AS claim_scores
  FROM wiki_pages WHERE FALSE;

-- ── Compute per-row claims for every user in the tenant ──────────
WITH tenant_users AS (
  SELECT id AS user_id FROM users WHERE client_number='TMC-0001' AND is_active = TRUE
),
all_rows AS (
  SELECT id, title, user_id, status, metadata,
         lower(metadata->>'email') AS email,
         regexp_replace(coalesce(metadata->>'phone',''), '[^0-9+]', '', 'g') AS phone_digits
  FROM wiki_pages
  WHERE page_type='entity_person'
    AND client_number='TMC-0001'
    AND status NOT IN ('deleted')
),
-- All feed_events evidence, unwrapped + raw-payload scan
feed_evidence AS (
  SELECT
    fe.user_id,
    lower(COALESCE(substring(fe.sender_email FROM '<([^>]+)>'), fe.sender_email)) AS email,
    regexp_replace(coalesce(fe.sender_phone,''), '[^0-9+]', '', 'g') AS phone_digits,
    COUNT(*)::int AS events
  FROM feed_events fe
  WHERE fe.client_number='TMC-0001'
  GROUP BY 1, 2, 3
),
-- Per (row, user) claim score
claims AS (
  SELECT
    r.id AS row_id,
    u.user_id,
    -- Feed events for this user matching by email
    COALESCE((
      SELECT SUM(events)::int FROM feed_evidence f
       WHERE f.user_id = u.user_id
         AND (
              (r.email <> '' AND f.email = r.email)
           OR (r.phone_digits <> '' AND f.phone_digits = r.phone_digits)
         )
    ), 0)
    -- Raw-payload broader scan (catches To/Cc, calendar attendees, etc.)
    + COALESCE((
      SELECT COUNT(*)::int FROM feed_events fe2
       WHERE fe2.client_number='TMC-0001'
         AND fe2.user_id = u.user_id
         AND r.email <> ''
         AND lower(fe2.raw_payload::text) LIKE '%' || r.email || '%'
    ), 0)
    -- User-action audit (starred / published / muted / renamed / inactive)
    + CASE
        WHEN (r.metadata->'user_stars')->>(u.user_id::text) IS NOT NULL
          OR (r.metadata->>'publicSetBy')::int = u.user_id
          OR (r.metadata->>'brainMutedBy')::int = u.user_id
          OR (r.metadata->>'markedInactiveBy')::int = u.user_id
          OR ((r.metadata->>'userRenamed')::boolean = TRUE AND r.user_id = u.user_id)
        THEN 10 ELSE 0
      END
    -- Imported via Google Contacts BY this user
    + CASE
        WHEN r.metadata->>'imported_from' = 'google_contacts'
          AND COALESCE((r.metadata->>'imported_by')::int, r.user_id) = u.user_id
        THEN 5 ELSE 0
      END
    -- Manually added BY this user
    + CASE
        WHEN r.metadata->>'source' = 'manual' AND r.user_id = u.user_id
        THEN 1 ELSE 0
      END AS claim_score
  FROM all_rows r
  CROSS JOIN tenant_users u
),
-- Pick best owner per row. NULL when no user has any claim.
best_owner AS (
  SELECT DISTINCT ON (row_id)
    row_id,
    user_id AS new_owner,
    claim_score
  FROM claims
  WHERE claim_score > 0
  ORDER BY row_id, claim_score DESC, user_id ASC
),
-- Determine action per row.
plan AS (
  SELECT
    r.id, r.title, r.user_id AS cur_owner, r.status AS cur_status,
    bo.new_owner,
    bo.claim_score,
    (SELECT jsonb_object_agg(c.user_id::text, c.claim_score)
       FROM claims c WHERE c.row_id = r.id AND c.claim_score > 0) AS claim_scores,
    CASE
      WHEN bo.new_owner IS NULL THEN 'archive_no_evidence'
      WHEN bo.new_owner = r.user_id THEN 'keep'
      WHEN EXISTS (
        SELECT 1 FROM wiki_pages w2
         WHERE w2.client_number='TMC-0001'
           AND w2.user_id = bo.new_owner
           AND w2.page_type = 'entity_person'
           AND w2.title = r.title
           AND w2.id <> r.id
      ) THEN 'archive_duplicate'
      ELSE 'repoint'
    END AS action
  FROM all_rows r
  LEFT JOIN best_owner bo ON bo.row_id = r.id
)
INSERT INTO wiki_pages_definitive_rebuild_2026_05_25
SELECT w.*, p.new_owner AS new_user_id, p.action, p.claim_scores
FROM wiki_pages w
JOIN plan p ON p.id = w.id
WHERE p.action <> 'keep';

\echo '── PLAN: action counts ──'
SELECT action, COUNT(*) FROM wiki_pages_definitive_rebuild_2026_05_25 GROUP BY 1 ORDER BY 2 DESC;

\echo '── PLAN: ownership delta (where new_user_id is set) ──'
SELECT user_id AS from_owner, new_user_id AS to_owner, COUNT(*)
FROM wiki_pages_definitive_rebuild_2026_05_25
WHERE new_user_id IS NOT NULL
GROUP BY 1, 2 ORDER BY 1, 2;

\echo '── SAMPLE: 30 rows about to be repointed (with claim scores) ──'
SELECT title, metadata->>'email' AS email, user_id AS from_owner, new_user_id AS to_owner, claim_scores
FROM wiki_pages_definitive_rebuild_2026_05_25
WHERE action = 'repoint'
ORDER BY title
LIMIT 30;

\echo '── SAMPLE: 30 rows about to be archived as no-evidence ──'
SELECT title, metadata->>'email' AS email, user_id AS cur_owner, status AS cur_status
FROM wiki_pages_definitive_rebuild_2026_05_25
WHERE action = 'archive_no_evidence'
ORDER BY title
LIMIT 30;

-- ── Apply actions ────────────────────────────────────────────────

-- A) archive_no_evidence
UPDATE wiki_pages w
   SET status = 'archived',
       metadata = COALESCE(w.metadata, '{}'::jsonb) || jsonb_build_object(
         'archivedReason', 'no_evidence',
         'archivedAt',     NOW()::text,
         'archivedBy',     'rebuild_definitive_2026_05_25'
       ),
       last_updated_at = NOW(),
       last_updated_by = 'rebuild_definitive_2026_05_25'
  FROM wiki_pages_definitive_rebuild_2026_05_25 a
 WHERE w.id = a.id AND a.action = 'archive_no_evidence';

-- B) archive_duplicate
UPDATE wiki_pages w
   SET status = 'archived',
       metadata = COALESCE(w.metadata, '{}'::jsonb) || jsonb_build_object(
         'archivedReason', 'leaked_duplicate_of_real_owner',
         'archivedAt',     NOW()::text,
         'archivedBy',     'rebuild_definitive_2026_05_25',
         'leakedFromUserId', w.user_id,
         'realOwnerUserId',  a.new_user_id
       ),
       last_updated_at = NOW(),
       last_updated_by = 'rebuild_definitive_2026_05_25'
  FROM wiki_pages_definitive_rebuild_2026_05_25 a
 WHERE w.id = a.id AND a.action = 'archive_duplicate';

-- C) repoint
UPDATE wiki_pages w
   SET user_id = a.new_user_id,
       last_updated_at = NOW(),
       last_updated_by = 'rebuild_definitive_2026_05_25'
  FROM wiki_pages_definitive_rebuild_2026_05_25 a
 WHERE w.id = a.id AND a.action = 'repoint';

\echo '── POST: ownership distribution (visible statuses) ──'
SELECT user_id AS owner, COUNT(*) AS contacts
FROM wiki_pages
WHERE page_type='entity_person'
  AND client_number='TMC-0001'
  AND status NOT IN ('archived','inactive','deleted','contradicted')
GROUP BY 1 ORDER BY 2 DESC;

\echo '── INVARIANT CHECK: any visible row where owner has 0 feed evidence (must be 0) ──'
WITH visible AS (
  SELECT id, user_id, lower(metadata->>'email') AS email,
         regexp_replace(coalesce(metadata->>'phone',''), '[^0-9+]', '', 'g') AS phone_digits,
         metadata
  FROM wiki_pages
  WHERE page_type='entity_person' AND client_number='TMC-0001'
    AND status NOT IN ('archived','inactive','deleted','contradicted')
),
feed AS (
  SELECT user_id,
         lower(COALESCE(substring(sender_email FROM '<([^>]+)>'), sender_email)) AS email,
         regexp_replace(coalesce(sender_phone,''), '[^0-9+]', '', 'g') AS phone_digits
  FROM feed_events
  WHERE client_number='TMC-0001'
)
SELECT COUNT(*) AS violations FROM visible v
WHERE NOT EXISTS (
        SELECT 1 FROM feed f
         WHERE f.user_id = v.user_id
           AND ((v.email <> '' AND f.email = v.email)
             OR (v.phone_digits <> '' AND f.phone_digits = v.phone_digits))
      )
  -- exempt rows kept on user-action evidence
  AND (v.metadata->'user_stars')->>(v.user_id::text) IS NULL
  AND COALESCE((v.metadata->>'publicSetBy')::int, -1) <> v.user_id
  AND COALESCE((v.metadata->>'brainMutedBy')::int, -1) <> v.user_id
  AND COALESCE((v.metadata->>'markedInactiveBy')::int, -1) <> v.user_id
  AND v.metadata->>'imported_from' <> 'google_contacts'
  AND v.metadata->>'source' <> 'manual';

COMMIT;

\echo '── DONE. Pre-state in wiki_pages_definitive_rebuild_2026_05_25. ──'
