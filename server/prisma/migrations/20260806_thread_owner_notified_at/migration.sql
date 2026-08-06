-- DEF-081 — record when the owner was actually TOLD.
--
-- Every notification failure on 2026-08-06 was silent because the ask lived in
-- delegation_threads, the notification in brain_prompt_queue, and nothing
-- joined them. "She answered and he never heard about it" was not a question
-- the database could answer. Now it is:
--
--   SELECT * FROM delegation_threads t
--    WHERE EXISTS (SELECT 1 FROM delegation_thread_events e
--                   WHERE e.thread_id = t.id AND e.direction = 'inbound')
--      AND t.owner_notified_at IS NULL;
--
-- Additive, nullable, idempotent. No backfill: existing rows are genuinely
-- unknown, and writing a timestamp we cannot evidence would be the same
-- fabrication this column exists to prevent.
ALTER TABLE delegation_threads
  ADD COLUMN IF NOT EXISTS owner_notified_at TIMESTAMP(3);

-- Supports the recovery sweep: threads that heard back but never told him.
CREATE INDEX IF NOT EXISTS delegation_threads_unnotified_ix
  ON delegation_threads (client_number, owner_notified_at)
  WHERE owner_notified_at IS NULL;
