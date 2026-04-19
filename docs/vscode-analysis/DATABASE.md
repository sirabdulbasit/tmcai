# TMC AI Intelligence — Database Design

**Last Updated**: 2026-04-11
**Database**: `tmcai` on PostgreSQL 18
**ORM**: Prisma 6 (prisma-client-js generator)
**Schema**: `server/prisma/schema.prisma`
**Total tables**: 49 (38 original + 11 MyOS)

---

## Overview

Multi-tenant PostgreSQL database for the 3-layer Enterprise Intelligence Platform:
- **Layer 1 (Org):** `documents`, `chunks`, `knowledge_items`, `domain_knowledge`
- **Layer 2 (Personal):** `personal_documents`, `personal_chunks` — user-scoped, admin-invisible
- **Layer 3 (Agents):** `agents`, `agent_actions`, `agent_templates`
- **Infrastructure:** `tenants`, `users`, `sessions`, `system_config`, `audit_log`, `api_keys`
- **Comms:** `whatsapp_connections`, `whatsapp_messages`, `whatsapp_sessions`
- **Marketplace:** `marketplace_connectors`, `marketplace_installations`
- **MyOS Connectors:** `connector_types`, `tenant_connector_configs`, `user_connectors`
- **MyOS Open Items:** `open_items`
- **MyOS Entities:** `entities`, `entity_links`
- **MyOS Brain:** `brain_configs`
- **MyOS Decisions:** `decision_logs`
- **MyOS Thought Pipeline:** `thought_entries`
- **MyOS OKR:** `okrs`
- **MyOS Risk:** `risk_register_items`

All tables include `client_number` for tenant isolation **except** personal data tables which are scoped by `user_id` only (admin cannot query them).

---

## Entity Relationship Diagram

```
tenants (client_number PK)
    |
    +----< system_config (branding, feature flags, per-tenant settings)
    |
    +----< users ─────────────────────────────────────────────┐
    |          |                                               │
    |          +── sessions (token auth)                      │
    |          |                                               │
    |          +── conversations ──< messages                 │
    |          |                                               │
    |          +── personal_documents ──< personal_chunks     │ (user-scoped only)
    |          |                                               │
    |          +── whatsapp_connections                        │
    |          |    └── whatsapp_messages                      │
    |          |    └── whatsapp_sessions                      │
    |          |                                               │
    |          +── agents ──< agent_actions                   │
    |          |                                               │
    |          └── audit_log, scheduled_tasks                  │
    |                                                          │
    +----< documents ──< chunks (org knowledge)               │
    |                                                          │
    +----< knowledge_items (curated KB)                        │
    |                                                          │
    +────────────────────────────────────────────────────────-+
         domain_knowledge (global; region+vertical)
         index_events (indexing queue)
         proactive_alerts (org-scoped AI alerts)
         api_keys ──< api_key_usage
         marketplace_connectors ──< marketplace_installations
         agent_templates (pre-built templates)
```

---

## Tables

### Core Infrastructure

#### 1. tenants
| Column | Type | Description |
|--------|------|-------------|
| client_number | VARCHAR(20) PK | Tenant identifier (e.g., "TMC") |
| name | VARCHAR(100) | Display name |
| is_active | BOOLEAN | Account status |
| created_at / updated_at | TIMESTAMPTZ | Timestamps |

#### 2. system_config
Key-value store for all per-tenant settings, feature flags, and branding. Sensitive values AES-256-GCM encrypted.

| Column | Type | Description |
|--------|------|-------------|
| client_number | VARCHAR(20) PK | Tenant |
| key | VARCHAR(50) PK | Setting name (e.g., `ff_agents`, `branding_app_name`) |
| value | TEXT | Plaintext or `iv:authTag:ciphertext` (base64) |
| is_sensitive | BOOLEAN | If true, value is encrypted |
| description | VARCHAR(255) | Human-readable label |
| updated_at | TIMESTAMPTZ | Last change |

