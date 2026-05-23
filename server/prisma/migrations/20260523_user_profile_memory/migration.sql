-- user_profile_memory — referenced by memoryService.ts +
-- conversationalHandler.ts + chatRoutes.ts via raw SQL but never had a
-- migration shipping the table. Result: every confirm of an external
-- action that touches memoryService crashed with
--   Raw query failed. Code: 42P01. Message: relation "user_profile_memory" does not exist.
--
-- Observed 2026-05-23 in Basit's meeting-invite test session: 6
-- consecutive sends failed with this error.
--
-- Schema mirrors the SELECT/UPDATE/INSERT statements in the code:
--   user_id, client_number, ai_instructions, user_personal,
--   active_concerns, updated_at.

CREATE TABLE IF NOT EXISTS user_profile_memory (
  user_id          INTEGER     PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  client_number    VARCHAR(20) NOT NULL,
  ai_instructions  TEXT        NOT NULL DEFAULT '',
  user_personal    TEXT        NOT NULL DEFAULT '',
  active_concerns  TEXT        NOT NULL DEFAULT '',
  created_at       TIMESTAMP   NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_profile_memory_client_idx
  ON user_profile_memory (client_number);
