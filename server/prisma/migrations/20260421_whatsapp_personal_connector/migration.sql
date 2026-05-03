-- MyOS — whatsapp_personal connector (Path A, QR-scan pairing via whatsapp-web.js).
--
-- Distinct from `whatsapp` (Meta Cloud API, tenant-scoped). This one is
-- personal: MD scans QR on their phone → inbound WhatsApp chats land in
-- My Attention as feed_events with sourceType='whatsapp'. Terminal
-- actions can markAsRead + send replies on MD's behalf.

INSERT INTO connector_types (id, slug, name, description, category, scope, auth_method, config_schema, capabilities, icon, is_active, created_at)
SELECT 'ct_whatsapp_personal', 'whatsapp_personal', 'WhatsApp (Personal)',
       'Pair your personal WhatsApp via QR scan. Messages appear in My Attention; Brain can reply, mark-as-read, and learn your patterns.',
       'messaging', 'personal', 'qr_pair',
       '{"fields":[]}'::jsonb,
       '["read","write"]'::jsonb,
       'whatsapp', TRUE, NOW()
WHERE NOT EXISTS (SELECT 1 FROM connector_types WHERE slug = 'whatsapp_personal');

-- Enable the new connector for every existing tenant so it shows up in the
-- Connectors UI. Idempotent — won't duplicate existing rows.
DO $$
DECLARE
  v_type_id TEXT;
  v_tenant  RECORD;
BEGIN
  SELECT id INTO v_type_id FROM connector_types WHERE slug = 'whatsapp_personal' LIMIT 1;
  IF v_type_id IS NULL THEN RETURN; END IF;
  FOR v_tenant IN SELECT DISTINCT client_number FROM users WHERE client_number IS NOT NULL LOOP
    INSERT INTO tenant_connector_configs (id, client_number, connector_type_id, scope, is_enabled, created_at, updated_at)
    VALUES ('tcc_' || replace(v_tenant.client_number, '-', '_') || '_whatsapp_personal', v_tenant.client_number, v_type_id, 'personal', TRUE, NOW(), NOW())
    ON CONFLICT (client_number, connector_type_id) DO UPDATE SET is_enabled = TRUE, updated_at = NOW();
  END LOOP;
END $$;

-- Seed an empty user_connectors shell for Haseeb so the Connectors UI shows
-- "Configure" (idempotent; also harmless if the user doesn't exist yet).
DO $$
DECLARE
  v_user_id INT;
  v_type_id TEXT;
BEGIN
  SELECT id INTO v_user_id FROM users WHERE email = 'haseeb@tmcltd.ai' LIMIT 1;
  SELECT id INTO v_type_id FROM connector_types WHERE slug = 'whatsapp_personal' LIMIT 1;
  IF v_user_id IS NOT NULL AND v_type_id IS NOT NULL THEN
    INSERT INTO user_connectors (id, user_id, client_number, connector_type_id, status, config, metadata, created_at, updated_at)
    VALUES ('uc_haseeb_whatsapp_personal', v_user_id, 'TMC-0001', v_type_id, 'pending', '{}'::jsonb, '{"status":"disconnected"}'::jsonb, NOW(), NOW())
    ON CONFLICT (user_id, connector_type_id) DO NOTHING;
  END IF;
END $$;
