# Cowork — Connector Setup Handoff (two-tier model)

**Date:** 2026-04-19
**Tenant:** TMC-0001
**Target user:** haseeb@tmcltd.ai (MD, user_id=5)
**Source project:** `direct-archery-492112-m2` (GCP, v4.1 HaseebOS + wa-receiver)

## Connector model

MyOS has **two tiers** — no secret should ever be hard-coded in a SQL seed.

| Tier | Table | Who configures | What it stores |
|---|---|---|---|
| **Client / tenant** | `tenant_connector_configs`, `tenant_whatsapp_notifier`, `system_config` | Tenant admin (once) | Shared OAuth **app** credentials (client_id, client_secret), WhatsApp Business sender token, resource pointers (Drive folder IDs, Google Doc IDs, Firestore DB, etc.) |
| **User** | `user_connectors` | Each user (via OAuth flow or API-key form) | That user's **refresh token**, account email, and any per-user resource IDs (their Notion DB IDs, their WhatsApp number) |

The seed migration `20260420_connector_seed_v41` + `20260420_connector_seed_v41_split` populated:

- **15 resource pointers** (non-secret) in `system_config` under `haseebos_*` keys — Drive folders, Doc IDs, Sheet IDs, GCP project, Firestore DB, WA receiver URL. Safe to seed because they're not credentials.
- **7 empty `user_connectors` shells** for haseeb (gmail, google_calendar, google_chat, google_drive_personal, google_sheets, notion, whatsapp) in `status='pending'` with no tokens, no client secrets. These exist so the Connectors UI shows him "Configure" buttons for the connectors he needs.
- **1 `tenant_whatsapp_notifier` shell** for TMC-0001 (outbound WA sender) with `is_active=false`. Admin must fill phone_number_id + token via the Admin UI.

No tokens, no client secrets, no refresh tokens are in any seed file.

---

## What cowork has to do

### Step 1 — Register TMC's Google OAuth app at the CLIENT tier

