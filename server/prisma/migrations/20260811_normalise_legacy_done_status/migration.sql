-- DEF-129 — normalise the legacy `DONE` status to `CLOSED`.
--
-- Six production items sit in `DONE`, which is NOT one of the v15 statuses. The
-- 2026-04-19 backfill translated the legacy vocabulary (`done` -> `CLOSED`) but
-- matched lowercase only, so anything already uppercased was left behind.
--
-- The consequence was worse than untidy: `transitionStatus` refuses an item
-- whose CURRENT status is outside the lifecycle —
--   "current status DONE is not in the v15 lifecycle — migrate first"
-- so those six items were UNMOVABLE by any path. No UI action, no Brain action,
-- no job could change them.
--
-- `DONE` is deliberately NOT being added as a status. It is a synonym for
-- `CLOSED` with no distinct meaning, and a second name for one state is how the
-- vocabulary drifted in the first place.
--
-- AUDITED: every row changed here writes its own `item_status_history` entry, so
-- the normalisation is visible in the same ledger as every other transition.
-- `actor = 'system'` and the reason names this migration — no row is altered
-- without a record of why.
--
-- IDEMPOTENT: re-running finds no `DONE` rows and writes nothing.

DO $$
DECLARE
  moved INTEGER := 0;
BEGIN
  -- The ledger row is written FIRST, from the same predicate, so a failure
  -- part-way cannot leave a status change with no audit. Both statements run in
  -- this block's implicit transaction.
  INSERT INTO "item_status_history"
    ("client_number", "user_id", "open_item_id", "from_status", "to_status", "outcome", "reason", "actor", "created_at")
  SELECT
    oi."client_number", oi."user_id", oi."id", 'DONE', 'CLOSED', 'accepted',
    'DEF-129: legacy DONE normalised to CLOSED (migration 20260811_normalise_legacy_done_status)',
    'system', NOW()
  FROM "open_items" oi
  WHERE oi."status" = 'DONE';

  GET DIAGNOSTICS moved = ROW_COUNT;

  UPDATE "open_items" SET "status" = 'CLOSED', "updated_at" = NOW() WHERE "status" = 'DONE';

  IF moved > 0 THEN
    RAISE NOTICE 'DEF-129: normalised % legacy DONE item(s) to CLOSED, each with an audit row', moved;
  END IF;
END $$;

-- Verification (run by hand after applying):
--
--   SELECT status, count(*) FROM open_items GROUP BY 1 ORDER BY 2 DESC;
--     -- expect NO 'DONE' row
--
--   SELECT count(*) FROM item_status_history WHERE from_status = 'DONE';
--     -- expect one row per item normalised, and unchanged on a re-run
