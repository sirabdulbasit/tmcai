-- Quality Sprint 2 (2026-05-21): durable per-user memory.
-- Replaces "Brain doesn't remember how I work" with explicit
-- user-stated preferences that persist across sessions.

CREATE TABLE IF NOT EXISTS user_memories (
  id              SERIAL       PRIMARY KEY,
  client_number   VARCHAR(20)  NOT NULL,
  user_id         INTEGER      NOT NULL,
  key             VARCHAR(80)  NOT NULL,
  value           JSONB        NOT NULL,
  category        VARCHAR(30)  NOT NULL DEFAULT 'preference',
  source          VARCHAR(20)  NOT NULL, -- 'explicit' | 'inferred' | 'system'
  confidence      DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  confirmed_at    TIMESTAMP,                -- NULL = unconfirmed inferred memory (hold)
  expires_at      TIMESTAMP,
  created_at      TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS user_memories_user_key_uq
  ON user_memories(user_id, key);

CREATE INDEX IF NOT EXISTS user_memories_client_user_idx
  ON user_memories(client_number, user_id);