**Feature flags** stored here: `ff_content_safety_enabled`, `ff_agents`, `ff_whatsapp_enabled`, `feature_api_access`, `feature_marketplace`, `ff_domain_llm_traffic_pct`, etc.
**Branding keys**: `branding_app_name`, `branding_logo_url`, `branding_primary_color`, `branding_accent_color`, `branding_custom_css`, `branding_custom_domain`, `branding_favicon_url`, `branding_remove_powered_by`

---

### Users & Auth

#### 3. users
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| client_number | VARCHAR(20) | Tenant |
| empcode | VARCHAR(20) | Employee code |
| name | VARCHAR(100) | Full name |
| email | VARCHAR(100) | Email (unique per tenant) |
| password_hash | VARCHAR(255) | bcrypt (10 rounds) |
| department | VARCHAR(50) | Department |
| role_id | INT FK → roles.id | |
| is_active | BOOLEAN | Account status |
| last_login_at | TIMESTAMPTZ | |
| failed_attempts | INT | Consecutive login failures |
| locked_until | TIMESTAMPTZ | Lockout expiry (after 5 failures) |
| job_description | TEXT | HR-managed (read-only) |
| about_me | TEXT | User-written background |
| instructions | TEXT | Custom AI behavior rules |
| tone_preference | VARCHAR(30) | friendly/formal/executive/casual/technical |
| **encrypted_dek** | TEXT | **Phase 4:** AES-256-GCM encrypted DEK (`iv:authTag:ct`, base64). Null until Phase 4 DEK generation |
| **personal_drive_folder_id** | VARCHAR(255) | **Phase 3:** User's GDrive folder ID for personal sync |
| **personal_drive_last_sync** | TIMESTAMPTZ | **Phase 3:** Last personal GDrive sync time |
| created_at / updated_at | TIMESTAMPTZ | |

**Envelope Encryption (Phase 4):**
- MEK (Master Encryption Key): stored in GCP Secret Manager, never in env vars
- DEK (Data Encryption Key): per-user 256-bit random, encrypted by MEK, stored in `encrypted_dek`
- Password reset is safe: DEK is MEK-encrypted, independent of password
- Admin cannot access personal data: DEK only in session memory during active session

#### 4. sessions
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| token | VARCHAR(255) UNIQUE | 64-char hex (crypto.randomBytes(32)) |
| user_id | INT FK → users.id | |
| expires_at | TIMESTAMPTZ | 72h from creation |
| is_revoked | BOOLEAN | Set on logout |
| user_agent / ip_address | VARCHAR | Browser/IP for audit |

---

### Organizational Knowledge

#### 5. documents
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| client_number | VARCHAR(20) | Tenant |
| source | VARCHAR(50) | Connector (google_drive, bigquery, upload) |
| source_id | VARCHAR(255) | External ID |
| title | VARCHAR(255) | Document title |
| department | VARCHAR(50) | ACL: which department owns this |
| sync_status | VARCHAR(20) | pending/indexed/failed/stale/archived |
| content_hash | VARCHAR(64) | SHA-256 for change detection |
| last_modified_at / last_checked_at | TIMESTAMPTZ | Sync timestamps |

#### 6. chunks
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| client_number | VARCHAR(20) | Tenant |
| document_id | INT FK → documents.id CASCADE | |
| content | TEXT | Chunk text |
| embedding | JSON | 3072-dim vector (Gemini embedding-001) |
| chunk_index | INT | Position in document |
| header_path | TEXT[] | Hierarchical headers |
| content_hash | VARCHAR(64) UNIQUE | SHA-256 |
| department | VARCHAR(50) | ACL: inherits from document |
| source | VARCHAR(50) | Connector name |
| metadata | JSONB | Extensible metadata |

#### 7. knowledge_items (Phase 5)
Curated knowledge base entries. Semantic search via in-memory cosine.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| client_number | VARCHAR(20) | Tenant |
| category | VARCHAR(50) | Item category |
| title | VARCHAR(255) | Title |
| content | TEXT | Full content |
| tags | TEXT[] | Searchable tags |
| embedding | JSONB | Embedding vector |
| source / source_id | VARCHAR | Origin reference |
| created_by | INT FK → users.id | Author |

