DROP INDEX IF EXISTS feed_events_client_user_source_event_at_idx;
ALTER TABLE feed_events DROP COLUMN IF EXISTS event_at;
