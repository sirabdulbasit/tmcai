-- MyOS — v4.1 resource-pointer seed (two-tier connector model).
--
-- Rules:
--   1. NO secrets, tokens, client_ids, or client_secrets in this file.
--      Those live at the CLIENT tier (tenant_connector_configs.config or
--      env vars) and the USER tier (user_connectors.config after OAuth) —
--      filled via Admin UI or OAuth flow, never via SQL.
--   2. This file only seeds NON-secret resource pointers that MyOS needs
--      to know exist (Drive folder IDs, Google Doc IDs, Sheet IDs, GCP
--      project, Firestore DB, WA receiver URL) + empty `user_connectors`
--      shells for haseeb so the Connectors UI renders "Configure" buttons.
--   3. All inserts are idempotent.

-- ─── 1. v4.1 resource pointers → system_config ───────────────────
-- These are not secrets; they are canonical identifiers of the resources
-- Brain reads/writes to. Seeded under `haseebos_*` prefix so they don't
-- collide with MyOS's own app config.

INSERT INTO "system_config" ("client_number", "key", "value", "is_sensitive", "description", "updated_at") VALUES
  ('TMC-0001', 'haseebos_gcp_project_id',           'direct-archery-492112-m2',                                                         false, 'v4.1 GCP project hosting wa-receiver + secrets',     CURRENT_TIMESTAMP),
  ('TMC-0001', 'haseebos_firestore_db_id',          'haseebos-buffer',                                                                  false, 'v4.1 Firestore DB used as inbound WhatsApp buffer',  CURRENT_TIMESTAMP),
  ('TMC-0001', 'haseebos_wa_receiver_url',          'https://wa-receiver-676021089475.us-central1.run.app/webhook',                     false, 'v4.1 Cloud Run webhook (Meta posts here)',           CURRENT_TIMESTAMP),
  ('TMC-0001', 'haseebos_blocked_contacts',         'Azka Bari',                                                                        false, 'v4.1 blocked inbound WA contacts (comma separated)', CURRENT_TIMESTAMP),
  ('TMC-0001', 'haseebos_drive_root_folder_id',     '0ACXnLntSeO75Uk9PVA',                                                              false, 'v4.1 master Drive folder (root of HaseebOS content)', CURRENT_TIMESTAMP),
  ('TMC-0001', 'haseebos_sw_dashboard_folder_id',   '1Sa7lE50mt5GLW2cl68jaIqOcB4lV9oky',                                                false, 'v4.1 Steering Wheel dashboard folder',               CURRENT_TIMESTAMP),
  ('TMC-0001', 'haseebos_wa_drive_folder_id',       '1VN_4gDbkeTEKjfPCRedOBBquLzOc9_CG',                                                false, 'v4.1 WA receiver media drop folder',                 CURRENT_TIMESTAMP),
  ('TMC-0001', 'haseebos_rule_book_doc_id',         '1N76rdW69IMm3HGve5RhbM8o5uTrq7yr4WIxAwuaaxTQ',                                     false, 'v4.1 rule book Google Doc',                          CURRENT_TIMESTAMP),
  ('TMC-0001', 'haseebos_decisions_log_doc_id',     '19ZjDPRYjdbB-p6hS1MohfMl4KtPO-TMaJxG4197c-EE',                                     false, 'v4.1 decisions log Google Doc',                      CURRENT_TIMESTAMP),
  ('TMC-0001', 'haseebos_open_items_sheet_id',      '1wHBC4P-8vEUVavKFFVE09uCO05t6ZduM3EsaFDH1TZk',                                     false, 'v4.1 open items Google Sheet',                       CURRENT_TIMESTAMP),
  ('TMC-0001', 'haseebos_claude_model',             'claude-sonnet-4-20250514',                                                         false, 'v4.1 default Claude model',                          CURRENT_TIMESTAMP),
  ('TMC-0001', 'haseebos_gemini_model',             'gemini-2.0-flash',                                                                 false, 'v4.1 default Gemini model',                          CURRENT_TIMESTAMP)
ON CONFLICT ("client_number", "key") DO NOTHING;

-- ─── 2. Empty user_connectors shells for haseeb ──────────────────
-- Status = 'pending'. No tokens, no client secrets. Real tokens land in
-- these rows only after the user runs OAuth from the Connectors UI.

DO $$
DECLARE
  v_user_id INT;
  v_notion_type_id     TEXT;
  v_gmail_type_id      TEXT;
  v_gcal_type_id       TEXT;
  v_gchat_type_id      TEXT;
  v_whatsapp_type_id   TEXT;
  v_drive_type_id      TEXT;
  v_gsheets_type_id    TEXT;
