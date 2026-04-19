-- HaseebOS v15 L1.3/L1.4/L1.5 — feed publish state + tamper-evidence
ALTER TABLE "feed_events"
  ADD COLUMN IF NOT EXISTS "published_message_id" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "published_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "publish_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "source_integrity" VARCHAR(64);

CREATE INDEX IF NOT EXISTS "feed_events_client_number_published_message_id_idx"
  ON "feed_events"("client_number", "published_message_id");