#### 8. domain_knowledge (Phase 6)
Global domain expert knowledge base. Hierarchical (parent_id self-reference). Searchable via recursive CTE.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| region | VARCHAR(20) | pk / ae / sa / qa / global |
| vertical | VARCHAR(30) | general / manufacturing / petroleum / finance / public |
| category | VARCHAR(30) | regulatory / compliance / tax / labour / corporate |
| title | VARCHAR(255) | |
| content | TEXT | |
| parent_id | INT FK → domain_knowledge.id | Hierarchy |
| tags | TEXT[] | |
| source / source_ref | VARCHAR | e.g., "FBR", "SECP" |
| embedding | JSONB | |

**Pre-seeded:** FBR Tax (PK), SECP Corporate (PK), UAE Corporate Tax, UAE Labour Law, KSA Vision 2030, Qatar Business Environment

---

### Personal Intelligence (Phase 3–4)

> **Security:** All personal tables are scoped by `user_id` only. No `client_number` column. Admin queries NEVER touch these tables. Audit log records `[PERSONAL_DATA_USED: true]` but never the content.

#### 9. personal_documents
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| user_id | INT FK → users.id CASCADE | Owner |
| source | VARCHAR(20) | 'gdrive' or 'upload' |
| external_id | VARCHAR(255) | GDrive file ID (null for uploads) |
| folder_id | VARCHAR(255) | GDrive folder ID |
| file_name | VARCHAR(255) | |
| mime_type | VARCHAR(100) | |
| size_bytes | INT | |
| content_hash | VARCHAR(64) | SHA-256 for dedup |
| storage_path | VARCHAR(500) | GCS path (uploads only) |
| parse_status | VARCHAR(20) | pending/processing/done/error |
| parse_error | TEXT | |

#### 10. personal_chunks
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| user_id | INT | Owner |
| document_id | INT FK → personal_documents.id CASCADE | |
| content | TEXT | Chunk text |
| embedding | JSONB | Embedding vector |
| chunk_index | INT | |
| content_hash | VARCHAR(64) | |

---

### Organizational Intelligence (Phase 5)

#### 11. index_events
DB-backed event queue for incremental re-indexing. Processor polls every 10s with `FOR UPDATE SKIP LOCKED`.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| client_number | VARCHAR(20) | Tenant |
| event_type | VARCHAR(50) | document_added, document_modified, etc. |
| source / source_id | VARCHAR | Origin |
| status | VARCHAR(20) | pending/processing/done/failed |
| priority | INT | 1=high, 5=normal, 10=low |
| payload | JSONB | Event data |
| error | TEXT | |
| created_at / processed_at | TIMESTAMPTZ | |

#### 12. proactive_alerts
AI-generated anomaly and insight notifications. Deduplicated per `alert_type + client_number` within 24h.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| client_number | VARCHAR(20) | Tenant |
| alert_type | VARCHAR(50) | anomaly_high_cost, daily_insights, etc. |
| title | VARCHAR(255) | |
| content | TEXT | Alert body |
| severity | VARCHAR(20) | info/warning/critical |
| is_read | BOOLEAN | User acknowledged |
| expires_at | TIMESTAMPTZ | Auto-expire old alerts |

---

### Conversations

#### 13. conversations
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| client_number / user_id | | |
| title | VARCHAR(255) | Auto-generated from first message |
| provider | VARCHAR(20) | Last AI provider used |
| is_archived | BOOLEAN | |

#### 14. messages
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| conversation_id | INT FK CASCADE | |
| role | VARCHAR(10) | 'user' or 'assistant' |
| content | TEXT | Markdown + HTML widgets |
| provider | VARCHAR(20) | AI provider (assistant only) |
| input_tokens / output_tokens | INT | Token counts |
| response_time_ms | INT | |

---

### Agent Framework (Phase 8–8.5)

#### 15. agents
Personal AI agents with persistent memory, scheduling, and circuit breaker.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| client_number | VARCHAR(20) | Tenant |
| user_id | INT | Owner |
| name | VARCHAR(100) | |
| instructions | TEXT | Agent prompt/goal |
| data_sources | TEXT[] | org / personal / uploads |
| schedule | VARCHAR(50) | cron expression or null (manual) |
| actions | TEXT[] | Allowed action types |
| notify_email / notify_whatsapp | BOOLEAN | Notification channels |
| is_active | BOOLEAN | |
| last_run_at / last_result / last_error | | Last execution info |
| next_run_at | TIMESTAMPTZ | Scheduled next run |
| memory_context | JSONB | Persistent memory (10KB cap) |
| run_count / error_count | INT | Stats; circuit opens at errorCount ≥ 3 |