BEGIN
  SELECT id INTO v_user_id          FROM users           WHERE email = 'haseeb@tmcltd.ai'        LIMIT 1;
  SELECT id INTO v_notion_type_id   FROM connector_types WHERE slug = 'notion'                   LIMIT 1;
  SELECT id INTO v_gmail_type_id    FROM connector_types WHERE slug = 'gmail'                    LIMIT 1;
  SELECT id INTO v_gcal_type_id     FROM connector_types WHERE slug = 'google_calendar'          LIMIT 1;
  SELECT id INTO v_gchat_type_id    FROM connector_types WHERE slug = 'google_chat'              LIMIT 1;
  SELECT id INTO v_whatsapp_type_id FROM connector_types WHERE slug = 'whatsapp'                 LIMIT 1;
  SELECT id INTO v_drive_type_id    FROM connector_types WHERE slug = 'google_drive_personal'    LIMIT 1;
  SELECT id INTO v_gsheets_type_id  FROM connector_types WHERE slug = 'google_sheets'            LIMIT 1;

  IF v_user_id IS NULL THEN
    RAISE NOTICE 'haseeb@tmcltd.ai not found — skipping user_connectors seed';
    RETURN;
  END IF;

  -- Notion — carries the 11 v4.1 Notion DB IDs (resource pointers, not secrets).
  -- Access token lands here after Notion OAuth.
  IF v_notion_type_id IS NOT NULL THEN
    INSERT INTO user_connectors (id, user_id, client_number, connector_type_id, status, config, metadata, created_at, updated_at)
    VALUES (
      'uc_haseeb_notion',
      v_user_id, 'TMC-0001', v_notion_type_id, 'pending',
      jsonb_build_object(
        'rootPageId', NULL,
        'databases', jsonb_build_object(
          'entity_wiki',         '1d1e67fa-fe72-80ca-9dca-f56b8a4c9b87',
          'decision_wiki',       '1d4e67fa-fe72-8041-bca2-d19a3f00f2c3',
          'pattern_wiki',        '1d4e67fa-fe72-80f8-97d1-ce55e16e1085',
          'project_wiki',        '1d1e67fa-fe72-80e2-a93b-d78a1b63e1b6',
          'concept_wiki',        '1d4e67fa-fe72-8039-9f45-c4e5e4780e5b',
          'meeting_wiki',        '1d4e67fa-fe72-80f9-ae4f-c4dadc818a24',
          'pipeline_delivery',   '1d1e67fa-fe72-8020-abec-d10f8e37de24',
          'pipeline_sales',      '1d1e67fa-fe72-8075-b2b2-ea6f8dc66c38',
          'pipeline_strategic',  '1d4e67fa-fe72-80c3-9fee-e4f5dd104d84',
          'pipeline_innovation', '1d8e67fa-fe72-8082-abb8-c2f6a4ceaa4d',
          'pipeline_operations', '1d8e67fa-fe72-80ae-a38f-c49f1fb9e64e'
        )
      ),
      jsonb_build_object('source', 'v4.1_inheritance', 'seededAt', NOW()::text),
      NOW(), NOW()
    )
    ON CONFLICT (user_id, connector_type_id) DO NOTHING;
  END IF;

  -- Gmail shell — OAuth flow fills refreshToken.
  IF v_gmail_type_id IS NOT NULL THEN
    INSERT INTO user_connectors (id, user_id, client_number, connector_type_id, status, config, metadata, created_at, updated_at)
    VALUES (
      'uc_haseeb_gmail',
      v_user_id, 'TMC-0001', v_gmail_type_id, 'pending',
      jsonb_build_object(
        'provider', 'google',
        'accountEmail', 'abdulhaseeb09@gmail.com',
        'scopes', jsonb_build_array('gmail.readonly', 'gmail.send', 'gmail.modify')
      ),
      jsonb_build_object('source', 'v4.1_inheritance', 'seededAt', NOW()::text),
      NOW(), NOW()
    )
    ON CONFLICT (user_id, connector_type_id) DO NOTHING;
  END IF;

  -- Google Calendar shell
  IF v_gcal_type_id IS NOT NULL THEN
    INSERT INTO user_connectors (id, user_id, client_number, connector_type_id, status, config, metadata, created_at, updated_at)
    VALUES (
      'uc_haseeb_gcal',
      v_user_id, 'TMC-0001', v_gcal_type_id, 'pending',
      jsonb_build_object(
        'provider', 'google',
        'accountEmail', 'abdulhaseeb09@gmail.com',
        'scopes', jsonb_build_array('calendar.readonly', 'calendar.events')
      ),
      jsonb_build_object('source', 'v4.1_inheritance', 'seededAt', NOW()::text),
      NOW(), NOW()
    )
    ON CONFLICT (user_id, connector_type_id) DO NOTHING;
  END IF;

  -- Google Chat shell — admin provides webhook URL at tenant level (Admin UI).
  IF v_gchat_type_id IS NOT NULL THEN
    INSERT INTO user_connectors (id, user_id, client_number, connector_type_id, status, config, metadata, created_at, updated_at)
    VALUES (
      'uc_haseeb_gchat',
      v_user_id, 'TMC-0001', v_gchat_type_id, 'pending',
      jsonb_build_object('spaceName', 'MD Office'),
      jsonb_build_object('source', 'v4.1_inheritance', 'seededAt', NOW()::text),
      NOW(), NOW()
    )
    ON CONFLICT (user_id, connector_type_id) DO NOTHING;
  END IF;

  -- WhatsApp inbound (per-user). Receiver URL is a non-secret pointer.
  IF v_whatsapp_type_id IS NOT NULL THEN
    INSERT INTO user_connectors (id, user_id, client_number, connector_type_id, status, config, metadata, created_at, updated_at)
    VALUES (
      'uc_haseeb_whatsapp',
      v_user_id, 'TMC-0001', v_whatsapp_type_id, 'pending',
      jsonb_build_object(
        'provider',   'meta',
        'webhookUrl', 'https://wa-receiver-676021089475.us-central1.run.app/webhook'
      ),
      jsonb_build_object('source', 'v4.1_inheritance', 'seededAt', NOW()::text),
      NOW(), NOW()
    )
    ON CONFLICT (user_id, connector_type_id) DO NOTHING;
  END IF;

  -- Google Drive — carries v4.1 folder pointers (non-secret).
  IF v_drive_type_id IS NOT NULL THEN
    INSERT INTO user_connectors (id, user_id, client_number, connector_type_id, status, config, metadata, created_at, updated_at)
    VALUES (
      'uc_haseeb_gdrive',
      v_user_id, 'TMC-0001', v_drive_type_id, 'pending',
      jsonb_build_object(
        'provider',     'google',
        'accountEmail', 'abdulhaseeb09@gmail.com',
        'rootFolderId', '0ACXnLntSeO75Uk9PVA',
        'folders', jsonb_build_object(
          'sw_dashboard', '1Sa7lE50mt5GLW2cl68jaIqOcB4lV9oky',
          'wa_drop',      '1VN_4gDbkeTEKjfPCRedOBBquLzOc9_CG'
        )
      ),
      jsonb_build_object('source', 'v4.1_inheritance', 'seededAt', NOW()::text),
      NOW(), NOW()
    )
    ON CONFLICT (user_id, connector_type_id) DO NOTHING;
  END IF;

  -- Google Sheets — carries the Open Items sheet pointer.
  IF v_gsheets_type_id IS NOT NULL THEN
    INSERT INTO user_connectors (id, user_id, client_number, connector_type_id, status, config, metadata, created_at, updated_at)
    VALUES (
      'uc_haseeb_gsheets',
      v_user_id, 'TMC-0001', v_gsheets_type_id, 'pending',
      jsonb_build_object(
        'provider',     'google',
        'accountEmail', 'abdulhaseeb09@gmail.com',
        'sheets', jsonb_build_object(
          'open_items', '1wHBC4P-8vEUVavKFFVE09uCO05t6ZduM3EsaFDH1TZk'
        )
      ),
      jsonb_build_object('source', 'v4.1_inheritance', 'seededAt', NOW()::text),
      NOW(), NOW()
    )
    ON CONFLICT (user_id, connector_type_id) DO NOTHING;
  END IF;
END
$$;

-- ─── 3. Tenant-level WhatsApp Notifier shell (outbound) ───────────
-- is_active=false until admin fills phone_number_id + encrypted token
-- via Admin → WhatsApp Notifier.

INSERT INTO tenant_whatsapp_notifier (
  client_number, provider, display_number, phone_number_id, access_token_encrypted,
  app_id, waba_id, is_active, created_at, updated_at
) VALUES (
  'TMC-0001', 'meta', NULL, NULL, NULL, NULL, NULL, false,
  CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
)
ON CONFLICT (client_number) DO NOTHING;
