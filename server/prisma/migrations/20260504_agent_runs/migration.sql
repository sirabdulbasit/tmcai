-- ============================================================
-- 20260504_agent_runs
--
-- agent_runs powers the Agents tab + agent scheduler. The table was
-- created on prod via ad-hoc psql earlier; this migration formalises
-- it so any future deploy (or the local dev DB) gets the same schema.
--
-- Idempotent — IF NOT EXISTS guards every statement.
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_runs (
  id                BIGSERIAL PRIMARY KEY,
  agent_id          INTEGER NOT NULL,
  client_number     VARCHAR(20) NOT NULL,
  user_id           INTEGER,
  trigger_type      VARCHAR(30) NOT NULL,                  -- scheduled | manual | event
  status            VARCHAR(20) NOT NULL DEFAULT 'running', -- running | completed | failed
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at      TIMESTAMPTZ,
  error             TEXT,
  findings          JSONB,
  findings_summary  TEXT,
  data_context      TEXT,
  tokens_used       INTEGER,
  notified_via      TEXT[],
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_agent_id ON agent_runs(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_client_number ON agent_runs(client_number);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_agent_runs_started_at ON agent_runs(started_at DESC);