**Limits:** Max 3 agents/user (Standard tier), 2 concurrent/user, 10 concurrent/tenant.

#### 16. agent_actions
Human-in-the-loop approval log for destructive agent actions.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| client_number / user_id | | |
| action_type | VARCHAR(50) | send_email, create_event, update_project |
| status | VARCHAR(20) | pending/approved/rejected/executing/done/failed |
| input / output | JSONB | Action parameters and result |
| requires_approval | BOOLEAN | Always true for send_email, create_event, update_project |
| approved_by / approved_at | | Approval audit |

#### 17. agent_templates
Pre-built agent templates available to all tenants from the marketplace.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| slug | VARCHAR(100) UNIQUE | e.g., `morning-brief` |
| name / description | VARCHAR | |
| instructions | TEXT | Default prompt |
| data_sources / actions | TEXT[] | Defaults |
| category | VARCHAR(50) | projects/productivity/sales/finance/strategy |
| is_published | BOOLEAN | |

**Pre-seeded:** Project Risk Monitor, Morning Brief, Opportunity Scout, Invoice Reminder, Competitive Intelligence

---

### WhatsApp (Phase 8.5)

#### 18. whatsapp_connections
| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| user_id | INT UNIQUE FK → users.id CASCADE | One connection per user |
| phone_number | VARCHAR(30) | |
| wa_id | VARCHAR(50) | Meta's WhatsApp user ID |
| status | VARCHAR(20) | active/disconnected |
| provider | VARCHAR(20) | 'meta' |
| connected_at / updated_at | TIMESTAMPTZ | |

**Daily limits:** 100/connection, 20/agent, 200/user.

#### 19. whatsapp_messages
Immutable audit log of all WhatsApp messages.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| user_id | INT | |
| direction | VARCHAR(10) | 'in' or 'out' |
| content | TEXT | Message body |
| message_id | VARCHAR(100) | Meta's message ID |
| status | VARCHAR(20) | sent/delivered/read/failed/received |
| agent_id | INT | Which agent sent it (nullable) |
| session_id | INT | Conversation session (nullable) |

#### 20. whatsapp_sessions
Multi-turn conversation context. Auto-closes after 24h inactivity.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| user_id | INT | |
| conversation_history | JSONB | Array of `{role, content, ts}` |
| agent_id | INT | Active agent (nullable) |
| last_message_at | TIMESTAMPTZ | Session timeout reference |
| closed_at | TIMESTAMPTZ | NULL = active |

---

### Platform & Marketplace (Phase 9)

#### 21. api_keys
External API access keys for the `/api/external/v1/` gateway.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| client_number / user_id | | |
| label | VARCHAR(100) | Display name |
| key_hash | VARCHAR(64) UNIQUE | SHA-256 of raw key — plaintext never stored |
| key_prefix | VARCHAR(20) | `tmcai_XXXXXX` — shown in UI for identification |
| rate_limit_rpm | INT | Default 100 req/min |
| scopes | JSONB | e.g., `["query","knowledge"]` |
| is_active | BOOLEAN | |
| last_used_at | TIMESTAMPTZ | |

#### 22. api_key_usage
Usage log for billing and analytics.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| key_id | INT | |
| client_number | VARCHAR(20) | |
| endpoint / status_code / latency_ms | | Per-request metrics |

#### 23. marketplace_connectors
Third-party connector registry. 70% revenue to creator, 30% to platform.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| slug | VARCHAR(100) UNIQUE | e.g., `sap-connector` |
| name / description / author | VARCHAR | |
| version | VARCHAR(20) | |
| npm_package | VARCHAR(200) | npm package name |
| category | VARCHAR(50) | connector/template/knowledge-pack |
| revenue_share | NUMERIC(4,2) | Platform cut (0.30 = 30%) |
| price_usd | NUMERIC(8,2) | 0.00 = free |
| is_published | BOOLEAN | |
| downloads | INT | Counter |

