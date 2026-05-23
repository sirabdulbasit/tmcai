-- REAL revert (2026-05-23): the Contacts UI reads visibility from
-- wiki_pages.metadata.scope (NOT entities.scope — that was my mistake).
-- The "Public" badge fires when metadata.scope = 'tenant'.
--
-- I previously updated entities.scope, but the UI doesn't read that
-- field. This script targets the correct column.
--
-- Goal: any wiki_pages entity_person row currently marked
-- metadata.scope='tenant' that wasn't explicitly published by the user
-- (no publicSetBy field) gets reset to 'normal' (private/personal).
--
-- Per Basit's "contacts private by default" rule.

BEGIN;

-- Archive before revert
CREATE TABLE IF NOT EXISTS wiki_pages_contact_overpromoted_2026_05_23 AS
  SELECT * FROM wiki_pages WHERE FALSE;
INSERT INTO wiki_pages_contact_overpromoted_2026_05_23
SELECT * FROM wiki_pages
WHERE page_type='entity_person'
  AND client_number='TMC-0001'
  AND metadata->>'scope' = 'tenant'
  AND (metadata->>'publicSetBy' IS NULL OR metadata->>'publicSetBy' = '');

\echo '── PRE-REVERT COUNTS ──'
SELECT
  COALESCE(metadata->>'scope', '(null)') AS scope,
  COUNT(*) AS count
FROM wiki_pages
WHERE page_type='entity_person' AND client_number='TMC-0001'
GROUP BY metadata->>'scope'
ORDER BY count DESC;

-- Revert metadata.scope = 'tenant' to 'normal' for rows that don't
-- have a publicSetBy (i.e., never explicitly published by the user).
UPDATE wiki_pages
SET metadata = jsonb_set(
  CASE
    WHEN metadata IS NULL THEN '{}'::jsonb
    ELSE metadata
  END,
  '{scope}',
  '"normal"'::jsonb
)
WHERE page_type='entity_person'
  AND client_number='TMC-0001'
  AND metadata->>'scope' = 'tenant'
  AND (metadata->>'publicSetBy' IS NULL OR metadata->>'publicSetBy' = '');

\echo '── POST-REVERT COUNTS ──'
SELECT
  COALESCE(metadata->>'scope', '(null)') AS scope,
  COUNT(*) AS count
FROM wiki_pages
WHERE page_type='entity_person' AND client_number='TMC-0001'
GROUP BY metadata->>'scope'
ORDER BY count DESC;

COMMIT;

\echo '── DONE. Archive: wiki_pages_contact_overpromoted_2026_05_23. ──'
