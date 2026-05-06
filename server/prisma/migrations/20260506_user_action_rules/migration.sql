-- Migration: create user_action_rules
--
-- The userActionRuleService has been shipping queries against this table
-- since the HaseebOS v15 work, but no migration ever created it. On prod
-- the table is missing, and every triage call hits 42P01 ("relation does
-- not exist") — the .catch(() => null) in buildAttentionList swallows the
-- error and drops every candidate row, leaving My Attention empty.
--
-- Schema reverse-engineered from the SQL the service actually emits in
-- src/services/userActionRuleService.ts:
--   INSERT into (id, client_number, user_id, scope, name, nl_original,
--                trigger_kind, trigger_condition, action_type,
--                action_payload, mode, confidence_threshold,
--                is_active, created_by)
--   UPDATE sets last_promoted_at, last_triggered_at, updated_at,
--                triggered_count, auto_executed_count
--   SELECT * (i.e. all columns) — so created_at must exist.

CREATE TABLE IF NOT EXISTS user_action_rules (
  id                       TEXT        PRIMARY KEY,
  client_number            TEXT        NOT NULL,
  user_id                  INTEGER     NOT NULL,
  scope                    TEXT        NOT NULL DEFAULT 'user',
  name                     TEXT        NOT NULL,
  nl_original              TEXT        NOT NULL,
  trigger_kind             TEXT        NOT NULL,
  trigger_condition        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  action_type              TEXT        NOT NULL,
  action_payload           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  mode                     TEXT        NOT NULL DEFAULT 'DRAFT',
  confidence_threshold     NUMERIC(3,2) NOT NULL DEFAULT 0.85,
  is_active                BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by               INTEGER     NOT NULL,
  triggered_count          INTEGER     NOT NULL DEFAULT 0,
  auto_executed_count      INTEGER     NOT NULL DEFAULT 0,
  last_triggered_at        TIMESTAMPTZ,
  last_promoted_at         TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- listRules() filters by (client_number, user_id, scope) and orders by
-- (scope='client') DESC, created_at DESC. A composite index covers the
-- common path; the ORDER BY is small enough not to need its own.
CREATE INDEX IF NOT EXISTS idx_user_action_rules_tenant_user
  ON user_action_rules (client_number, user_id, is_active);

-- evaluateRulesForEvent fans out per-tenant; this lets it skip rules
-- that don't match the trigger kind without scanning all tenants' rules.
CREATE INDEX IF NOT EXISTS idx_user_action_rules_trigger
  ON user_action_rules (client_number, trigger_kind, is_active);
