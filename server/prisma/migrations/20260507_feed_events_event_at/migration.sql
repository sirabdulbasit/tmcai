-- Add `event_at` to feed_events: source-native event time (Gmail Date
-- header, Calendar event start, WhatsApp timestamp, Tasks updated).
-- Distinct from created_at (which is DB insert / ingest time) so a
-- backfilled 30-day pull doesn't collapse every old email into "today".
--
-- Nullable: existing rows are populated by scripts/backfillFeedEventAt.ts.
-- New rows get event_at stamped at ingest from feedIngestionService.

ALTER TABLE feed_events
  ADD COLUMN IF NOT EXISTS event_at TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS feed_events_client_user_source_event_at_idx
  ON feed_events (client_number, user_id, source_type, event_at);
