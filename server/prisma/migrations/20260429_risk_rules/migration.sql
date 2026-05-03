-- Risk Rules — user-defined rules that drive what shows up on the Risk Radar.
--
-- Replaces the previous "static signals" model (silence / decay / tone_shift)
-- with a rules-driven approach: each rule has a predicate against a data
-- source (feed_event | open_item | wiki_page), a severity, and a flag
-- template. Three scopes mirror the gate-rules pattern:
--   · system  — ships with deploy, can be disabled per-tenant or per-user
--   · tenant  — admin-defined for one client
--   · user    — per-individual
--
-- Predicate DSL is identical to gate_rules so the same evaluator is reused.

CREATE TABLE risk_rules (
    id                 SERIAL PRIMARY KEY,
    scope              VARCHAR(10) NOT NULL,           -- system | tenant | user
    client_number      VARCHAR(20),                     -- NULL for system rules
    user_id            INTEGER REFERENCES users(id) ON DELETE CASCADE,
    rule_key           VARCHAR(80),                     -- stable id for system rules
    name               VARCHAR(200) NOT NULL,
    description        TEXT,
    -- source tells the executor which table to scan and which derived
    -- fields are available in the predicate.
    source             VARCHAR(20) NOT NULL,            -- feed_event | open_item | wiki_page
    -- For feed_event: how recent (hours) to scan. Other sources use
    -- per-source defaults (open_items: all open; wiki_pages: all active).
    lookback_hours     INTEGER DEFAULT 24,
    predicate          JSONB NOT NULL,                  -- DSL — see ruleEngineService.ts
    severity           VARCHAR(10) NOT NULL DEFAULT 'medium',  -- low | medium | high
    -- Templates for rendering the flag. {placeholders} are replaced
    -- with row fields at flag-emit time (e.g. {sender_name}, {subject},
    -- {priority}, {age_days}). When omitted, the executor builds a
    -- reasonable default from the source + match.
    title_template     TEXT,
    reason_template    TEXT,
    suggested_action   TEXT,
    enabled            BOOLEAN NOT NULL DEFAULT TRUE,
    -- Telemetry — drives "this rule fired N times" stats in the editor
    fire_count         INTEGER NOT NULL DEFAULT 0,
    last_fired_at      TIMESTAMPTZ,
    created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT risk_rules_scope_chk    CHECK (scope IN ('system', 'tenant', 'user')),
    CONSTRAINT risk_rules_source_chk   CHECK (source IN ('feed_event', 'open_item', 'wiki_page')),
    CONSTRAINT risk_rules_severity_chk CHECK (severity IN ('low', 'medium', 'high'))
);

-- Hot-path read: "all rules visible to (tenant T, user U)" sorted by
-- creation. Index covers the common case (enabled rules for one user).
CREATE INDEX risk_rules_lookup_idx
  ON risk_rules (client_number, scope, enabled);

CREATE INDEX risk_rules_user_idx
  ON risk_rules (user_id, enabled) WHERE user_id IS NOT NULL;

CREATE INDEX risk_rules_key_idx
  ON risk_rules (rule_key) WHERE rule_key IS NOT NULL;

-- Per-tenant or per-user disable list for system rules. Same shape as
-- gate_rule_overrides — lets a tenant or user say "disable system:
-- vip_negative_sentiment for me" without cloning the rule.
CREATE TABLE risk_rule_overrides (
    id            SERIAL PRIMARY KEY,
    rule_key      VARCHAR(80) NOT NULL,
    scope         VARCHAR(10) NOT NULL,                 -- tenant | user
    client_number VARCHAR(20) NOT NULL,
    user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
    disabled      BOOLEAN NOT NULL DEFAULT TRUE,
    reason        TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT risk_rule_overrides_unique UNIQUE (rule_key, scope, client_number, user_id),
    CONSTRAINT risk_rule_overrides_scope_chk CHECK (scope IN ('tenant', 'user'))
);

CREATE INDEX risk_rule_overrides_lookup_idx
  ON risk_rule_overrides (client_number, scope, disabled);
