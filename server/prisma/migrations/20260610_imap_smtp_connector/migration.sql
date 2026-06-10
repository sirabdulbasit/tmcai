-- MyOS / Nexeo — IMAP+SMTP email connector for tenants who don't use
-- Gmail or Microsoft 365 (e.g. Zoho, ProtonMail, cPanel webmail,
-- private corporate mail servers). Stored credentials are AES-256-GCM
-- encrypted in user_connectors.config (handled by ImapSmtpService).
--
-- Auth model: traditional username + password (or app-password). No
-- OAuth — the whole point is supporting providers that don't ship an
-- OAuth surface.
--
-- Inbound: ImapSmtpFeedAdapter polls IMAP every N min via genericFeedPoller.
-- Outbound: sendEmail() routes through nodemailer SMTP transport when
-- the user has imap_smtp configured AND lacks Gmail/Outlook integration.

INSERT INTO connector_types (id, slug, name, description, category, scope, auth_method, config_schema, capabilities, icon, is_active, created_at)
SELECT 'ct_imap_smtp', 'imap_smtp', 'Email (IMAP + SMTP)',
       'Connect any IMAP+SMTP email account (Zoho, ProtonMail, cPanel, private mail server, custom domains). Use this when your provider isn''t Gmail or Microsoft 365.',
       'email', 'personal', 'credentials',
       '{"fields":[
          {"n":"imapHost","l":"IMAP Host","t":"text","r":true,"placeholder":"e.g. imap.zoho.com"},
          {"n":"imapPort","l":"IMAP Port","t":"number","r":true,"placeholder":"993"},
          {"n":"imapTls","l":"IMAP TLS","t":"checkbox","r":false,"default":true},
          {"n":"smtpHost","l":"SMTP Host","t":"text","r":true,"placeholder":"e.g. smtp.zoho.com"},
          {"n":"smtpPort","l":"SMTP Port","t":"number","r":true,"placeholder":"465"},
          {"n":"smtpTls","l":"SMTP TLS","t":"checkbox","r":false,"default":true},
          {"n":"username","l":"Email Address","t":"email","r":true,"placeholder":"you@yourdomain.com"},
          {"n":"password","l":"Password (or App Password)","t":"password","r":true,"placeholder":"App password recommended"}
        ]}'::jsonb,
       '["read","write"]'::jsonb,
       'email', TRUE, NOW()
WHERE NOT EXISTS (SELECT 1 FROM connector_types WHERE slug = 'imap_smtp');

-- Enable for every existing tenant — admin can disable in
-- Admin → Connectors if their tenant doesn't need it.
DO $$
DECLARE
  v_type_id TEXT;
  v_tenant  RECORD;
BEGIN
  SELECT id INTO v_type_id FROM connector_types WHERE slug = 'imap_smtp' LIMIT 1;
  IF v_type_id IS NULL THEN RETURN; END IF;
  FOR v_tenant IN SELECT DISTINCT client_number FROM users WHERE client_number IS NOT NULL LOOP
    INSERT INTO tenant_connector_configs (id, client_number, connector_type_id, scope, is_enabled, created_at, updated_at)
    VALUES (
      'tcc_' || replace(v_tenant.client_number, '-', '_') || '_imap_smtp',
      v_tenant.client_number, v_type_id, 'personal', TRUE, NOW(), NOW()
    )
    ON CONFLICT (client_number, connector_type_id) DO UPDATE SET is_enabled = TRUE, updated_at = NOW();
  END LOOP;
END $$;
