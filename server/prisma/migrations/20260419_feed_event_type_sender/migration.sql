-- AlterTable
ALTER TABLE "feed_events" ADD COLUMN     "event_type" VARCHAR(30),
ADD COLUMN     "sender_email" VARCHAR(200),
ADD COLUMN     "sender_id" VARCHAR(200),
ADD COLUMN     "sender_name" VARCHAR(200),
ADD COLUMN     "sender_phone" VARCHAR(30);

-- CreateIndex
CREATE INDEX "feed_events_client_number_event_type_idx" ON "feed_events"("client_number", "event_type");

-- CreateIndex
CREATE INDEX "feed_events_client_number_sender_email_idx" ON "feed_events"("client_number", "sender_email");

