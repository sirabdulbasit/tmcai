-- Quality Sprint 5b (2026-05-21): canonical lifecycle record for
-- every action Brain has attempted. Status transitions through
-- previewed → confirmed → dispatching → succeeded|failed (or
-- cancelled / expired). Replaces spread-across-three-tables
-- debugging pain.

CREATE TABLE IF NOT EXISTS brain_action_artifacts (
  id                  TEXT         PRIMARY KEY,
  client_number       VARCHAR(20)  NOT NULL,
  user_id             INTEGER      NOT NULL,
  channel             VARCHAR(20)  NOT NULL,
  pending_action_id   VARCHAR(40),
  preview_hash        VARCHAR(64),
  idempotency_key     VARCHAR(128),
  action_type         VARCHAR(40)  NOT NULL,
  status              VARCHAR(30)  NOT NULL,
  payload             JSONB        NOT NULL,
  result              JSONB,
  error_code          VARCHAR(40),
  error_message       TEXT,
  artifact_ext_id     VARCHAR(200),  -- gmail messageId / calendar eventId / openItemId
  created_at          TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS brain_action_artifacts_user_channel_idx
  ON brain_action_artifacts(user_id, channel, created_at DESC);

CREATE INDEX IF NOT EXISTS brain_action_artifacts_client_created_idx
  ON brain_action_artifacts(client_number, created_at DESC);

CREATE INDEX IF NOT EXISTS brain_action_artifacts_ext_id_idx
  ON brain_action_artifacts(artifact_ext_id);
