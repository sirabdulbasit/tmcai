-- Contact ownership health check (cron / pre-deploy invariant)
--
-- Exits with a non-empty result set if ANY visible entity_person row
-- in any tenant has an owner with no evidence (no feed_events, no
-- user-action audit, no import path). Each violating row is a cross-
-- user leak by definition.
--
-- Wire as: psql "$DATABASE_URL" -f contact_ownership_health_check.sql
--   - empty result  = healthy
--   - any rows      = at least one leak; alert + investigate

\pset format aligned
\pset border 2
\pset title 'Contact ownership leaks (rows must be 0)'

WITH visible AS (
  SELECT id, client_number, user_id, title,
         lower(metadata->>'email') AS email,
         regexp_replace(coalesce(metadata->>'phone',''), '[^0-9+]', '', 'g') AS phone_digits,
         metadata
  FROM wiki_pages
  WHERE page_type='entity_person'
    AND status NOT IN ('archived','inactive','deleted','contradicted')
),
feed AS (
  SELECT client_number, user_id,
         lower(COALESCE(substring(sender_email FROM '<([^>]+)>'), sender_email)) AS email,
         regexp_replace(coalesce(sender_phone,''), '[^0-9+]', '', 'g') AS phone_digits
  FROM feed_events
)
SELECT v.client_number, v.user_id AS owner, v.title, v.email
FROM visible v
WHERE NOT EXISTS (
        SELECT 1 FROM feed f
         WHERE f.client_number = v.client_number
           AND f.user_id = v.user_id
           AND ((v.email <> '' AND f.email = v.email)
             OR (v.phone_digits <> '' AND f.phone_digits = v.phone_digits))
      )
  -- exempt: user-action evidence overrides missing feed evidence
  AND (v.metadata->'user_stars')->>(v.user_id::text) IS NULL
  AND COALESCE((v.metadata->>'publicSetBy')::int,    -1) <> v.user_id
  AND COALESCE((v.metadata->>'brainMutedBy')::int,   -1) <> v.user_id
  AND COALESCE((v.metadata->>'markedInactiveBy')::int, -1) <> v.user_id
  -- exempt: import paths (Google Contacts directory, manual add)
  AND COALESCE(v.metadata->>'imported_from','') <> 'google_contacts'
  AND COALESCE(v.metadata->>'source','')         <> 'manual'
ORDER BY client_number, owner, title;
