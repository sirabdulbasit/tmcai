-- DEF-298 — a WhatsApp LID is not a phone number, and 24 contact pages still said it was.
--
-- DEF-245 (2026-08-25) fixed the WRITE path and cleaned the `entities` table: 26 rows whose
-- `phone` held a LID wearing a phone number's clothes. It did not clean the SAME values in
-- `wiki_pages.metadata.phone`, and nothing re-synthesised those pages, so 24 of them still
-- carry a 13+ digit LID in the one field every reader treats as a dialable number.
--
-- That is why the owner has now been shown a synthetic THREE times, most recently
-- "+109526195949711 (Mubarak Jharna Mahandri)" — which is exactly what row
-- `Mubarak Jharna Mahandri` holds. The DEF-293 guard was real and is deployed; it guards the
-- FORMATTER. This is the data.
--
-- Measured before writing: 24 rows, created 2026-05-23 to 2026-08-07, ZERO since DEF-245, and
-- `entities` has none. So this is residue, not a live writer.
--
-- The LID is MOVED, never dropped — DEF-245's own rule, and the right one: the value is a real
-- identifier that genuinely identifies this person to WhatsApp, it just is not a phone number.
-- Filed under `waLid`, where readers that want it can find it and a mistake stays reversible.
-- An existing `waLid` is never overwritten.
--
-- Idempotent: the WHERE clause stops matching once a row is converted, so re-running is a no-op.

UPDATE wiki_pages
   SET metadata = (metadata - 'phone')
                  || CASE
                       WHEN metadata ? 'waLid'
                         THEN '{}'::jsonb
                       ELSE jsonb_build_object('waLid', metadata->>'phone')
                     END
                  || jsonb_build_object('phoneWasLid', TRUE)
 WHERE page_type = 'entity_person'
   AND metadata->>'phone' IS NOT NULL
   AND length(regexp_replace(metadata->>'phone', '[^0-9]', '', 'g')) >= 13;
