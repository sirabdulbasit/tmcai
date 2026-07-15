-- MyOS — tenant-level WhatsApp Notifier (outbound only) + shadow_rules + pattern_insights.

-- ─── Tenant-level WhatsApp Notifier ────────────────────────────
-- Inbound WhatsApp stays per-user via user_connectors + /webhooks/whatsapp/:client.
-- This table carries the outbound sender credentials (Meta Cloud API) that
-- the Brain uses to message users when it needs input mid-day.
CREATE TABLE IF NOT EXISTS "tenant_whatsapp_notifier" (
  "client_number"         VARCHAR(20) PRIMARY KEY,
  "provider"              VARCHAR(20) NOT NULL DEFAULT 'meta',
  "display_number"        VARCHAR(30),
  "phone_number_id"       VARCHAR(50),
  "access_token_encrypted" TEXT,
  "app_id"                VARCHAR(100),
  "waba_id"               VARCHAR(100),
  "is_active"             BOOLEAN NOT NULL DEFAULT false,
  "verified_at"           TIMESTAMP(3),
  "last_send_at"          TIMESTAMP(3),
  "last_error"            TEXT,
  "created_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ─── Shadow rules (Probabilistic Shadowing DRAFT / SHADOW / ACTIVE / FROZEN) ────
CREATE TABLE IF NOT EXISTS "shadow_rules" (
  "id"              VARCHAR(50) PRIMARY KEY,
  "client_number"   VARCHAR(20) NOT NULL,
  "user_id"         INTEGER,
  "name"            VARCHAR(200) NOT NULL,
  "description"     TEXT,
  "archetype"       VARCHAR(30),
  "trigger_condition" JSONB NOT NULL DEFAULT '{}',
  "action"          VARCHAR(100) NOT NULL,
  "mode"            VARCHAR(20) NOT NULL DEFAULT 'DRAFT', -- DRAFT | SHADOW | ACTIVE | FROZEN
  "evidence"        INTEGER NOT NULL DEFAULT 0,
  "confirms"        INTEGER NOT NULL DEFAULT 0,
  "overrides"       INTEGER NOT NULL DEFAULT 0,
  "agreement"       DOUBLE PRECISION,
  "next_promotion_prompt_at" TIMESTAMP(3),
  "frozen_reason"   TEXT,
  "metadata"        JSONB,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "shadow_rules_client_mode_idx"
  ON "shadow_rules"("client_number", "mode");
CREATE INDEX IF NOT EXISTS "shadow_rules_promotion_ready_idx"
  ON "shadow_rules"("client_number", "mode", "agreement")
  WHERE "mode" = 'SHADOW';

-- ─── Pattern insights (Reflection agent output → Day Brief) ────
CREATE TABLE IF NOT EXISTS "pattern_insights" (
  "id"             SERIAL PRIMARY KEY,
  "client_number"  VARCHAR(20) NOT NULL,
  "user_id"        INTEGER,
  "description"    TEXT NOT NULL,
  "evidence_count" INTEGER NOT NULL DEFAULT 1,
  "rule_draft_id"  VARCHAR(50),
  "status"         VARCHAR(20) NOT NULL DEFAULT 'new', -- new | acknowledged | dismissed
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"     TIMESTAMP(3)
);
CREATE INDEX IF NOT EXISTS "pattern_insights_client_user_idx"
  ON "pattern_insights"("client_number", "user_id", "created_at");
CREATE INDEX IF NOT EXISTS "pattern_insights_status_idx"
  ON "pattern_insights"("status", "created_at");
