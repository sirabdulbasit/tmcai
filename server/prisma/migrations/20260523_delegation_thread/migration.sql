-- Delegation lifecycle tracking — adds the conversation-with-delegatee
-- state to open_items so the WA follow-up worker can find what to
-- chase and the closure notifier knows what to summarise to the user.
--
-- Per Basit 2026-05-23: full delegation lifecycle spec. After a user
-- delegates an open item, Brain:
--   1. emails the delegatee at delegation time (with preview)
--   2. WAs the delegatee on the due date
--   3. ingests delegatee replies (manual mark-done for v1)
--   4. notifies the user with the trail on closure
--
-- delegation_thread JSONB columns on open_items track the lifecycle
-- without adding a separate table (open_items already keyed by id).

ALTER TABLE open_items
  ADD COLUMN IF NOT EXISTS delegation_emailed_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS delegation_email_message_id TEXT,
  ADD COLUMN IF NOT EXISTS delegation_followup_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS delegation_last_followup_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS delegation_followup_trail JSONB NOT NULL DEFAULT '[]'::jsonb;
  -- delegation_followup_trail entries shape:
  --   { at: ISO, channel: 'whatsapp'|'email', direction: 'out'|'in',
  --     content: '...', reason?: '...', newDueDate?: ISO }
  -- The user-visible closure summary is built from this trail.

CREATE INDEX IF NOT EXISTS open_items_delegation_due_idx
  ON open_items (due_date, delegation_followup_count)
  WHERE status = 'DELEGATED';
