-- llm_spend retention — OPT-001. 561 MB of a 811 MB database is one table.
--
-- `llm_spend` is 2,614,564 rows back to 2026-05-03, one per LLM call, and 91.1% of them are
-- older than 30 days. It is 69% of the database on its own.
--
-- WHY A ROLLUP AND NOT A DELETE. Deleting old rows is what the PREVIOUS store did, and it is the
-- recorded defect this table exists to fix: the system_config JSON blob pruned to 62 days, so
-- when the owner asked for Jan-to-Aug grouped by month he saw ONE row, and the two stores
-- disagreed by half on the month they both covered (blob $289.98 vs table $587.19). Losing
-- history to save space would reintroduce exactly that. So nothing is lost here — the detail is
-- collapsed, not discarded.
--
-- THE COMPRESSION IS ALMOST FREE, because the dimensions barely vary. Measured over the
-- archivable window on 2026-08-31:
--
--     archivable raw rows   2,382,156
--     rollup rows needed        1,129        ← 2110x
--     distinct clients 2 · users 4 · providers 2 · models 0 (all NULL) · purposes 34
--
-- Every consumer of this table already aggregates by day, user, provider or purpose — nine query
-- sites in llmSpendService plus one in brainMaturityReport, and not one reads a single call's
-- request_id, duration_ms or error text over a historical window. Those columns are what the
-- rollup drops; the day-grain sums the pages actually render are preserved exactly.
--
-- THE VIEW MAKES DOUBLE-COUNTING STRUCTURALLY IMPOSSIBLE. `llm_spend_unified` is the rollup
-- UNION ALL the raw table aggregated to the same day grain — but the raw side EXCLUDES any day
-- that already exists in the rollup. That is the important line. It means:
--
--   * the rollup can be backfilled now, before anything is deleted, and totals stay correct;
--   * the purge is a separate, independently reversible-by-restore step;
--   * a re-run of either half cannot inflate a figure, which is the failure mode (silent
--     under- or over-reporting on the owner's cost page) that OPT-001 is named after.
--
-- Idempotent and hand-written per AGENTS.md: IF NOT EXISTS throughout, CREATE OR REPLACE for the
-- view, and the backfill is an ON CONFLICT upsert so running it twice changes nothing.

-- ── 1. The rollup ───────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS llm_spend_daily (
  day           date          NOT NULL,
  client_number varchar(20)   NOT NULL,
  user_id       integer,
  provider      varchar(40)   NOT NULL,
  model         varchar(80),
  purpose       varchar(60),
  calls         integer       NOT NULL DEFAULT 0,
  input_tokens  bigint        NOT NULL DEFAULT 0,
  output_tokens bigint        NOT NULL DEFAULT 0,
  -- Wider than llm_spend.est_usd numeric(10,6): this column holds a SUM of those values.
  est_usd       numeric(14,6) NOT NULL DEFAULT 0,
  rolled_at     timestamptz   NOT NULL DEFAULT now()
);

-- NULLS NOT DISTINCT (PG15+, this box is 16.12) is required, not cosmetic. user_id, model and
-- purpose are all nullable, and under default UNIQUE semantics every NULL is distinct from every
-- other NULL — so a plain unique index would let the same dimension tuple be inserted without
-- limit whenever one of those is NULL, and the ON CONFLICT upsert below would never fire. The
-- rollup would then double-count on every re-run, silently.
CREATE UNIQUE INDEX IF NOT EXISTS llm_spend_daily_dims_ux
  ON llm_spend_daily (day, client_number, user_id, provider, model, purpose) NULLS NOT DISTINCT;

-- Serves the page's range queries, and the view's NOT EXISTS lookup below.
CREATE INDEX IF NOT EXISTS llm_spend_daily_client_day_ix
  ON llm_spend_daily (client_number, day DESC);
CREATE INDEX IF NOT EXISTS llm_spend_daily_day_ix
  ON llm_spend_daily (day);

COMMENT ON TABLE llm_spend_daily IS
  'Day-grain rollup of llm_spend, one row per (day, client, user, provider, model, purpose). Written by the retention sweep BEFORE the matching raw rows are deleted. Read through llm_spend_unified, never directly.';

-- ── 2. Backfill every archivable day, without deleting anything ──────────────────────────────
-- Bounded to days strictly older than the 30-day retention window so the current window is
-- never rolled up while it is still being written to. ON CONFLICT keeps this re-runnable: a
-- second run recomputes the same sums for the same dimension tuples.
INSERT INTO llm_spend_daily
      (day, client_number, user_id, provider, model, purpose, calls, input_tokens, output_tokens, est_usd)
SELECT date_trunc('day', created_at)::date,
       client_number, user_id, provider, model, purpose,
       COUNT(*)::int,
       COALESCE(SUM(input_tokens), 0)::bigint,
       COALESCE(SUM(output_tokens), 0)::bigint,
       COALESCE(SUM(est_usd), 0)::numeric(14,6)
  FROM llm_spend
 WHERE created_at < (CURRENT_DATE - INTERVAL '30 days')
 GROUP BY 1, 2, 3, 4, 5, 6
    ON CONFLICT (day, client_number, user_id, provider, model, purpose) DO UPDATE
   SET calls         = EXCLUDED.calls,
       input_tokens  = EXCLUDED.input_tokens,
       output_tokens = EXCLUDED.output_tokens,
       est_usd       = EXCLUDED.est_usd,
       rolled_at     = now();

-- ── 3. The one thing every reader should query ───────────────────────────────────────────────
-- Day grain on both sides, so a consumer groups by date_trunc(week|month, day) exactly as it
-- used to group by date_trunc(week|month, created_at).
--
-- `calls` replaces COUNT(*): a view row stands for many calls, so COUNT(*) over this view would
-- count dimension tuples rather than calls. Every reader was changed to SUM(calls) in the same
-- commit — that is the one edit this view forces and it is deliberate, because a silent COUNT(*)
-- would under-report by roughly 2000x on archived days.
CREATE OR REPLACE VIEW llm_spend_unified AS
  SELECT day, client_number, user_id, provider, model, purpose,
         calls, input_tokens, output_tokens, est_usd
    FROM llm_spend_daily
   UNION ALL
  SELECT date_trunc('day', s.created_at)::date AS day,
         s.client_number, s.user_id, s.provider, s.model, s.purpose,
         COUNT(*)::int                              AS calls,
         COALESCE(SUM(s.input_tokens), 0)::bigint   AS input_tokens,
         COALESCE(SUM(s.output_tokens), 0)::bigint  AS output_tokens,
         COALESCE(SUM(s.est_usd), 0)::numeric(14,6) AS est_usd
    FROM llm_spend s
   -- THE ANTI-DOUBLE-COUNT. A day present in the rollup is served ONLY by the rollup, whether or
   -- not its raw rows have been deleted yet. This is what lets the backfill and the purge be
   -- separate steps, and what makes re-running either one harmless.
   WHERE NOT EXISTS (
           SELECT 1 FROM llm_spend_daily d
            WHERE d.day = date_trunc('day', s.created_at)::date
         )
   GROUP BY 1, 2, 3, 4, 5, 6;

COMMENT ON VIEW llm_spend_unified IS
  'Day-grain union of llm_spend_daily (archived) and llm_spend (retained). Days in the rollup are served only by the rollup, so re-running the backfill or the purge cannot double-count. Use SUM(calls), never COUNT(*).';
