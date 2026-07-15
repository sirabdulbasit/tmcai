-- Sprint 2 (2026-05-21): per-user alias memory so the resolver
-- doesn't re-ask "which Asad?" every session.
--
-- After the user explicitly resolves an alias (typically via
-- disambiguation reply, like answering "Asad Ahmed Taj" to a "which
-- Asad?" question), the (alias → identifier) pair is recorded here.
-- The resolver consults this table on every subsequent mention of
-- the alias and gives the matching candidate a decisive +200 score
-- boost so it dominates the candidates ordering.

CREATE TABLE IF NOT EXISTS user_resolution_aliases (
  id               SERIAL       PRIMARY KEY,
  client_number    VARCHAR(20)  NOT NULL,
  user_id          INTEGER      NOT NULL,
  alias            VARCHAR(120) NOT NULL, -- normalized lowercase
  identifier       VARCHAR(200) NOT NULL, -- email OR phone (normalized)
  identifier_kind  VARCHAR(20)  NOT NULL, -- 'email' | 'phone'
  display_name     VARCHAR(200),
  source           VARCHAR(20)  NOT NULL DEFAULT 'explicit',
  confidence       DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  used_count       INTEGER      NOT NULL DEFAULT 1,
  last_used_at     TIMESTAMP    NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMP    NOT NULL DEFAULT NOW()
);

-- Composite uniqueness: one row per (user, alias, identifier). Repeat
-- resolutions bump used_count + last_used_at instead of inserting.
CREATE UNIQUE INDEX IF NOT EXISTS user_resolution_aliases_user_alias_id_uq
  ON user_resolution_aliases(user_id, alias, identifier);

CREATE INDEX IF NOT EXISTS user_resolution_aliases_user_alias_idx
  ON user_resolution_aliases(user_id, alias);

CREATE INDEX IF NOT EXISTS user_resolution_aliases_client_lastused_idx
  ON user_resolution_aliases(client_number, last_used_at DESC);
