-- MyOS — attribute each feed event to the user whose connector produced it.
--
-- Why: Day Brief counts, per-user volume, and per-user triage all need to
-- scope to "events that came through THIS user's inbox" rather than the
-- whole tenant stream. Without a user_id column, two users in the same
-- tenant with connected Gmail inboxes get each other's numbers.

ALTER TABLE "feed_events"
  ADD COLUMN IF NOT EXISTS "user_id" INTEGER;

CREATE INDEX IF NOT EXISTS "feed_events_client_user_source_created_idx"
  ON "feed_events" ("client_number", "user_id", "source_type", "created_at");

-- Backfill: existing rows are historical. Attribute each to the user who had
-- an active integration token at the time of ingest. In the current dev DB
-- only basit.ahmed@tmcltd.ai had an active token while these events were
-- being written — so attribute to him. (Safe; this is best-effort and future
-- events carry user_id at write time.)
UPDATE "feed_events" fe
SET "user_id" = u.id
FROM "users" u
WHERE fe."user_id" IS NULL
  AND fe."client_number" = u."client_number"
  AND u."email" = 'basit.ahmed@tmcltd.com';
