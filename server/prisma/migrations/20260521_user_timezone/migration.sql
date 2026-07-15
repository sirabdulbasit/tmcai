-- Sprint 4A (2026-05-21): per-user timezone replaces the
-- hardcoded Asia/Karachi (+05:00) in compose's todayDate and the
-- dispatcher's whenIso normalization. Drives "tomorrow" resolution
-- in the user's local frame and ensures meeting invites land at the
-- user's intended local time regardless of region.
--
-- IANA timezone name (e.g., 'Asia/Karachi', 'America/New_York').
-- Default 'Asia/Karachi' for backward compatibility with the pilot
-- tenant. Set to a different IANA zone per user as we onboard
-- regions.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'Asia/Karachi';
