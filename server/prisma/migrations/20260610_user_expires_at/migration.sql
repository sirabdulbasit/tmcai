-- MyOS / Nexeo — demo users with auto-suspend at expiry.
--
-- Per Basit 2026-06-10: "how can i give any user to anyone as demo
-- with expiry date".
--
-- Adds users.expires_at (nullable). NULL = permanent account. Non-NULL
-- = will be auto-suspended (is_active flipped to false) when the
-- demoExpirySuspendJob cron runs after the timestamp passes.
--
-- Deliberately SUSPEND (reversible), not DELETE — admin can extend
-- the date or reactivate without losing the demo user's accumulated
-- data, and if needed they can hard-delete via the Delete button.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP NULL;

COMMENT ON COLUMN users.expires_at IS
  'Demo user expiry. NULL = permanent. When set + passed, demoExpirySuspendJob flips is_active=false. Admin can extend, reactivate, or hard-delete.';

-- Helpful index for the hourly sweep (small table, but cheap to add).
CREATE INDEX IF NOT EXISTS idx_users_expires_at_active
  ON users(expires_at) WHERE expires_at IS NOT NULL AND is_active = TRUE;
