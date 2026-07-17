-- Formalize sticky WhatsApp agent-session state used by WhatsAppInbound.
-- Idempotent for production databases created before these fields existed.
ALTER TABLE whatsapp_sessions
  ADD COLUMN IF NOT EXISTS active_agent_id INTEGER,
  ADD COLUMN IF NOT EXISTS active_agent_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS agent_session_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_wa_session_active_agent
  ON whatsapp_sessions (client_number, user_id, active_agent_id)
  WHERE closed_at IS NULL AND active_agent_id IS NOT NULL;
