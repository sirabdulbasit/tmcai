-- ============================================================
-- 20260505_brain_prompt_queue
--
-- Per-user queue of questions Brain wants to ask the user.
--
-- Today brainContactsUser is a single-shot send: every caller (followup
-- worker, classifier HITL, deadline-prompt) fires its own message, with
-- a 60s per-kind rate limit. If Brain has 10 things to ask, 9 get
-- silently suppressed.
--
-- This table introduces a single sequential conversation per user:
-- exactly one prompt at a time can be in `awaiting_reply` (enforced
-- by a partial unique index). When the user replies, that prompt is
-- marked `answered`, the side-effect is applied, and the next queued
-- prompt is dispatched.
--
-- Criticality routes the channel:
--   routine → WhatsApp text
--   high    → WhatsApp voice note
--   top     → voice call (interrupts the queue, bypasses quiet hours)
--
-- Top-priority prompts SKIP the queue and are dispatched immediately;
-- they don't take the awaiting_reply slot from a routine conversation
-- already in progress. Cooldown between voice calls is enforced at
-- the dispatcher layer, not here.
-- ============================================================

CREATE TABLE IF NOT EXISTS brain_prompt_queue (
  id              BIGSERIAL PRIMARY KEY,
  client_number   VARCHAR(20) NOT NULL,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- The thing Brain is asking. Free text rendered to the user.
  question        TEXT NOT NULL,

  -- Optional link back to the open item this prompt is about. When the
  -- user answers, the side-effect handler may update this row (set
  -- dueDate, assign delegatee, etc.).
  open_item_id    TEXT REFERENCES open_items(id) ON DELETE SET NULL,

  -- What to do with the answer. Free-form JSON read by the reply
  -- handler. Examples:
  --   { "kind": "set_due_date", "openItemId": "..." }
  --   { "kind": "assign_owner",  "openItemId": "..." }
  --   { "kind": "free_form_note","openItemId": "..." }
  side_effect     JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Routing + state.
  criticality     VARCHAR(10) NOT NULL DEFAULT 'routine'
                    CHECK (criticality IN ('routine','high','top')),
  state           VARCHAR(20) NOT NULL DEFAULT 'queued'
                    CHECK (state IN ('queued','awaiting_reply','answered','skipped','expired')),

  -- Set when dispatcher picks the prompt up.
  channel_used    VARCHAR(20),
  ack_message_id  VARCHAR(120),    -- wa_message_id of the dispatch send, for reply correlation

  -- Soft-dedup: callers may pass a dedup_key to avoid re-asking the same
  -- thing. Producer skips enqueue if a (user_id, dedup_key) row in any
  -- non-terminal state already exists.
  dedup_key       VARCHAR(120),

  queued_at       TIMESTAMP NOT NULL DEFAULT now(),
  sent_at         TIMESTAMP,
  answered_at     TIMESTAMP,
  expires_at      TIMESTAMP,        -- auto-skip after this; default queued+48h
  answer_text     TEXT,

  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Dispatcher SELECTs queued prompts ordered by criticality (routine < high
-- < top — though top normally bypasses queue, it can land here when voice
-- call cooldown is active) then age.
CREATE INDEX IF NOT EXISTS idx_bpq_dispatch
  ON brain_prompt_queue (client_number, user_id, state, criticality, queued_at)
  WHERE state IN ('queued','awaiting_reply');

-- Reply handler looks up the user's current awaiting_reply row by user.
-- Partial unique index enforces "at most one awaiting_reply per user".
CREATE UNIQUE INDEX IF NOT EXISTS uq_bpq_one_awaiting_per_user
  ON brain_prompt_queue (user_id)
  WHERE state = 'awaiting_reply';

-- Dedup lookup.
CREATE INDEX IF NOT EXISTS idx_bpq_dedup
  ON brain_prompt_queue (user_id, dedup_key)
  WHERE dedup_key IS NOT NULL AND state IN ('queued','awaiting_reply');

-- Expiry sweep.
CREATE INDEX IF NOT EXISTS idx_bpq_expires
  ON brain_prompt_queue (expires_at)
  WHERE state IN ('queued','awaiting_reply');

-- Tenant audit: list every prompt for a tenant in a window.
CREATE INDEX IF NOT EXISTS idx_bpq_tenant_audit
  ON brain_prompt_queue (client_number, queued_at DESC);
