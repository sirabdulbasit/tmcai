-- Make the spend table answerable by date range.
--
-- Owner, 2026-08-27, on a Range of 27 Jan → 27 Aug grouped by month, seeing ONE row: "i am
-- expecting to see for each month like Jan-26 Feb-26 Mar-26 Apr-26 etc".
--
-- The months were not missing from the grouping. The page read a JSON blob in system_config with
-- 62-day retention, so everything older had been deleted. Meanwhile `llm_spend` — a real table,
-- one row per call — holds 2,608,934 rows going back to 2026-05-03.
--
-- The two stores also DISAGREE about the month they both cover:
--     blob   54,099 calls  $289.98
--     table 233,928 calls  $587.19
-- The page has been under-reporting spend by roughly half. The table is the one with a row per
-- call and a stored est_usd, so it is the one to trust.
--
-- Its only indexes were the primary key and a partial index on brain_doc_id, so grouping by date
-- for one tenant meant a full scan of 2.6M rows. This is the index that query needs.
CREATE INDEX IF NOT EXISTS llm_spend_client_created_idx
  ON llm_spend (client_number, created_at);

-- The per-user breakdown groups by user within the same window.
CREATE INDEX IF NOT EXISTS llm_spend_client_user_created_idx
  ON llm_spend (client_number, user_id, created_at);
