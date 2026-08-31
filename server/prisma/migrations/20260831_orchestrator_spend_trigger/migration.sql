-- Cron attribution for build & heal spend — WHICH SCHEDULE spent the money.
--
-- `orchestrator_spend` already answers "what did each SEAT cost" (build, heal, review, score).
-- The owner's question is a different cut: *"daily, weekly, monthly and cron wise"*. A seat is
-- not a schedule. Two crons drive this box, and they have completely different shapes:
--
--   30 2  * * *   nightly-iteration.sh    → one bounded build iteration   (1/day)
--   */10  * * * * watch-conversations.sh  → the chat analyst             (144/day)
--
-- Both can also be run by hand, and the loop has been run by hand often during a campaign.
-- So the schedule CANNOT be inferred from the seat: a `build` row may come from the nightly
-- cron or from someone running nexeo-loop.sh at a terminal, and those are different budgets
-- for the same seat. It has to be RECORDED BY THE PROCESS THAT LAUNCHED THE RUN, which is
-- what the `.trigger` sidecar written next to each run log now does.
--
-- NULL IS NOT 'manual'. The 42 rows already ingested were produced before any sidecar
-- existed, so their trigger is genuinely unknown and is left NULL. Backfilling them to
-- `cron:nightly-iteration` would be a guess presented as a record — and the guess would be
-- wrong for every hand-run iteration of the August campaign, which is most of them. The deck
-- renders NULL as "unattributed", never as a cron and never as manual.
--
-- NOT NAMED `trigger`. That is a reserved word in Postgres; a column called `trigger` has to
-- be double-quoted at every single use, and the first unquoted reference is a syntax error at
-- runtime rather than at build time. `triggered_by` costs nothing and cannot bite.
--
-- Idempotent, hand-written, safe to re-run (AGENTS.md): IF NOT EXISTS on both statements, and
-- adding a nullable column rewrites no rows and takes no long lock.

ALTER TABLE orchestrator_spend
  ADD COLUMN IF NOT EXISTS triggered_by VARCHAR(48);

-- The deck's cron cut is always bounded by a date window, so the index leads with the
-- attribution and carries the ordering column — the same shape as orchestrator_spend_seat_ix,
-- which serves the identical query for seats.
CREATE INDEX IF NOT EXISTS orchestrator_spend_trigger_ix
  ON orchestrator_spend (triggered_by, started_at DESC);

COMMENT ON COLUMN orchestrator_spend.triggered_by IS
  'What launched this run: cron:<script-name>, manual, or NULL when it predates trigger recording. NULL means unattributed, never manual.';
