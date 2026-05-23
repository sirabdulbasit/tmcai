-- Settings → Brain → Reset & Cleanup audit log
-- (2026-05-23). Records each reset triggered by a user — when, what
-- tier, what got wiped (counts), and the archive suffix so we can
-- restore from the *_wipe_<suffix> tables if needed.

CREATE TABLE IF NOT EXISTS brain_resets (
  id              TEXT         PRIMARY KEY,
  user_id         INTEGER      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_number   VARCHAR(20),
  tier            VARCHAR(30)  NOT NULL, -- 'quick' | 'refresh' | 'full' | 'full_with_contacts'
  wiped_counts    JSONB        NOT NULL DEFAULT '{}'::jsonb,
  archive_suffix  VARCHAR(80),
  archive_expires_at TIMESTAMP, -- 7 days after created_at; cron drops archive tables after
  created_at      TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS brain_resets_user_created_idx
  ON brain_resets (user_id, created_at DESC);
