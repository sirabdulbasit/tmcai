-- Fix the brain_pending_actions UNIQUE(user_id, channel, status) constraint
-- (2026-05-22). Original intent was "one active pending per channel" but the
-- triple including status accidentally also enforced "one terminal row per
-- user/channel per status" — so the moment we tried to cancel a stale
-- preview_shown row by transitioning it to 'cancelled', it collided with the
-- pre-existing 'cancelled' row from the previous turn.
--
-- Symptom: startPending's updateMany→create sequence threw a unique
-- violation, the catch in compose() swallowed the error silently, no pending
-- row got persisted, and the next-turn "send" confirmation had nothing to
-- dispatch — user saw the empty-promise fallback for a week.
--
-- Fix: drop the strict constraint and replace with a PARTIAL unique index
-- that only enforces uniqueness for the three active statuses. Terminal
-- rows (cancelled / completed / failed / expired) can accumulate freely.

ALTER TABLE brain_pending_actions
  DROP CONSTRAINT IF EXISTS brain_pending_actions_user_channel_status_uq;

CREATE UNIQUE INDEX IF NOT EXISTS brain_pending_actions_user_channel_active_uq
  ON brain_pending_actions (user_id, channel)
  WHERE status IN ('collecting_slots', 'preview_shown', 'confirmed');
