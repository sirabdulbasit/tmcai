-- ============================================================
-- 20260504_whatsapp_config_max_tokens_data
--
-- saveWhatsAppConfig writes a max_tokens_data column that never had a
-- formal migration — it was a later schema addition that lived only in
-- the saveWhatsAppConfig SQL. Prod's whatsapp_config table predates
-- that addition, so every save POST 400'd with "column max_tokens_data
-- does not exist" (caught by the route handler and surfaced as a
-- generic "Failed to save config" toast).
--
-- Idempotent — safe to apply on local DBs that already have it.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS max_tokens_data INTEGER NOT NULL DEFAULT 400;
