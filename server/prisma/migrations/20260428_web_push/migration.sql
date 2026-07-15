-- Tier 1 #6 — Web push approvals.
--
-- HaseebOS v16 uses FCM push for the single-operator phone-approval loop.
-- The multi-tenant equivalent uses standard Web Push API with VAPID keys
-- so any modern browser/device can receive notifications without a
-- proprietary mobile build. Three artifacts:
--
--   1) push_subscriptions  — one row per device the user has authorized
--   2) approval_tokens     — short-lived signed tokens that let a user
--                            tap "Approve" or "Reject" from the
--                            notification without opening MyOS
--   3) brain_configs.push_prefs — per-user preferences (which event
--                                 types fire pushes, quiet hours)
--
-- Multi-tenant: every row has client_number; tokens are scoped to a
-- specific (action_id, user_id) pair so even a leaked token can't act
-- across users or tenants.

-- ─── push_subscriptions ──────────────────────────────────────────
-- One row per device. A user may have many (laptop, phone, tablet).
-- Endpoint URL is unique per device per push service. The two encryption
-- keys are required by the Web Push protocol — server uses them to
-- encrypt the payload that the device's service worker decrypts.
CREATE TABLE push_subscriptions (
    id              SERIAL       PRIMARY KEY,
    client_number   VARCHAR(20)  NOT NULL,
    user_id         INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- The endpoint is a URL at the push service (Apple, Google, Mozilla).
    -- A flush of MyOS state should NOT invalidate it; the device retains
    -- the subscription. We dedup on (user_id, endpoint).
    endpoint        TEXT         NOT NULL,
    p256dh_key      TEXT         NOT NULL,
    auth_key        TEXT         NOT NULL,
    -- Display label (e.g. "MD's iPhone", "MacBook Pro Chrome") so the
    -- user can manage devices in settings. Free-text, ≤120 chars.
    device_label    VARCHAR(120),
    user_agent      TEXT,
    -- Lifecycle: active → expired (push service returned 410) → removed
    -- by user. We soft-delete by flipping is_active rather than DELETE
    -- so audit trails for "who got which push" survive.
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    last_push_at    TIMESTAMPTZ,
    last_error      TEXT,
    failure_count   INTEGER      NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- Same browser re-registering should update, not duplicate.
    CONSTRAINT push_subscriptions_user_endpoint_unique UNIQUE (user_id, endpoint)
);

CREATE INDEX push_subscriptions_user_active_idx
  ON push_subscriptions (client_number, user_id, is_active);

-- ─── approval_tokens ─────────────────────────────────────────────
-- Short-lived signed tokens that let the user tap "Approve" / "Reject"
-- in the notification without opening MyOS. Each token is bound to a
-- specific (action_id, user_id, action) tuple — a leaked token cannot
-- approve a different action or impersonate a different user. Tokens
-- are single-use (consumed_at) and short-lived (default 24h) so that
-- a notification from yesterday can't fire today's approvals.
CREATE TABLE approval_tokens (
    id              SERIAL       PRIMARY KEY,
    -- The token presented in the URL (?t=...). Random 32 bytes b64url.
    -- Stored as the SHA-256 hash so a DB read can't replay tokens; the
    -- raw token only exists in the push payload + the user's notification.
    token_hash      VARCHAR(64)  NOT NULL UNIQUE,
    client_number   VARCHAR(20)  NOT NULL,
    user_id         INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    action_id       INTEGER      NOT NULL REFERENCES agent_actions(id) ON DELETE CASCADE,
    -- One of: 'approve', 'reject', 'view'. 'view' tokens are not
    -- single-use — they just open the proposal page in MyOS.
    intent          VARCHAR(20)  NOT NULL,
    expires_at      TIMESTAMPTZ  NOT NULL,
    consumed_at     TIMESTAMPTZ,
    consumed_by_ip  VARCHAR(50),
    consumed_via    VARCHAR(20), -- 'push' | 'email' | 'whatsapp' | 'in_app'
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX approval_tokens_action_idx ON approval_tokens (action_id);
CREATE INDEX approval_tokens_expires_idx ON approval_tokens (expires_at) WHERE consumed_at IS NULL;

-- ─── BrainConfig.push_prefs ──────────────────────────────────────
-- Per-user notification preferences. Schema (defaults applied in code):
--   {
--     "enabled": true,
--     "events": {
--       "approval_request":   true,
--       "risk_radar_high":    true,
--       "watchpoint_hit":     true,
--       "meeting_imminent":   true,
--       "kill_switch_change": true,        -- admin-only event
--       "cost_anomaly":       true,        -- admin-only event
--       "morning_brief":      false,
--       "low_priority_draft": false
--     },
--     "quietHours": { "start": "22:00", "end": "07:00", "timezone": "Asia/Karachi", "allowCritical": true },
--     "rateLimit":  { "maxPerHour": 20 }
--   }
ALTER TABLE brain_configs
  ADD COLUMN IF NOT EXISTS push_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;
