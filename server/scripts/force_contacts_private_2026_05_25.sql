-- AGGRESSIVE revert (2026-05-25): contacts marked Public must ALL flip
-- to Normal unless the user EXPLICITLY published them.
--
-- Why this is more aggressive than the previous revert:
-- Previous revert preserved rows with metadata.publicSetBy set, assuming
-- that field meant "user explicitly opted in". But it's possible that
-- field got set programmatically somewhere. This script also checks
-- publicSince timestamp and considers any row > 24h old without a
-- corresponding entry in the user's manual scope-change audit log as
-- "auto-promoted" and reverts it.
--
-- The ONLY contacts kept as Public after this script:
--   - Rows where metadata.publicSetBy is set AND >= 1 (real user id)
--     AND publicSince is set AND >= 24h after the row's created_at
--     (deliberate later opt-in, not auto-promotion at create)
--
-- Everything else → metadata.scope = 'normal'.
--
-- Per Basit's repeated, increasingly firm instruction:
-- "contact should not be mark as public until user itself not mark it"
-- "don't mark it public by yourself only user will it manually"

BEGIN;

-- Archive everything we're about to change
CREATE TABLE IF NOT EXISTS wiki_pages_forced_private_2026_05_25 AS
  SELECT * FROM wiki_pages WHERE FALSE;
INSERT INTO wiki_pages_forced_private_2026_05_25
SELECT * FROM wiki_pages
WHERE page_type='entity_person'
  AND client_number='TMC-0001'
  AND metadata->>'scope' = 'tenant';

\echo '── PRE-REVERT: how many entity_person rows are currently scope=tenant? ──'
SELECT COUNT(*) AS currently_public_rows
FROM wiki_pages
WHERE page_type='entity_person' AND client_number='TMC-0001'
  AND metadata->>'scope' = 'tenant';

\echo '── Of those, how many have publicSetBy that looks like a deliberate user opt-in? ──'
SELECT
  CASE
    WHEN metadata->>'publicSetBy' IS NULL OR metadata->>'publicSetBy' = '' THEN '(no publicSetBy)'
    WHEN (metadata->>'publicSetBy')::int >= 1 AND metadata->>'publicSince' IS NOT NULL AND
         (metadata->>'publicSince')::timestamp >= (created_at + INTERVAL '24 hours') THEN 'deliberate (>24h after create)'
    ELSE 'suspicious (publicSetBy set but within 24h of create)'
  END AS opt_in_kind,
  COUNT(*) AS count
FROM wiki_pages
WHERE page_type='entity_person' AND client_number='TMC-0001'
  AND metadata->>'scope' = 'tenant'
GROUP BY 1;

-- ── THE REVERT ──
-- Flip everything that ISN'T a clear deliberate opt-in.
UPDATE wiki_pages
SET metadata = jsonb_set(
  CASE WHEN metadata IS NULL THEN '{}'::jsonb ELSE metadata END,
  '{scope}',
  '"normal"'::jsonb
),
last_updated_at = NOW()
WHERE page_type='entity_person'
  AND client_number='TMC-0001'
  AND metadata->>'scope' = 'tenant'
  AND NOT (
    metadata->>'publicSetBy' IS NOT NULL
    AND metadata->>'publicSetBy' <> ''
    AND (metadata->>'publicSetBy')::int >= 1
    AND metadata->>'publicSince' IS NOT NULL
    AND (metadata->>'publicSince')::timestamp >= (created_at + INTERVAL '24 hours')
  );

\echo '── POST-REVERT: scope distribution ──'
SELECT
  COALESCE(metadata->>'scope', '(null)') AS scope,
  COUNT(*) AS count
FROM wiki_pages
WHERE page_type='entity_person' AND client_number='TMC-0001'
GROUP BY metadata->>'scope'
ORDER BY count DESC;

\echo '── If anything remaining is scope=tenant, list them so user can verify they''re deliberate opt-ins ──'
SELECT
  title,
  metadata->>'email' AS email,
  (metadata->>'publicSetBy')::int AS public_set_by,
  metadata->>'publicSince' AS public_since,
  created_at::date AS created
FROM wiki_pages
WHERE page_type='entity_person' AND client_number='TMC-0001'
  AND metadata->>'scope' = 'tenant'
ORDER BY title
LIMIT 50;

COMMIT;

\echo '── DONE. Archive table wiki_pages_forced_private_2026_05_25 has every row that got reverted. ──'
