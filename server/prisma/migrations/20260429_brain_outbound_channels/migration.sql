-- ════════════════════════════════════════════════════════════════════
-- Brain → user proactive outbound (chat / voicenote / call) — audit + caps
-- ════════════════════════════════════════════════════════════════════
--
-- Today Brain has multiple ad-hoc paths to message the user (criticality
-- bundle, autonomous executor, agent runs). Each carries its own debounce
-- and dedup state in-process. With voice + call paths landing too, we need:
--
--   1) A single audit log of every Brain-initiated user contact, so the
--      user can see what Brain sent on their behalf and the system can
--      enforce per-(user, kind) frequency caps across restarts/replicas.
--   2) Capability flags on the tenant notifier (calling-enrolled? business
--      calling API access?), since Meta gates calling behind enrollment.

-- ─── 1) brain_user_messages — every proactive Brain → user contact ──────
CREATE TABLE IF NOT EXISTS brain_user_messages (
  id              BIGSERIAL PRIMARY KEY,
  client_number   VARCHAR(20)  NOT NULL,
  user_id         INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Why Brain reached out. Free-form key so callers can register new kinds
  -- without a schema change. Examples: 'critical_bundle', 'standing_due',
  -- 'follow_up_nudge', 'agent_run_done', 'emergency'.
  kind            VARCHAR(40)  NOT NULL,
  -- Channel actually used. 'auto' is recorded when the resolver picked
  -- multiple channels (e.g. text + voice for urgency=high).
  channel         VARCHAR(20)  NOT NULL CHECK (channel IN ('text','voicenote','call_cta','call_business','auto')),
  urgency         VARCHAR(10)  NOT NULL DEFAULT 'normal' CHECK (urgency IN ('low','normal','high','emergency')),
  -- Free-form summary the user sees in the audit log + the Brain debug pane.
  summary         TEXT         NOT NULL,
  -- Wamid(s) returned by Meta. Array because voice+text may both fire.
  wa_message_ids  TEXT[]       NOT NULL DEFAULT '{}',
  -- Per-(user, kind, dedup_key) suppression. Same dedup_key within
  -- debounce_window = no resend. NULL means "no dedup, every fire sends".
  dedup_key       VARCHAR(120),
  status          VARCHAR(20)  NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','partial','failed','suppressed')),
  error           TEXT,
  -- Phone number actually targeted (for audit + opt-out). Masked in UI.
  to_phone        VARCHAR(30),
  metadata        JSONB        NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Per-user feed query (audit panel + cap enforcement).
CREATE INDEX IF NOT EXISTS brain_user_messages_user_kind_idx
  ON brain_user_messages (user_id, kind, created_at DESC);
-- Tenant-wide feed (admin oversight panel).
CREATE INDEX IF NOT EXISTS brain_user_messages_tenant_idx
  ON brain_user_messages (client_number, created_at DESC);
-- Dedup lookup — find the last send with the same key in a window.
CREATE INDEX IF NOT EXISTS brain_user_messages_dedup_idx
  ON brain_user_messages (user_id, kind, dedup_key, created_at DESC)
  WHERE dedup_key IS NOT NULL;

-- ─── 2) tenant_whatsapp_notifier — calling capability flags ─────────────
-- Defaults to FALSE; admin enables explicitly once Meta has approved the
-- number for WhatsApp Business Calling. Brain falls back to the call-CTA
-- (a text message inviting user to tap-to-call back) when business calling
-- is disabled — so users never miss an emergency just because calling
-- enrollment is pending.
ALTER TABLE tenant_whatsapp_notifier
  ADD COLUMN IF NOT EXISTS calling_enabled  BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS calling_api_url  VARCHAR(120),         -- override for non-cloud-API providers; NULL = use Meta default
  ADD COLUMN IF NOT EXISTS last_call_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_call_error  TEXT;
