-- Repair the due dates a hallucinated year wrote into production. DEF-249.
--
-- 2026-08-27 10:23 PKT the owner wrote "we have got extension of Imperialsoft credits up to 28th
-- October" — no year — and Brain answered `[new deadline recorded: 2024-10-28]`. The year is the
-- model's invention. `actionLifecycleService` accepted its date on Number.isFinite alone, so
-- DEF-017's sanity window (which lives inside `parseDuePhrase`, the FALLBACK) never ran.
--
-- Two rows carry a 2024 date. They are permanently overdue, so Brain nags about them daily and
-- will keep doing so until the dates are corrected — the code fix stops new ones and does nothing
-- for these.
--
-- The two are treated DIFFERENTLY on purpose, because the evidence differs:
--
--   "Decide on Imperialsoft services termination date"  2024-10-28 → 2026-10-28
--       He named the date in the same sentence, and the item created from that same utterance a
--       second later got 2026-10-28 through the other code path. The intended year is not a
--       guess; it is recorded elsewhere in the same turn.
--
--   "Escalate GCP Credit Extension for Imperial Soft"   2024-08-28 → NULL
--       Nothing in the record says what year was meant. Setting it to NULL routes the item into
--       the existing "no deadline — ask him" path, which is the honest outcome. Inventing 2026
--       here would repeat the exact mistake this migration exists to repair.

UPDATE open_items
   SET due_date = TIMESTAMP '2026-10-28 00:00:00'
 WHERE title = 'Decide on Imperialsoft services termination date'
   AND due_date < TIMESTAMP '2025-01-01';

UPDATE open_items
   SET due_date = NULL
 WHERE due_date IS NOT NULL
   AND due_date < TIMESTAMP '2025-01-01';
