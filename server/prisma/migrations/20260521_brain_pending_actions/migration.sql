-- Sprint 1 (2026-05-21): durable working memory for in-progress
-- multi-turn actions. Brain stops re-deriving task state from raw
-- chat history each turn; the active pending row holds slots
-- collected so far, missing slots to ask for next, and a preview
-- hash so confirmations can match against the exact prior preview.

CREATE TABLE IF NOT EXISTS brain_pending_actions (
  id              TEXT        PRIMARY KEY,
  client_number   VARCHAR(20) NOT NULL,
  user_id         INTEGER     NOT NULL,
  channel         VARCHAR(20) NOT NULL,
  action_kind     VARCHAR(40) NOT NULL,
  status          VARCHAR(30) NOT NULL,
  slots           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  missing_slots   TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  preview_hash    VARCHAR(64),
  previewed_at    TIMESTAMP,
  artifact_id     TEXT,
  created_at      TIMESTAMP   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP   NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMP   NOT NULL,

  CONSTRAINT brain_pending_actions_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Enforce at most one pending per (user, channel, status) — i.e., one
-- active pending per channel. Terminal rows (completed/failed/cancelled)
-- accumulate as audit history and don't collide with new pendings
-- because the status column is part of the uniqueness constraint.
CREATE UNIQUE INDEX IF NOT EXISTS brain_pending_actions_user_channel_status_uq
  ON brain_pending_actions(user_id, channel, status);

CREATE INDEX IF NOT EXISTS brain_pending_actions_client_expires_idx
  ON brain_pending_actions(client_number, expires_at);

CREATE INDEX IF NOT EXISTS brain_pending_actions_user_channel_updated_idx
  ON brain_pending_actions(user_id, channel, updated_at DESC);
