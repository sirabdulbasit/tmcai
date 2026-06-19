-- Nexeo — AI Self-Learning Foundation (Phase 1)
--
-- Per nexeo_self_learning&development.md and Basit 2026-06-19:
-- "complete all phases" — this is Phase 1, the data foundation.
--
-- Three tables that capture every Brain interaction, user feedback,
-- and governed memory. Phase 2's gap detection and product proposal
-- agents (next session) operate on the data accumulated here, so
-- this MUST run first and start collecting in production for at
-- least a few days before Phase 2 has meaningful input to work with.
--
-- Tenant-scoped: every row gates on client_number, matching Nexeo's
-- existing tenant-scope middleware. user_id is the actor whose
-- interaction/feedback/memory this captures.
--
-- Hard rules enforced at schema level:
--   - All FKs cascade-delete with the user (so the Delete User flow
--     stays clean and GDPR-erasure works end to end)
--   - Status is constrained at the app level (no DB CHECK to avoid
--     migration friction; Prisma typing + service-level validation
--     handle it)
--   - Indexes match the read patterns Phase 1 + 2 services need

-- ─── Table 1 — brain_interaction_learning_logs ──────────────────
-- Every Brain action: what the user asked, what Brain replied,
-- what context was used, what the model spent, what risk level
-- was assigned, what the user ultimately did with the response.

CREATE TABLE IF NOT EXISTS brain_interaction_learning_logs (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  client_number   VARCHAR(20)  NOT NULL,
  user_id         INTEGER      NOT NULL,
  surface         VARCHAR(50)  NOT NULL,
    -- 'web_chat' | 'whatsapp_brain' | 'day_brief' | 'open_items' |
    -- 'admin' | 'connector' | 'background_job'
  interaction_type VARCHAR(100) NOT NULL,
    -- 'ask' | 'compose' | 'summarize' | 'triage' | 'draft_reply' |
    -- 'follow_up' | 'alert' | 'schedule' | 'delegate'
  user_prompt     TEXT,
  brain_response  TEXT,
  context_snapshot JSONB,
  data_blocks_used JSONB,
  model_provider  VARCHAR(100),
  model_name      VARCHAR(100),
  tokens_used     INTEGER,
  risk_level      VARCHAR(50) DEFAULT 'low',
    -- 'low' | 'medium' | 'high' | 'critical'
  status          VARCHAR(50) DEFAULT 'success',
    -- 'success' | 'failed' | 'blocked' | 'escalated' | 'pending_approval'
  user_outcome    VARCHAR(100),
    -- 'accepted' | 'edited' | 'rejected' | 'ignored' | 'delegated' |
    -- 'marked_done' | 'dismissed' — populated later when the user
    -- responds to the interaction (via feedback or implicit signals)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT brain_learning_logs_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT brain_learning_logs_tenant_fk
    FOREIGN KEY (client_number) REFERENCES tenants(client_number) ON DELETE CASCADE
);

CREATE INDEX idx_brain_learning_client_user_surface
  ON brain_interaction_learning_logs (client_number, user_id, surface, created_at DESC);
CREATE INDEX idx_brain_learning_risk
  ON brain_interaction_learning_logs (client_number, risk_level, created_at DESC)
  WHERE risk_level IN ('high', 'critical');

-- ─── Table 2 — brain_feedback ────────────────────────────────────
-- Explicit user feedback on a Brain interaction. Drives the Phase 2
-- gap detection engine: repeated 'incorrect' / 'hallucinated' /
-- 'parity_issue' patterns become gap candidates.

CREATE TABLE IF NOT EXISTS brain_feedback (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  client_number   VARCHAR(20) NOT NULL,
  user_id         INTEGER     NOT NULL,
  interaction_id  TEXT,
  feedback_type   VARCHAR(100) NOT NULL,
    -- 'helpful' | 'incorrect' | 'incomplete' | 'too_generic' |
    -- 'too_long' | 'too_short' | 'wrong_priority' | 'wrong_tone' |
    -- 'wrong_language' | 'hallucinated' | 'privacy_concern' |
    -- 'cross_channel_tone_issue' | 'parity_issue'
  feedback_comment TEXT,
  corrected_output TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT brain_feedback_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT brain_feedback_tenant_fk
    FOREIGN KEY (client_number) REFERENCES tenants(client_number) ON DELETE CASCADE,
  CONSTRAINT brain_feedback_interaction_fk
    FOREIGN KEY (interaction_id) REFERENCES brain_interaction_learning_logs(id) ON DELETE SET NULL
);

CREATE INDEX idx_brain_feedback_client_user
  ON brain_feedback (client_number, user_id, created_at DESC);
CREATE INDEX idx_brain_feedback_type_recent
  ON brain_feedback (client_number, feedback_type, created_at DESC);

-- ─── Table 3 — governed_brain_memories ──────────────────────────
-- Brain-proposed memories that require human approval BEFORE they
-- influence future replies. This is the structural defense against
-- Brain "silently learning" preferences the user never agreed to.
-- High-sensitivity memories MUST stay in status='pending_approval'
-- until an admin (or the user themselves for user-scope) reviews.

CREATE TABLE IF NOT EXISTS governed_brain_memories (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  client_number   VARCHAR(20) NOT NULL,
  user_id         INTEGER,
    -- NULL for tenant-scope memories (admin-only); set for user-scope
  memory_scope    VARCHAR(50) NOT NULL,
    -- 'user_preference' | 'contact' | 'decision' | 'workflow' |
    -- 'product' | 'connector' | 'tenant'
  scope_reference_id TEXT,
  memory_type     VARCHAR(100) NOT NULL,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  source_type     VARCHAR(100),
    -- 'reflection_agent' | 'rule_miner_agent' | 'user_explicit' |
    -- 'triage_agent' | etc.
  source_reference_id TEXT,
  confidence_score NUMERIC(5,2) DEFAULT 0,
  sensitivity_level VARCHAR(50) DEFAULT 'normal',
    -- 'low' | 'normal' | 'sensitive' | 'critical'
  status          VARCHAR(50) DEFAULT 'pending_approval',
    -- 'pending_approval' | 'active' | 'archived' | 'rejected'
  created_by_brain BOOLEAN DEFAULT TRUE,
  approved_by     INTEGER,
  approved_at     TIMESTAMPTZ,
  rejected_by     INTEGER,
  rejected_at     TIMESTAMPTZ,
  rejection_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT governed_memories_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT governed_memories_tenant_fk
    FOREIGN KEY (client_number) REFERENCES tenants(client_number) ON DELETE CASCADE,
  CONSTRAINT governed_memories_approver_fk
    FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT governed_memories_rejecter_fk
    FOREIGN KEY (rejected_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_governed_memories_pending
  ON governed_brain_memories (client_number, status, sensitivity_level, created_at DESC)
  WHERE status = 'pending_approval';
CREATE INDEX idx_governed_memories_active
  ON governed_brain_memories (client_number, user_id, memory_scope, status)
  WHERE status = 'active';