MyOS reads Google OAuth app creds from env vars today (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`). Either:

- **Option A (fast):** Reuse the existing TMC Google OAuth app (already in `tmcai/server/.env` as `GOOGLE_CLIENT_ID=822210030240-...`). Confirm the redirect URI `https://myos.tallymarks.ai/api/v1/connectors/oauth/callback` is registered in the Google Cloud Console for that client.
- **Option B:** Register a new app in project `direct-archery-492112-m2` and put its client_id / client_secret into `.env` on the prod box. Redirect URI same as above.

No DB change needed for Google — env is the source of truth.

### Step 2 — Set up Meta WhatsApp Business App at the CLIENT tier (outbound)

This is the **one-to-many** sender — Brain uses it to WhatsApp any user in TMC-0001.

1. <https://developers.facebook.com/> → create a Business App → add **WhatsApp** product.
2. In WhatsApp → API Setup, copy: display number, **Phone Number ID**, permanent **System User access token** (not the 24h one), App ID, WABA ID.
3. Log into MyOS as an admin (haseeb@tmcltd.ai) → **Admin → WhatsApp Notifier** → paste values → Save → Verify. The UI AES-256-GCM encrypts the token before storing.

### Step 3 — Have Haseeb connect his USER-tier connectors

Haseeb logs in and opens **Connectors** in the left rail. He'll see 19 available connectors; the 7 we pre-listed for him are in "pending" status (no grey-to-green transition yet).

For each one:

- **Gmail, Google Calendar, Google Drive, Google Tasks, Google Sheets, Google Chat** → click *Configure* → OAuth flow → Google consent screen → redirect back → `user_connectors` row is filled with his refresh token and flipped to `status='connected'`.
- **Notion** → click *Configure* → Notion OAuth flow → select the 11 v4.1 DBs (they're already listed as pointers in the `user_connectors.config.databases` field so the wiki service knows which DBs to write to). The OAuth step only fills the access token.
- **WhatsApp (inbound)** → enter Haseeb's WhatsApp phone number → the row already carries the `wa-receiver-...run.app/webhook` URL as the Meta webhook target.

### Step 4 — WhatsApp receiver routing

Two paths:

- **Option A (bridge):** Keep `wa-receiver` on Cloud Run and have it forward each inbound event to `https://myos.tallymarks.ai/api/v1/webhooks/whatsapp/TMC-0001`. No Meta-side change.
- **Option B (cutover):** Update the Meta app's webhook URL to point directly at MyOS. Verify token must match whatever is stored on the `uc_haseeb_whatsapp` row.

### Step 5 — ANTHROPIC_API_KEY

Still an env var. Retrieve from Secret Manager and install:

```bash
gcloud secrets versions access latest --secret=ANTHROPIC_API_KEY
# then edit tmcai/server/.env → ANTHROPIC_API_KEY=sk-ant-...
sudo systemctl restart tmcai-server
```

---

## Resource pointers (already seeded, non-secret)

These are in `system_config` under `haseebos_*` keys — safe to have in source control:

| Key | Value |
|---|---|
| `haseebos_gcp_project_id` | `direct-archery-492112-m2` |
| `haseebos_firestore_db_id` | `haseebos-buffer` |
| `haseebos_wa_receiver_url` | `https://wa-receiver-676021089475.us-central1.run.app/webhook` |
| `haseebos_drive_root_folder_id` | `0ACXnLntSeO75Uk9PVA` |
| `haseebos_sw_dashboard_folder_id` | `1Sa7lE50mt5GLW2cl68jaIqOcB4lV9oky` |
| `haseebos_wa_drive_folder_id` | `1VN_4gDbkeTEKjfPCRedOBBquLzOc9_CG` |
| `haseebos_rule_book_doc_id` | `1N76rdW69IMm3HGve5RhbM8o5uTrq7yr4WIxAwuaaxTQ` |
| `haseebos_decisions_log_doc_id` | `19ZjDPRYjdbB-p6hS1MohfMl4KtPO-TMaJxG4197c-EE` |
| `haseebos_open_items_sheet_id` | `1wHBC4P-8vEUVavKFFVE09uCO05t6ZduM3EsaFDH1TZk` |
| `haseebos_blocked_contacts` | `Azka Bari` |
| `haseebos_claude_model` | `claude-sonnet-4-20250514` |
| `haseebos_gemini_model` | `gemini-2.0-flash` |

One entry is still a placeholder (needs lookup from Secret Manager because the source doc truncated it):

```bash
gcloud secrets versions access latest --secret=MASTER_CONTEXT_DOC_ID
# then:
# UPDATE system_config SET value = '<real-id>' WHERE client_number = 'TMC-0001' AND key = 'haseebos_master_context_doc_id';
```

---

## Verification

```sql
-- (a) No placeholder values remaining in system_config
SELECT key, LEFT(value, 40) FROM system_config
WHERE client_number='TMC-0001' AND value LIKE 'REPLACE_%';

-- (b) All 7 user_connectors have no shared secrets baked in (they should
--     only show scopes, DB IDs, provider — NOT clientId/clientSecret/tokens)
SELECT ct.slug, uc.config
FROM user_connectors uc
JOIN connector_types ct ON ct.id=uc.connector_type_id
WHERE uc.user_id=(SELECT id FROM users WHERE email='haseeb@tmcltd.ai');

-- (c) After Haseeb runs OAuth, these should flip to 'connected'
SELECT ct.slug, uc.status FROM user_connectors uc
JOIN connector_types ct ON ct.id=uc.connector_type_id
WHERE uc.user_id=(SELECT id FROM users WHERE email='haseeb@tmcltd.ai');
```

## Checklist

- [ ] `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` present in prod `.env` with redirect URI registered
- [ ] Meta WhatsApp Business App registered; Notifier configured via Admin UI; `Verify` green
- [ ] Haseeb runs OAuth for Gmail → `uc_haseeb_gmail.status='connected'`
- [ ] Haseeb runs OAuth for Google Calendar → `uc_haseeb_gcal.status='connected'`
- [ ] Haseeb runs OAuth for Google Drive / Sheets / Tasks → connected
- [ ] Haseeb connects Notion → `uc_haseeb_notion.status='connected'` + 11 DB IDs present
- [ ] Haseeb enters his WA number on WhatsApp connector
- [ ] `wa-receiver` forwards (or Meta rewired) to MyOS
- [ ] `ANTHROPIC_API_KEY` in `.env`
- [ ] `haseebos_master_context_doc_id` filled via SQL

Feed goes live once any one of Gmail / Calendar / WhatsApp (inbound) is green.
