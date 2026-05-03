-- Tier 1 #5 — Cost dashboard: promote LLM spend tracking from
-- `system_config` JSON to a real time-series table.
--
-- Why move: the JSON-in-config rollup was fine for a single tenant POC
-- but doesn't support cross-day timelines, anomaly detection, top-N
-- queries, per-Brain-Doc cost attribution, or cross-tenant rollups for
-- billing. Each of those is a real query against `llm_spend`.
--
-- One row per LLM call. Volume is bounded — average tenant ~1K calls/day
-- = 30K rows/month/tenant. Indexes cover the four read paths the
-- dashboard needs: per-tenant timeline, per-user, per-purpose, per-model.
--
-- The legacy JSON in system_config stays in place; llmSpendService can
-- still read it for "before the table existed" history. New writes go to
-- both for one transition release, then the JSON path is dropped.

CREATE TABLE llm_spend (
    id              BIGSERIAL    PRIMARY KEY,
    client_number   VARCHAR(20)  NOT NULL,
    user_id         INTEGER      REFERENCES users(id) ON DELETE SET NULL,
    provider        VARCHAR(40)  NOT NULL,            -- 'gemini' | 'gemini-flash' | 'claude'
    model           VARCHAR(80),                       -- specific model id when known
    purpose         VARCHAR(60),                       -- 'triage' | 'chat' | 'risk_radar_narrate' | …
    input_tokens    INTEGER      NOT NULL DEFAULT 0,
    output_tokens   INTEGER      NOT NULL DEFAULT 0,
    est_usd         NUMERIC(10,6) NOT NULL DEFAULT 0,
    duration_ms     INTEGER,
    success         BOOLEAN      NOT NULL DEFAULT TRUE,
    error           TEXT,
    -- Optional cost-attribution links so the dashboard can answer
    -- "what did this morning brief cost?"
    brain_doc_id    TEXT,
    feed_event_id   TEXT,
    request_id      VARCHAR(64),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Per-tenant timeline: WHERE client_number = $1 ORDER BY created_at DESC
CREATE INDEX llm_spend_client_recent_idx
  ON llm_spend (client_number, created_at DESC);

-- Per-user drill-in
CREATE INDEX llm_spend_user_recent_idx
  ON llm_spend (client_number, user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- Top purposes / top models
CREATE INDEX llm_spend_purpose_idx ON llm_spend (client_number, purpose, created_at DESC);
CREATE INDEX llm_spend_provider_idx ON llm_spend (client_number, provider, created_at DESC);

-- Brain Doc → cost lookup
CREATE INDEX llm_spend_brain_doc_idx
  ON llm_spend (brain_doc_id) WHERE brain_doc_id IS NOT NULL;
