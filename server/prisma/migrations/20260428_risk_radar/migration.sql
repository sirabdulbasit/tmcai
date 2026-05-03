-- Risk Radar — per-user daily forward-looking risk surface.
--
-- HaseebOS v16 ships a `risk_radar` daily cron (08:15 PKT) that emits a
-- typed RiskFlagDoc separate from the morning briefing. We replicate the
-- pattern multi-tenant + multi-user: each user has their own risk radar
-- (a CFO sees cash-runway flags; a CTO sees infra/SLA flags) driven by
-- their own enabled signals, thresholds, and schedule.
--
-- Two artifacts:
--   1) `risk_flag_docs` — one row per (client_number, user_id, run_date).
--      Stores the ranked flags + narrative + source signals so the doc
--      is replayable and the user can scroll back through prior days.
--   2) `brain_configs.risk_radar_config` (added below) — per-user config
--      for which signals are active, thresholds, and schedule. Defaults
--      are sensible-for-everyone; users override only what they need.

CREATE TABLE risk_flag_docs (
    id              TEXT      PRIMARY KEY,
    client_number   VARCHAR(20)  NOT NULL,
    user_id         INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    run_date        DATE         NOT NULL,
    generated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- Ranked array of flag objects; each flag has { id, signal, severity,
    -- title, reason, sourceRefs[], suggestedAction }. Stored as JSONB so
    -- we can index / query individual flags later.
    flags           JSONB        NOT NULL DEFAULT '[]'::jsonb,
    -- Brain-narrated paragraph rendering the flags into prose. Optional
    -- — radar runs without LLM produce flags + an empty narrative.
    narrative       TEXT,
    -- Quick top-line ("3 high-severity flags · 1 deal stagnant 21 days")
    -- so the UI can render a card without parsing the array.
    summary         TEXT,
    flag_count      INTEGER      NOT NULL DEFAULT 0,
    high_severity_count INTEGER  NOT NULL DEFAULT 0,
    -- Diagnostics: which signals fired, how many candidates each emitted.
    -- Lets us surface "why did the radar look thin today?" in the UI.
    source_signals  JSONB        NOT NULL DEFAULT '{}'::jsonb,
    model           VARCHAR(50),
    tokens_input    INTEGER,
    tokens_output   INTEGER,
    status          VARCHAR(20)  NOT NULL DEFAULT 'active',  -- active | superseded | failed
    error           TEXT,
    -- Stable id pattern: `risk:<client_number>:<user_id>:<YYYY-MM-DD>`
    -- so re-running the same day overwrites in place.
    CONSTRAINT risk_flag_docs_run_date_unique UNIQUE (client_number, user_id, run_date)
);

CREATE INDEX risk_flag_docs_user_recent_idx
  ON risk_flag_docs (client_number, user_id, run_date DESC);

CREATE INDEX risk_flag_docs_active_idx
  ON risk_flag_docs (client_number, status, generated_at DESC);

-- Extend brain_configs with per-user risk radar configuration. Schema:
--   {
--     "enabled": true,
--     "schedule": "15 8 * * *",        -- cron, default 08:15 PKT
--     "timezone": "Asia/Karachi",
--     "deliveryChannel": "in_app",     -- in_app | email | both | none
--     "signals": {
--       "stagnant_criticality": { "enabled": true, "min_score": 0.6, "max_age_days": 7 },
--       "decay":               { "enabled": true, "age_multiplier": 1.5 },
--       "silence":             { "enabled": true, "silence_multiplier": 3 },
--       "imminence":           { "enabled": true, "hours_ahead": 48 },
--       "crm_stagnation":      { "enabled": true, "stagnant_days": 14 },
--       "contradicted_pages":  { "enabled": true },
--       "custom_keywords":     { "enabled": false, "keywords": [] }
--     },
--     "max_flags": 12,
--     "narrate": true                  -- whether to call LLM for narrative
--   }
-- Empty/null = use defaults from riskRadarService.

ALTER TABLE brain_configs
  ADD COLUMN IF NOT EXISTS risk_radar_config JSONB NOT NULL DEFAULT '{}'::jsonb;
