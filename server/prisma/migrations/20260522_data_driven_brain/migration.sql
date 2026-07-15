-- Phase 1 of the reasoning-first / data-driven Brain refactor
-- (2026-05-22). Five new tables — no behavior change yet, just the
-- data plane that subsequent phases populate and consume.

-- prompt_blocks: composable prompt fragments. Replaces the hardcoded
-- TS constants (CORE_CONVERSATIONAL_RULES, ACTION_RULES, etc.) once
-- seeded + wired in Phases 2-3. Brain can propose new blocks via the
-- propose_prompt_block meta-action; user reviews in Settings.
CREATE TABLE IF NOT EXISTS prompt_blocks (
  id                TEXT         PRIMARY KEY,
  client_number     VARCHAR(20),
  user_id           INTEGER,
  name              VARCHAR(80)  NOT NULL,
  content           TEXT         NOT NULL,
  when_to_include   JSONB,
  priority          INTEGER      NOT NULL DEFAULT 100,
  scope             VARCHAR(20)  NOT NULL DEFAULT 'user',
  is_active         BOOLEAN      NOT NULL DEFAULT true,
  source            VARCHAR(20)  NOT NULL DEFAULT 'user_proposed',
  approved_at       TIMESTAMP,
  created_at        TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS prompt_blocks_user_name_scope_uq
  ON prompt_blocks(user_id, name, scope);
CREATE INDEX IF NOT EXISTS prompt_blocks_client_scope_active_idx
  ON prompt_blocks(client_number, scope, is_active);
CREATE INDEX IF NOT EXISTS prompt_blocks_user_active_idx
  ON prompt_blocks(user_id, is_active);

-- action_definitions: registry of action types Brain can dispatch.
-- Replaces the switch/case in instructionDispatcher once seeded +
-- wired in Phases 4-5. Brain can propose new types via the
-- register_action_type meta-action.
CREATE TABLE IF NOT EXISTS action_definitions (
  id                    TEXT         PRIMARY KEY,
  type                  VARCHAR(40)  NOT NULL UNIQUE,
  display_name          VARCHAR(100) NOT NULL,
  description           TEXT         NOT NULL,
  schema                JSONB        NOT NULL,
  handler_module        VARCHAR(100) NOT NULL,
  handler_function      VARCHAR(100) NOT NULL,
  preview_template      TEXT,
  requires_capability   VARCHAR(80),
  is_human_facing       BOOLEAN      NOT NULL DEFAULT false,
  is_active             BOOLEAN      NOT NULL DEFAULT true,
  scope                 VARCHAR(20)  NOT NULL DEFAULT 'system',
  source                VARCHAR(20)  NOT NULL DEFAULT 'seeded',
  approved_at           TIMESTAMP,
  created_at            TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS action_definitions_scope_active_idx
  ON action_definitions(scope, is_active);

-- capability_registry: what each user/tenant is allowed to do.
-- Replaces inline integration / permission checks. Generic dispatcher
-- checks this before invoking an action handler.
CREATE TABLE IF NOT EXISTS capability_registry (
  id              TEXT         PRIMARY KEY,
  client_number   VARCHAR(20)  NOT NULL,
  user_id         INTEGER      NOT NULL,
  capability_key  VARCHAR(80)  NOT NULL,
  status          VARCHAR(20)  NOT NULL,
  config          JSONB,
  granted_by      INTEGER,
  granted_at      TIMESTAMP,
  created_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS capability_registry_user_key_uq
  ON capability_registry(user_id, capability_key);
CREATE INDEX IF NOT EXISTS capability_registry_client_status_idx
  ON capability_registry(client_number, status);

-- clarification_memory: typed records of "Brain asked X, user said Y".
-- The asking IS the learning mechanism. Phase 7 wires the read path:
-- before reasoning decides to ask, check if a similar question was
-- already resolved.
CREATE TABLE IF NOT EXISTS clarification_memory (
  id                  TEXT         PRIMARY KEY,
  client_number       VARCHAR(20)  NOT NULL,
  user_id             INTEGER      NOT NULL,
  question_pattern    TEXT         NOT NULL,
  question_hash       VARCHAR(64)  NOT NULL,
  slot_being_filled   VARCHAR(80)  NOT NULL,
  resolution_value    JSONB        NOT NULL,
  resolution_context  JSONB,
  used_count          INTEGER      NOT NULL DEFAULT 1,
  last_used_at        TIMESTAMP    NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS clarification_memory_user_hash_uq
  ON clarification_memory(user_id, question_hash);
CREATE INDEX IF NOT EXISTS clarification_memory_user_slot_idx
  ON clarification_memory(user_id, slot_being_filled);
CREATE INDEX IF NOT EXISTS clarification_memory_client_lastused_idx
  ON clarification_memory(client_number, last_used_at DESC);

-- reasoning_traces: one row per turn — Brain's decision + rationale +
-- token spend. For debugging, cost monitoring, and the user-facing
-- "how Brain decided" view in Settings.
CREATE TABLE IF NOT EXISTS reasoning_traces (
  id              TEXT         PRIMARY KEY,
  client_number   VARCHAR(20)  NOT NULL,
  user_id         INTEGER      NOT NULL,
  turn_id         VARCHAR(60)  NOT NULL,
  reasoning_text  TEXT,
  decided_action  VARCHAR(30)  NOT NULL,
  action_type     VARCHAR(40),
  confidence      DOUBLE PRECISION,
  input_tokens    INTEGER,
  output_tokens   INTEGER,
  created_at      TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS reasoning_traces_user_created_idx
  ON reasoning_traces(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reasoning_traces_client_created_idx
  ON reasoning_traces(client_number, created_at DESC);
