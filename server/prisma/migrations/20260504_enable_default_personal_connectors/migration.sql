-- ════════════════════════════════════════════════════════════════════
-- Enable default personal connectors for every existing tenant.
-- ════════════════════════════════════════════════════════════════════
--
-- Why: `tenant_connector_configs` acts as a per-tenant gate. The
-- Connectors page only shows personal connectors that are explicitly
-- enabled there. Without rows in this table, end users see only the
-- one or two connectors that were enabled by historical migrations
-- (e.g. `whatsapp_personal` from 20260421), and have no way to connect
-- Gmail / Outlook / Calendar / etc.
--
-- Decision: any `connector_types` row with `is_active=TRUE AND
-- scope='personal'` is enabled by default for every tenant. Tenant
-- admins can still disable specific ones via the Admin UI; that
-- writes `is_enabled=false` to the same row. This migration only
-- creates rows that don't exist yet (ON CONFLICT DO NOTHING), so it
-- never undoes a deliberate disable.
--
-- Org-scoped connectors (CRM, ERP, BigQuery, etc.) are NOT enabled
-- here — they require admin to provide credentials, so the gate
-- staying closed by default is correct for those.

-- The `id` column is `text NOT NULL` with no DB default (Prisma generates
-- cuids in application code). For SQL inserts we mint UUIDs and cast to
-- text — the format doesn't matter, only uniqueness does.

INSERT INTO tenant_connector_configs (
  id,
  client_number,
  connector_type_id,
  scope,
  is_enabled,
  config,
  created_at,
  updated_at
)
SELECT
  gen_random_uuid()::text AS id,
  t.client_number,
  ct.id                   AS connector_type_id,
  'personal'              AS scope,
  TRUE                    AS is_enabled,
  '{}'::jsonb             AS config,
  NOW()                   AS created_at,
  NOW()                   AS updated_at
FROM tenants t
CROSS JOIN connector_types ct
WHERE ct.is_active = TRUE
  AND ct.scope = 'personal'
ON CONFLICT (client_number, connector_type_id) DO NOTHING;
