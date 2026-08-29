-- Build & Heal spend — the orchestrator's own token consumption, kept apart from llm_spend.
--
-- TWO BUDGETS, TWO PROVIDERS. `llm_spend` records what the APPLICATION spends on Gemini and
-- Claude through `llmRouter` — triage, criticality, composition. This table records what the
-- ORCHESTRATOR spends on Claude Code: the Brain Builder seat, the chat analyst, the reviewer.
-- They bill separately and a combined total would mean nothing, so they never share a table
-- and never share a page.
--
-- WHY A TABLE AND NOT A VIEW OVER THE LOGS. The jsonl logs under
-- `server/docs/orchestrator/logs` are today the only record of $606.18 of build spend, and
-- they are not durable:
--
--   1. They have already been discarded. Every `retired-*` directory from the four
--      orchestrator resets contains ZERO jsonl files — that history is simply gone.
--   2. Iteration numbers RECYCLE. Numbering restarts at each reset, so the 92 current files
--      carry 39 distinct numbers spanning 0..99 and `iter-01-build.jsonl` has existed several
--      times over. A filename or an iteration number is therefore not an identity.
--
-- `llm_spend` itself was promoted from a system_config JSON blob for exactly this reason, and
-- that blob was found to be under-reporting by half. Same problem, same answer.
--
-- ONE ROW PER RUN, not per turn. 92 rows on backfill, growing by roughly two or three a day.
-- Per-turn detail stays in the jsonl for anyone debugging a specific build; what this table
-- answers is "what did building and healing cost this day, week, month".

CREATE TABLE IF NOT EXISTS orchestrator_spend (
  id                    BIGSERIAL     PRIMARY KEY,
  -- sha256(session_id || started_at || seat || iteration). Deliberately NOT the filename and
  -- NOT the iteration: both recycle across resets, and a recycled key overwrites real history
  -- on the next ingest. The session id plus the run's own start time is stable for the life
  -- of the record.
  run_uid               CHAR(64)      NOT NULL UNIQUE,
  -- build | heal | review | score. `heal` is the chat analyst.
  seat                  VARCHAR(16)   NOT NULL,
  -- Informational only. Recycles; never used as a key.
  iteration             INTEGER,
  session_id            VARCHAR(64),
  model                 VARCHAR(80),
  started_at            TIMESTAMP(3)  NOT NULL,
  duration_ms           INTEGER,
  num_turns             INTEGER,
  input_tokens          BIGINT        NOT NULL DEFAULT 0,
  output_tokens         BIGINT        NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT        NOT NULL DEFAULT 0,
  -- The figure that matters. Measured 2026-08-28: cache reads are 96% of all tokens on this
  -- host, because every turn of a resumed session re-sends the whole transcript.
  cache_read_tokens     BIGINT        NOT NULL DEFAULT 0,
  -- The CLI's own `total_cost_usd`, stored as reported. Never recomputed from tokens: it was
  -- priced when the run happened, so a later change to any rate table cannot rewrite history.
  total_cost_usd        DECIMAL(10,6) NOT NULL DEFAULT 0,
  -- success | error_max_turns | error_during_execution | ...
  subtype               VARCHAR(24),
  source_file           TEXT,
  created_at            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The report window is always a date range, newest first.
CREATE INDEX IF NOT EXISTS orchestrator_spend_when_ix
  ON orchestrator_spend (started_at DESC);

-- The per-seat split beneath each bucket.
CREATE INDEX IF NOT EXISTS orchestrator_spend_seat_ix
  ON orchestrator_spend (seat, started_at DESC);

-- Deliberately NO index on session_id, model or subtype. They are read only alongside a date
-- filter that the index above already serves, and this project has been here before: OPT-001
-- dropped 791 MB of indexes on llm_spend that the planner had never once chosen.
