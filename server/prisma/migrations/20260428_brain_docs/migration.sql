-- Tier 1 #2 — Typed Brain Doc outputs (`brain_docs`).
--
-- HaseebOS v16 emits typed, versioned, replayable artifacts from every
-- Brain reasoning pass: MorningBriefDoc, RiskFlagDoc, AskInvocationDoc,
-- ProposalDoc, ThoughtObject. We replicate that shape for MyOS as the
-- canonical Brain-output store.
--
-- Every Brain run writes one row here with:
--   · doc_type     - morning_brief | risk_radar | ask_invocation |
--                    proposal | thought | weekly_review | …
--   · version      - increments when the same logical doc is regenerated
--                    (e.g. user re-runs morning brief mid-day)
--   · inputs_hash  - sha256 over canonical inputs; lets us short-circuit
--                    when "same inputs → same doc" (cache-hit detection)
--   · input_summary - what fed into this run (feed events, open items,
--                     parameters); replay reads this back
--   · output       - structured doc body (JSONB)
--   · prose        - rendered prose for the human reader (optional)
--   · summary      - one-line top-line for cards / lists
--   · superseded_by - chain to the doc that replaced this one
--
-- Existing specialized tables (e.g. risk_flag_docs) stay as read-
-- optimized projections; brain_docs is the unified replay/audit/feedback
-- substrate that all 6 Doc types pivot through.

CREATE TABLE brain_docs (
    id               TEXT PRIMARY KEY,
    client_number    VARCHAR(20)  NOT NULL,
    user_id          INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    doc_type         VARCHAR(40)  NOT NULL,
    version          INTEGER      NOT NULL DEFAULT 1,
    status           VARCHAR(20)  NOT NULL DEFAULT 'active', -- active | superseded | failed | draft
    -- Inputs
    inputs_hash      VARCHAR(64),
    input_summary    JSONB        NOT NULL DEFAULT '{}'::jsonb,
    source_event_ids TEXT[]       NOT NULL DEFAULT ARRAY[]::TEXT[],
    -- Outputs
    output           JSONB        NOT NULL DEFAULT '{}'::jsonb,
    prose            TEXT,
    summary          TEXT,
    -- Telemetry
    model            VARCHAR(50),
    tokens_input     INTEGER,
    tokens_output    INTEGER,
    generation_ms    INTEGER,
    error            TEXT,
    -- Audit chain
    superseded_by    TEXT REFERENCES brain_docs(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- Optional pointer back to a specialized projection (e.g. risk_flag_docs.id)
    projection_id    TEXT
);

-- One row per (tenant, user, doc_type, version). Version increments are
-- explicit (writeDoc auto-bumps when content changes); a unique constraint
-- guards against duplicate inserts at the same version.
CREATE UNIQUE INDEX brain_docs_logical_unique
  ON brain_docs (client_number, user_id, doc_type, version);

-- Latest-by-type reads ("what's the latest morning brief for user 7?")
CREATE INDEX brain_docs_user_type_recent_idx
  ON brain_docs (client_number, user_id, doc_type, created_at DESC);

-- Active-status filter for dashboards
CREATE INDEX brain_docs_active_idx
  ON brain_docs (client_number, status, created_at DESC);

-- Cache-hit detection: same inputs_hash → can short-circuit regeneration
CREATE INDEX brain_docs_inputs_hash_idx
  ON brain_docs (client_number, user_id, doc_type, inputs_hash)
  WHERE inputs_hash IS NOT NULL;

-- Source event lookup: which Brain Docs cite a given feed event?
-- (For audit / regression-test / replay-from-source flows.)
CREATE INDEX brain_docs_source_events_gin
  ON brain_docs USING GIN (source_event_ids);
