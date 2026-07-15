-- Per-user UI preferences (attention/brief window, future flags).
-- Distinct from notification_preferences (channels) and
-- agent_config_overrides (agent runtime tweaks).
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS preferences JSONB;
