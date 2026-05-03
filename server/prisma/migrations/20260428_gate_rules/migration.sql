-- Tier 1 #7 — Rule-Engine Gate.
--
-- Deterministic pre-filter that runs BEFORE the Brain (LLM) on every
-- inbound feed event. Three layers of rules — system (ships with MyOS),
-- tenant (admin-defined), user (existing UDARs co-exist + new in-engine
-- rules). User > tenant > system.
--
-- Predicate is a tiny JSON DSL (see ruleEngineService.ts for shape).
-- Action describes what to do on match: archive, ack, defer, escalate,
-- block, or null (let Brain handle it normally but at a bumped priority).
--
-- Multi-tenant safety: every read scopes by client_number for tenant +
-- user rules. System rules have client_number = '*' and apply to all
-- tenants by convention.

CREATE TABLE gate_rules (
    id              SERIAL       PRIMARY KEY,
    -- Scope: 'system' (ships, can be disabled per-tenant/user but not edited),
    -- 'tenant' (admin-defined for one client), 'user' (per-individual).
    scope           VARCHAR(10)  NOT NULL,
    client_number   VARCHAR(20),                 -- NULL only for system rules
    user_id         INTEGER      REFERENCES users(id) ON DELETE CASCADE,
    -- Stable string identifier for system rules ("system:ooo_autoreply",
    -- "system:github_notification") so admin/user disable lists can refer
    -- to them without depending on numeric ids.
    rule_key        VARCHAR(80),
    name            VARCHAR(200) NOT NULL,
    description     TEXT,
    -- The predicate JSON DSL. Examples in ruleEngineService.ts.
    predicate       JSONB        NOT NULL,
    -- The action to take on match. See ActionShape interface in code.
    action          JSONB        NOT NULL,
    -- Lower number = higher priority. User > tenant > system enforced
    -- by ordering AND scope tiebreak in the evaluator.
    priority        INTEGER      NOT NULL DEFAULT 100,
    enabled         BOOLEAN      NOT NULL DEFAULT TRUE,
    -- Telemetry: how often did this fire, when last? Drives the "saved
    -- $X via rule engine" surface on the cost dashboard.
    fire_count      INTEGER      NOT NULL DEFAULT 0,
    last_fired_at   TIMESTAMPTZ,
    created_by_user_id INTEGER   REFERENCES users(id) ON DELETE SET NULL,
    updated_by_user_id INTEGER   REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT gate_rules_scope_chk CHECK (scope IN ('system', 'tenant', 'user'))
);

-- The hot read path is "all enabled rules for tenant T (or system) and
-- user U" sorted by priority. This index covers it.
CREATE INDEX gate_rules_lookup_idx
  ON gate_rules (client_number, scope, enabled, priority);

CREATE INDEX gate_rules_user_idx
  ON gate_rules (user_id, enabled, priority) WHERE user_id IS NOT NULL;

CREATE INDEX gate_rules_key_idx
  ON gate_rules (rule_key) WHERE rule_key IS NOT NULL;

-- Per-tenant or per-user disable list for SYSTEM rules. Lets a tenant
-- (or user) say "disable system:ooo_autoreply for me" without needing
-- to clone the rule into their own scope.
CREATE TABLE gate_rule_overrides (
    id              SERIAL       PRIMARY KEY,
    rule_key        VARCHAR(80)  NOT NULL,           -- system rule's stable key
    scope           VARCHAR(10)  NOT NULL,           -- 'tenant' | 'user'
    client_number   VARCHAR(20)  NOT NULL,
    user_id         INTEGER      REFERENCES users(id) ON DELETE CASCADE,
    disabled        BOOLEAN      NOT NULL DEFAULT TRUE,
    reason          TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    CONSTRAINT gate_rule_overrides_unique UNIQUE (rule_key, scope, client_number, user_id),
    CONSTRAINT gate_rule_overrides_scope_chk CHECK (scope IN ('tenant', 'user'))
);

CREATE INDEX gate_rule_overrides_lookup_idx
  ON gate_rule_overrides (client_number, scope, disabled);

-- Audit trail of every gate firing. Lets the cost dashboard answer
-- "how many LLM calls did we save?" and gives users an explanation
-- ("Why was this archived? → rule R-12 fired").
CREATE TABLE gate_rule_firings (
    id              BIGSERIAL    PRIMARY KEY,
    rule_id         INTEGER      NOT NULL REFERENCES gate_rules(id) ON DELETE CASCADE,
    rule_key        VARCHAR(80),
    rule_name       VARCHAR(200),
    rule_scope      VARCHAR(10),
    client_number   VARCHAR(20)  NOT NULL,
    user_id         INTEGER,
    feed_event_id   TEXT,
    decision        VARCHAR(20)  NOT NULL,           -- auto_handle | auto_ack | defer | escalate | block
    fired_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX gate_rule_firings_recent_idx
  ON gate_rule_firings (client_number, fired_at DESC);
CREATE INDEX gate_rule_firings_rule_idx
  ON gate_rule_firings (rule_id, fired_at DESC);