#### 24. marketplace_installations
Tracks which tenants have installed which connectors.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| client_number | VARCHAR(20) | Tenant |
| connector_id | INT FK → marketplace_connectors.id | |
| installed_by | INT | User who installed |
| config | JSONB | Connector-specific config |
| UNIQUE(client_number, connector_id) | | One install per tenant |

---

### Supporting Tables

#### 25. audit_log
PII-masked query log for compliance. Every chat request logged.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| client_number / user_id | | |
| masked_query | TEXT | PII removed |
| provider | VARCHAR(20) | AI provider used |
| chunks_retrieved / top_score | | Retrieval metrics |
| pii_entities_count | INT | How many entities masked |
| input_tokens / output_tokens | INT | |
| response_time_ms | INT | |
| intent_type | VARCHAR(30) | Classified intent |
| error | TEXT | Non-null if request failed |

#### 26. scheduled_tasks
Cron-based AI report generation with email delivery.

| Column | Type | Description |
|--------|------|-------------|
| id | SERIAL PK | |
| client_number / user_id | | |
| title / prompt | | Task definition |
| cron_expression | VARCHAR(50) | node-cron format |
| notify_email | VARCHAR(255) | Comma-separated recipients |
| notify_self | BOOLEAN | Also email task owner |
| last_run_at / last_result / last_error | | Execution history |
| next_run_at | TIMESTAMPTZ | |

#### 27. token_usage / token_query_log
Per-user token consumption tracking for billing and quota enforcement.

#### 28. user_profile_memory / user_learning
AI-extracted durable facts and learning preferences per user.

#### 29. feedback
User thumbs-up/thumbs-down on AI responses.

---

## Migration History

| Migration | Phase | What it does |
|-----------|-------|-------------|
| `20260328145354_no_roles_table` | 0 | Initial schema: users, sessions, conversations, messages, audit_log, chunks, documents |
| `20260329_add_invite_fields` | 0 | Invite token fields on users |
| `20260401_phase3_personal_data` | 3 | `personal_documents`, `personal_chunks`; `personal_drive_folder_id/last_sync` on users |
| `20260401_phase4_envelope_encryption` | 4 | `encrypted_dek` column on users |
| `20260401_phase5_org_intelligence` | 5 | `index_events`, `proactive_alerts`, `knowledge_items` |
| `20260401_phase6_domain_knowledge` | 6 | `domain_knowledge` |
| `20260401_phase8_agents` | 8 | `agent_actions` |
| `20260401_phase85_agents_whatsapp` | 8.5 | `agents`, `whatsapp_connections`, `whatsapp_messages`, `whatsapp_sessions` |
| `20260401_phase9_platform` | 9 | `api_keys`, `api_key_usage`, `marketplace_connectors`, `marketplace_installations`, `agent_templates` |

### Applying Migrations (development)

```bash
# Apply all manually (uses psql directly — migrations are raw SQL, not Prisma-managed)
export PGPASSWORD='your_password'
psql -U postgres -h 127.0.0.1 -d tmcai -f server/prisma/migrations/<dir>/migration.sql

# Or apply all at once:
cat server/prisma/migrations/20260401_phase*/migration.sql | psql -U postgres -h 127.0.0.1 -d tmcai
```

Each migration directory contains a `rollback.sql` for instant reversal.

---

## Security Notes

- **Tenant isolation:** Every query must include `client_number = $tenantId`
- **Personal data isolation:** Personal tables (`personal_documents`, `personal_chunks`) use `user_id` only — never `client_number`. Admin endpoints must never query these tables.
- **Encryption at rest:** `system_config` sensitive values + `personal_chunks.content` (Phase 4+) encrypted with per-user DEK
- **API keys:** Raw key never stored — only SHA-256 hash. Prefix shown in UI for identification only.
- **WhatsApp messages:** Immutable audit log; all outbound sanitized before send

---

## Prisma Schema

`server/prisma/schema.prisma`

Column naming: Prisma camelCase → PostgreSQL snake_case via `@map()` and `@@map()`.
