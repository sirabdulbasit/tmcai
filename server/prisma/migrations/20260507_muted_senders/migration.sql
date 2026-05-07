-- Per-user mute list. Senders here are dropped from My Attention AND
-- Brief; they remain in feed_events and the Wiki archive so search
-- still finds them. Distinct from CC suppression (which puts items
-- under Brief auto_cc_only) — muted senders go to neither surface.

CREATE TABLE IF NOT EXISTS muted_senders (
  id            TEXT PRIMARY KEY,
  client_number VARCHAR(20)  NOT NULL,
  user_id       INTEGER      NOT NULL,
  channel       VARCHAR(20)  NOT NULL,
  identifier    VARCHAR(255) NOT NULL,
  display_name  VARCHAR(200),
  reason        TEXT,
  created_at    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS muted_senders_user_channel_id_uq
  ON muted_senders (user_id, channel, identifier);

CREATE INDEX IF NOT EXISTS muted_senders_client_user_idx
  ON muted_senders (client_number, user_id);
