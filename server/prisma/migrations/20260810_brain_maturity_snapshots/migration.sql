-- Brain Maturity — the daily record behind the morning report.
--
-- Owner, 2026-08-10: "daily morning i want you to send me Brain Maturity
-- comparing with yesterday", and "don't silent when nothing changed, just give
-- a message that nothing has changed".
--
-- Why a table rather than computing both days on the fly: several of these
-- figures are NOT recoverable after the fact. Database size, pages reachable
-- and open findings are all point-in-time states — ask tomorrow and you get
-- tomorrow's answer, not yesterday's. Without a snapshot the report could only
-- ever compare things that happen to live in an append-only log, which is a
-- subset that excludes most of what "maturity" means here.
--
-- It also makes the trend queryable. The evaluation chart asks "are we moving
-- ahead?" and until now that has been answered by reading commit messages.
--
-- One row per tenant per day. Idempotent: the writer upserts, so a restart or a
-- second pass on the same day corrects the row rather than duplicating it.

CREATE TABLE IF NOT EXISTS brain_maturity_snapshots (
  id              TEXT PRIMARY KEY,
  client_number   VARCHAR(20)  NOT NULL,
  snapshot_date   DATE         NOT NULL,

  -- LEARN — how well Brain actually answered, per the Living Assistant Standard.
  turns_scored    INTEGER      NOT NULL DEFAULT 0,
  avg_score       NUMERIC(5,1),
  -- Per-criterion averages as { "C1": 84.7, ... }. JSONB because the standard
  -- will grow a criterion and that must not need a migration.
  criteria_avg    JSONB,

  -- THINKING — reasoning cost. The figure that fell 20,512 -> 7,052 in a day.
  llm_calls       INTEGER      NOT NULL DEFAULT 0,
  llm_usd         NUMERIC(10,2),

  -- COMMUNICATING — did Brain reach the user, or get blocked?
  msgs_sent       INTEGER      NOT NULL DEFAULT 0,
  msgs_suppressed INTEGER      NOT NULL DEFAULT 0,

  -- MEMORY — how much of what Brain knows can it actually reach?
  pages_total     INTEGER      NOT NULL DEFAULT 0,
  pages_reachable INTEGER      NOT NULL DEFAULT 0,

  -- LIGHTER — a point-in-time state, unrecoverable tomorrow.
  db_bytes        BIGINT,
  entities        INTEGER,

  -- SELF-HEALING and SELF-PRUNING — what Brain fixed without being asked.
  healed          INTEGER      NOT NULL DEFAULT 0,
  merged          INTEGER      NOT NULL DEFAULT 0,
  open_findings   INTEGER      NOT NULL DEFAULT 0,

  created_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per tenant per day, and the upsert target.
CREATE UNIQUE INDEX IF NOT EXISTS brain_maturity_snapshots_day_uq
  ON brain_maturity_snapshots (client_number, snapshot_date);

-- "How has this moved?" — the trend read.
CREATE INDEX IF NOT EXISTS brain_maturity_snapshots_recent_ix
  ON brain_maturity_snapshots (client_number, snapshot_date DESC);
