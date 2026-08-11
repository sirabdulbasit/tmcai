-- DEF-132 — normalise EVERY remaining out-of-vocabulary `open_items.status`.
--
-- WHY A SECOND MIGRATION. `20260811_normalise_legacy_done_status` has already
-- been applied to production (D-22, 6 rows moved, 6 audit rows, re-run clean).
-- An applied migration is never edited — the tree would then disagree with what
-- the database actually ran, which is the drift these files exist to prevent.
-- So the widened repair lands here, on its own.
--
-- WHY IT IS NEEDED AT ALL. That migration matched `status = 'DONE'` — the one
-- spelling I had a count for. But the refusal in `transitionStatus` is not
-- name-specific:
--   "current status <X> is not in the v15 lifecycle — migrate first"
-- rejects ANY value outside the 9. And the writers that produced the drift
-- emitted more than one spelling: `cleanupDuplicateOpenItems` wrote `DONE`, the
-- backlog pruner wrote lowercase `closed` in five places, and the `archive`
-- action handler wrote lowercase `done` on a user-facing path. Fixing the six
-- rows I could see left every other spelling just as unmovable — the failure
-- already recorded in the evaluation chart as "a migration that silently did
-- nothing". **Repair by SHAPE, not by name.**
--
-- The writers are fixed in the same commit. Normalising rows while the writers
-- that mint them keep running is how six became six again.
--
-- AUDITED: every row changed writes its own `item_status_history` entry, from
-- the same join, so no status changes without a record of why.
--
-- IDEMPOTENT: after the first run no row matches a legacy key, so the insert
-- selects nothing and the update matches nothing.

DO $$
DECLARE
  moved INTEGER := 0;
  leftover TEXT;
BEGIN
  -- Dropped first so a re-run in the SAME session cannot fail on a leftover
  -- temp table, whichever transaction wrapper this file is applied under.
  DROP TABLE IF EXISTS _def132_map;
  CREATE TEMP TABLE _def132_map (legacy TEXT PRIMARY KEY, v15 TEXT NOT NULL) ON COMMIT DROP;

  -- Only spellings whose meaning is unambiguous appear here. Anything else is
  -- REPORTED below rather than guessed: inventing a status for a row nobody can
  -- interpret is how fabricated state enters the ledger.
  INSERT INTO _def132_map (legacy, v15) VALUES
    ('DONE', 'CLOSED'), ('done', 'CLOSED'),
    ('closed', 'CLOSED'),
    ('ARCHIVED', 'CLOSED'), ('archived', 'CLOSED'),
    ('cancelled', 'CANCELLED'),
    ('open', 'NEW'), ('new', 'NEW'),
    ('triaged', 'TRIAGED'),
    ('in_progress', 'IN_PROGRESS'),
    ('overdue', 'IN_PROGRESS'),
    ('delegated', 'DELEGATED'),
    ('blocked', 'WAITING_INFO'), ('waiting_info', 'WAITING_INFO'),
    ('snoozed', 'SNOOZED'),
    ('informed', 'INFORMED');

  -- The ledger rows are written FIRST, from the same join that drives the
  -- update, so a failure part-way cannot leave a status change with no audit.
  -- One map, two statements reading it — not two hand-written predicates that
  -- could drift apart, which is the defect shape this codebase records most.
  INSERT INTO "item_status_history"
    ("client_number", "user_id", "open_item_id", "from_status", "to_status", "outcome", "reason", "actor", "created_at")
  SELECT
    oi."client_number", oi."user_id", oi."id", oi."status", m."v15", 'accepted',
    'DEF-132: legacy ' || oi."status" || ' normalised to ' || m."v15"
      || ' (migration 20260811b_normalise_remaining_legacy_statuses)',
    'system', NOW()
  FROM "open_items" oi
  JOIN _def132_map m ON m."legacy" = oi."status";

  GET DIAGNOSTICS moved = ROW_COUNT;

  UPDATE "open_items" oi
     SET "status" = m."v15", "updated_at" = NOW()
    FROM _def132_map m
   WHERE m."legacy" = oi."status";

  IF moved > 0 THEN
    RAISE NOTICE 'DEF-132: normalised % legacy item(s), each with an audit row', moved;
  ELSE
    RAISE NOTICE 'DEF-132: no legacy statuses found — nothing to normalise';
  END IF;

  -- Anything STILL outside the 9-value set is reported, never guessed. A silent
  -- pass here would repeat the 2026-04-19 backfill's failure: success reported,
  -- rows still stranded.
  SELECT string_agg(DISTINCT "status", ', ') INTO leftover
    FROM "open_items"
   WHERE "status" NOT IN ('NEW','TRIAGED','IN_PROGRESS','DELEGATED','WAITING_INFO','SNOOZED','INFORMED','CLOSED','CANCELLED');

  IF leftover IS NOT NULL THEN
    RAISE WARNING 'DEF-132: statuses still OUTSIDE the v15 lifecycle and therefore unmovable: %. These were not guessed — decide each one deliberately.', leftover;
  END IF;
END $$;

-- Verification (run by hand after applying):
--
--   SELECT status, count(*) FROM open_items GROUP BY 1 ORDER BY 2 DESC;
--     -- expect ONLY the 9 v15 statuses: no 'DONE', no lowercase spellings
--
--   SELECT count(*) FROM item_status_history WHERE reason LIKE 'DEF-132%';
--     -- expect one row per item normalised, and UNCHANGED on a re-run
