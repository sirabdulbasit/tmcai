-- Seed Haseeb's Notion connector shell (from v4.1 inheritance).
-- Token is a placeholder; will be replaced with the real token once cowork
-- retrieves it from project direct-archery-492112-m2 Secret Manager.
-- Status is 'pending' until the real token is loaded; only then does
-- wikiStorageService route to Notion for this user.

DO $$
DECLARE
  v_user_id INT;
  v_notion_type_id TEXT;
BEGIN
  SELECT id INTO v_user_id FROM users WHERE email = 'haseeb@tmcltd.ai' LIMIT 1;
  SELECT id INTO v_notion_type_id FROM connector_types WHERE slug = 'notion' LIMIT 1;

  IF v_user_id IS NOT NULL AND v_notion_type_id IS NOT NULL THEN
    INSERT INTO user_connectors (
      id, user_id, client_number, connector_type_id, status, config, metadata, created_at, updated_at
    ) VALUES (
      'uc_haseeb_notion',
      v_user_id,
      'TMC-0001',
      v_notion_type_id,
      'pending',
      jsonb_build_object(
        'accessToken', 'REPLACE_WITH_REAL_NOTION_TOKEN',
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
      NOW(),
      NOW()
    )
    ON CONFLICT (user_id, connector_type_id) DO NOTHING;
  END IF;
END
$$;
