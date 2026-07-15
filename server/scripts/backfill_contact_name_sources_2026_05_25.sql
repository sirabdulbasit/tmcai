-- Backfill WhatsApp contact name-source breakdown on existing
-- entity_person rows (2026-05-25)
--
-- Before this date, UserWebjsProvider extracted senderName as
-- `pushname || name || verifiedName` — losing whether the name came
-- from the user's saved contacts vs. the sender's WhatsApp pushname.
-- New code captures `contactNames` on every WA feed_event going
-- forward, but existing entity_person rows have the breakdown blank.
--
-- This script populates contactNames_* and isUserSavedContact on
-- entity_person rows by reading the most recent WA feed_event for
-- each contact (matched on normalized phone) that carries the new
-- raw_payload.contactNames structure.
--
-- Idempotent. Rows without any matching feed_event with contactNames
-- (because the new ingest hasn't seen them yet) are left untouched —
-- they'll get backfilled organically as new WA messages arrive.

BEGIN;

WITH latest_contact_names AS (
  SELECT
    regexp_replace(coalesce(sender_phone,''), '[^0-9+]','','g') AS phone_digits,
    (array_agg(raw_payload->'contactNames' ORDER BY created_at DESC)
       FILTER (WHERE raw_payload ? 'contactNames'))[1] AS cn
  FROM feed_events
  WHERE client_number='TMC-0001'
    AND source_type='whatsapp'
    AND sender_phone IS NOT NULL
  GROUP BY 1
  HAVING (array_agg(raw_payload->'contactNames' ORDER BY created_at DESC)
            FILTER (WHERE raw_payload ? 'contactNames'))[1] IS NOT NULL
)
UPDATE wiki_pages w
   SET metadata = w.metadata || jsonb_build_object(
         'contactNames_savedName',      lcn.cn->>'savedName',
         'contactNames_savedShortName', lcn.cn->>'savedShortName',
         'contactNames_pushname',       lcn.cn->>'pushname',
         'contactNames_verifiedName',   lcn.cn->>'verifiedName',
         'isUserSavedContact',          (lcn.cn->>'isUserSavedContact')::boolean,
         'contactNamesUpdatedAt',       NOW()::text,
         'contactNamesBackfilledAt',    NOW()::text
       ),
       last_updated_at = NOW(),
       last_updated_by = 'backfill_contact_name_sources_2026_05_25'
  FROM latest_contact_names lcn
 WHERE w.client_number='TMC-0001'
   AND w.page_type='entity_person'
   AND regexp_replace(coalesce(w.metadata->>'phone',''), '[^0-9+]','','g') = lcn.phone_digits
   AND lcn.phone_digits <> '';

\echo '── Backfill summary: how many rows now know they are user-saved vs pushname-only? ──'
SELECT
  CASE
    WHEN metadata->>'isUserSavedContact' = 'true'  THEN 'in_user_phonebook'
    WHEN metadata->>'isUserSavedContact' = 'false' THEN 'pushname_only'
    ELSE 'unknown (no contactNames data yet)'
  END AS status,
  COUNT(*) AS contacts
FROM wiki_pages
WHERE page_type='entity_person'
  AND client_number='TMC-0001'
  AND status NOT IN ('archived','inactive','deleted','contradicted')
  AND 'whatsapp' = ANY(ARRAY(SELECT jsonb_array_elements_text(COALESCE(metadata->'channels', '[]'::jsonb))))
GROUP BY 1
ORDER BY 2 DESC;

COMMIT;
\echo '── DONE. Future WA messages auto-populate contactNames on ingest. ──'
