-- Subscription limit state per run — owner, 2026-08-31: the deck should "tell me token
-- consumption as per available limit of subscription".
--
-- The Claude Code CLI already reports this on its event stream and nothing was reading it. Every
-- run carries `rate_limit_info` objects, and the last one in a stream is that run's parting
-- state:
--
--   {"status": "allowed_warning", "rateLimitType": "seven_day", "utilization": 0.81,
--    "resetsAt": 1787328000, "surpassedThreshold": 0.75, "isUsingOverage": false}
--
-- WHAT THE 38 STREAMS ON THIS BOX ACTUALLY CONTAIN, measured before building anything:
--   status        allowed 29 · allowed_warning 26 · rejected 14
--   rateLimitType five_hour 36 · seven_day 18 · seven_day_overage_included 15
--   and the loop HAS been throttled: seven-day utilisation climbed 78% -> 85% over Aug 19-20,
--   the five-hour window hit 93% at iteration 34, and iteration 49 ended `rejected` outright.
--
-- UTILIZATION IS NULLABLE ON PURPOSE, AND THAT IS THE WHOLE HONESTY OF THIS TABLE. The field is
-- present only on `allowed_warning`, i.e. once the window is past its 0.75 threshold. A plain
-- `allowed` carries NO number. So a null here means "the CLI did not say", which on an `allowed`
-- row means "below the warning threshold" — it does NOT mean zero, and the deck must never
-- render it as 0%. Defaulting it to 0 would turn "we were not told" into "we used nothing",
-- which is the same class of lie as a $0.00 seat that never ran (DEF-258).
--
-- Idempotent, hand-written per AGENTS.md; nullable additive columns rewrite no rows.

ALTER TABLE orchestrator_spend
  ADD COLUMN IF NOT EXISTS limit_status      VARCHAR(24),
  ADD COLUMN IF NOT EXISTS limit_type        VARCHAR(32),
  ADD COLUMN IF NOT EXISTS limit_utilization NUMERIC(5, 4),
  ADD COLUMN IF NOT EXISTS limit_resets_at   TIMESTAMPTZ;

-- The deck asks "what is the newest limit state, and were any runs rejected in this window",
-- both of which are time-ordered lookups over a small set of rows.
CREATE INDEX IF NOT EXISTS orchestrator_spend_limit_ix
  ON orchestrator_spend (limit_type, started_at DESC);

COMMENT ON COLUMN orchestrator_spend.limit_utilization IS
  'Fraction of the subscription window consumed (0-1), as reported by the CLI. NULL means the CLI did not report it — which on an `allowed` row means below the 0.75 warning threshold, NOT zero.';
