# MyOS — Technical Specification

**Version:** 4.0
**Date:** 2026-04-13
**Platform:** TMCAI (TallyMarks Consulting AI Intelligence)
**Status:** Phase 1 complete, Phase 2 complete (Sprint 1+2+3), Brain Engine v2 live

---

## 1. Architecture Overview

MyOS is a Personal Intelligence Operating System built as a layer on top of the TMCAI platform. It adds per-user configurable AI chief-of-staff capabilities to the existing multi-tenant enterprise intelligence system.

### 1.1 Tech Stack

| Layer | Technology |
|---|---|
| Backend | Express 5, TypeScript, Node.js |
| Database | PostgreSQL 18 + Prisma 6 ORM |
| Frontend | React 19, Vite 7 |
| AI Providers | Gemini 2.5 Pro/Flash, Claude, GPT-4o, Groq, OpenRouter |
| Auth | Password-based (bcrypt, HttpOnly cookies, 72h sessions) |
| Encryption | AES-256-GCM for connector credentials |
| Scheduling | node-cron with timezone support (Asia/Karachi) |
| OAuth | Google OAuth2, Microsoft OAuth2 (extensible) |

### 1.2 System Architecture

```
┌─────────────────────────────────────────────────┐
│  CLIENT (React 19 + Vite)                        │
│  ├── ConnectorsPage     — manage connections      │
│  ├── OpenItemsPage      — kanban + table view     │
│  ├── BrainConfigPage    — AI configuration        │
│  ├── ConnectorGuidePage — setup guides             │
│  └── IconRail           — navigation              │
├─────────────────────────────────────────────────┤
│  API LAYER (Express 5)                            │
│  ├── /api/v1/connectors/*     — user connectors   │
│  ├── /api/v1/admin/connectors/* — admin config     │
│  ├── /api/v1/open-items/*     — open items CRUD    │
│  ├── /api/v1/entities/*       — entity graph       │
│  ├── /api/v1/brain/*          — brain config       │
│  └── /api/v1/connectors/oauth/* — OAuth flows      │
├─────────────────────────────────────────────────┤
│  SERVICE LAYER (TypeScript)                       │
│  ├── connectorService.ts      — CRUD, test, OAuth  │
│  ├── connectorRegistry.ts     — 32 connector types │
│  ├── openItemsService.ts      — items lifecycle    │
│  ├── entityService.ts         — knowledge graph    │
│  ├── entityResolverService.ts — LLM extraction     │
│  ├── brainConfigService.ts    — per-user config    │
│  ├── dayBriefingService.ts    — daily aggregation  │
│  └── userContextService.ts    — LLM context inject │
├─────────────────────────────────────────────────┤
│  DATABASE (PostgreSQL 18 + Prisma 6)              │
│  11 new MyOS tables + 38 existing TMCAI tables     │
└─────────────────────────────────────────────────┘
```

---

## 2. Database Schema

### 2.1 New MyOS Tables (11)

#### ConnectorType (connector_types)
Platform-level registry of all supported connector types. Seeded on deploy.

| Column | Type | Description |
|---|---|---|
| id | String (cuid) | Primary key |
| slug | String (unique) | Unique identifier (e.g., "gmail", "todoist") |
| name | String | Display name |
| description | String | Description text |
| category | String | email, calendar, tasks, messaging, chat, drive, social, meetings, notes, data_warehouse, spreadsheets, project_mgmt, erp, crm, hr, intelligence, support, dev, kb, custom |
| scope | String | "personal" or "organizational" |
| authMethod | String | oauth2, api_key, webhook, credentials, bot_token, service_account, none |
| configSchema | JSON | JSON Schema for setup form fields |
| capabilities | JSON | ["read", "write"] |
| icon | String | Icon identifier |
| isActive | Boolean | Platform-level kill switch |

#### TenantConnectorConfig (tenant_connector_configs)
Admin-level configuration: which personal connectors users can access + org connector credentials.

| Column | Type | Description |
|---|---|---|
| id | String (cuid) | Primary key |
| clientNumber | String | Tenant FK |
| connectorTypeId | String | FK → ConnectorType |
| scope | String | "personal" or "organizational" |
| isEnabled | Boolean | For personal: can users use this? |
| config | JSON | For org: encrypted credentials/endpoints |
| syncSchedule | String | Cron expression for org connectors |
| lastSyncAt | DateTime | Last sync timestamp |
| syncStatus | String | idle, syncing, error |
| syncError | String | Last error message |

Unique constraint: (clientNumber, connectorTypeId)

#### UserConnector (user_connectors)
User's personal connector instances with encrypted credentials.

| Column | Type | Description |
|---|---|---|
| id | String (cuid) | Primary key |
| userId | Int | FK → User |
| clientNumber | String | Tenant FK |
| connectorTypeId | String | FK → ConnectorType |
| config | JSON | Encrypted OAuth tokens, API keys, etc. |
| status | String | connected, disconnected, configured, error |
| lastSyncAt | DateTime | Last successful sync |
| syncStatus | String | idle, syncing, error |
| errorMessage | String | Last error message |
| metadata | JSON | Connector-specific state |

Unique constraint: (userId, connectorTypeId)

#### OpenItem (open_items)
Unified task/delegation/follow-up/alert database.

| Column | Type | Description |
|---|---|---|
| id | String (cuid) | Primary key |
| itemNumber | Int (auto) | Human-readable ITEM-001 |
| title | String | Item title |
| description | String | Detailed description |
| entityId | String | FK → Entity |
| type | String | task, email, delegation, alert, erp, okr, risk |
| status | String | open, in_progress, delegated, blocked, done, overdue |
| priority | String | critical, high, medium, low |
| ownerId | Int | FK → User (owner) |
| delegateeId | Int | FK → User (internal delegatee) |
| delegateeName | String | External delegatee name |
| delegateeEmail | String | External delegatee email |
| dueDate | DateTime | Deadline |
| sourceFeed | String | gmail, whatsapp, chat, erp, okr, manual |
| sourceRef | String | Source system reference |
| connectorId | String | FK → UserConnector |
| delegationTrail | JSON | Append-only delegation history |
| notes | JSON | Append-only notes array |
| metadata | JSON | Flexible per-type data |

Indexes: (clientNumber, userId, status), (clientNumber, userId, priority), (clientNumber, entityId)

#### Entity (entities)
Knowledge graph nodes — every person, company, project.

| Column | Type | Description |
|---|---|---|
| id | String (cuid) | Primary key |
| entityType | String | contact, account, project, opportunity, risk, okr |
| name | String | Entity name |
| email | String | Email address |
| phone | String | Phone number |
| company | String | Company name |
| role | String | Job role |
| metadata | JSON | Flexible fields |
| sentimentScore | Float | Sentiment (-1 to 1) |
| relationshipStrength | Float | Relationship score |
| lastInteraction | DateTime | Last interaction date |

Unique constraint: (clientNumber, entityType, email)

#### EntityLink (entity_links)
Knowledge graph edges — relationships between entities.

| Column | Type | Description |
|---|---|---|
| entityId | String | FK → Entity |
| linkedEntityId | String | FK → Entity |
| linkType | String | works_at, manages, owns, sponsors, reports_to |

#### BrainConfig (brain_configs)
Per-user AI behavior configuration.

| Column | Type | Description |
|---|---|---|
| userId | Int (unique) | FK → User |
| masterContext | Text | User's role, team, responsibilities |
| delegationRules | JSON | [{itemType, route, assignee, channel, ccRules}] |
| escalationRules | JSON | [{condition, action, priority}] |
| privacyRules | JSON | [{itemType, rule}] |
| feedSettings | JSON | Per-connector polling/classification config |
| briefingConfig | JSON | {sections[], deliveryTime, format, channel} |
| alertThresholds | JSON | {overdueHours, budgetVariancePct, arOverdueDays, ...} |
| automationLevel | String | observe_only, drafts_only, supervised, full_auto |

#### DecisionLog (decision_logs)
Auto-captured decisions for pattern learning.

| Column | Type | Description |
|---|---|---|
| userId | Int | FK → User |
| sessionType | String | morning_briefing, intraday, auto_action |
| itemType | String | email, whatsapp, task, calendar, erp, okr, manual |
| entityId | String | FK → Entity |
| connectorSlug | String | Source connector |
| suggestedAction | String | What AI recommended |
| userDecision | String | approved, overrode, delegated, snoozed, dismissed |
| actionTaken | String | What was actually done |
| isMatch | Boolean | User accepted AI suggestion |
| overrideReason | String | Why user chose differently |
| responseTimeMs | Int | Decision speed |
| outcome | String | positive, negative, neutral (assessed 30 days later) |
| openItemId | String | FK → OpenItem |

#### ThoughtEntry (thought_entries)
Strategic reflection and thought pipeline.

| Column | Type | Description |
|---|---|---|
| userId | Int | FK → User |
| type | String | reflection_prompt, weekly_review, strategic_question, pattern_insight, user_note |
| title | String | Thought title |
| content | Text | Full content |
| status | String | draft, published, dismissed, archived |
| triggerSource | String | pattern_analysis, feed_correlation, user_request, scheduled |
| relatedEntities | JSON | Entity IDs |
| relatedItems | JSON | Open item IDs |
| publishedTo | String | Connector slug (notion_personal, onenote) |

#### OKR (okrs)
Objectives & Key Results tracking.

| Column | Type | Description |
|---|---|---|
| userId | Int | FK → User |
| objective | String | Objective description |
| period | String | Q1-2026, H1-2026, 2026 |
| periodStart | DateTime | Period start date |
| periodEnd | DateTime | Period end date |
| status | String | on_track, at_risk, behind, critical |
| ownerId | Int | FK → User (OKR owner) |
| entityId | String | FK → Entity |
| keyResults | JSON | [{title, target, current, unit, weight}] |
| progressPct | Float | Overall progress percentage |
| autoFetchMetric | String | ERP metric ID for auto-progress |

#### RiskRegisterItem (risk_register_items)
Risk tracking and monitoring.

| Column | Type | Description |
|---|---|---|
| description | String | Risk description |
| category | String | financial, operational, compliance, technical, client, employee |
| severity | String | critical, high, medium, low |
| status | String | open, mitigating, mitigated, closed |
| mitigation | String | Mitigation plan |
| ownerId | Int | FK → User |
| entityId | String | FK → Entity |
| source | String | erp, email, chat, known, manual |

---

## 3. API Endpoints

### 3.1 Connector Routes (/api/v1/connectors)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | /available | User | List admin-enabled personal connectors for this user |
| GET | /my | User | List user's active connections |
| POST | /connect | User | Save config + test + connect (2-step) |
| POST | /disconnect | User | Disconnect (keeps config data) |
| POST | /test | User | Test a connected connector (live API call) |
| POST | /oauth/url | User | Get OAuth redirect URL |
| GET | /oauth/callback | Public | Handle OAuth return, save tokens |
| GET | /oauth/redirect-uri | Public | Return the server's OAuth redirect URI |
| GET | /types | User | List all connector types |

### 3.2 Admin Connector Routes (/api/v1/admin/connectors)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | / | Admin | List all connector configs for tenant |
| POST | /personal/toggle | Admin | Enable/disable personal connector for users |
| POST | /org/configure | Admin | Configure org connector credentials |
| DELETE | /org/:connectorTypeId | Admin | Remove org connector |
| GET | /personal/enabled | Admin | List enabled personal connectors |
| GET | /org/configured | Admin | List configured org connectors |

### 3.3 Open Items Routes (/api/v1/open-items)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | / | User | List open items with filters |
| GET | /stats | User | Get item counts by status/priority |
| GET | /:id | User | Get single item detail |
| POST | / | User | Create new item |
| PATCH | /:id | User | Update item fields |
| POST | /:id/status | User | Change status with optional note |
| POST | /:id/delegate | User | Delegate to person with trail logging |
| POST | /:id/note | User | Add note to item |

### 3.4 Entity Routes (/api/v1/entities)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | / | User | List entities with search/filter |
| GET | /:id | User | Get entity with links |
| POST | / | User | Create entity |
| PATCH | /:id | User | Update entity |
| POST | /link | User | Link two entities |

### 3.5 Brain Config Routes (/api/v1/brain)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | / | User | Get brain config (creates defaults if none) |
| PATCH | / | User | Update brain config (partial merge) |
| GET | /delegation-rules | User | Get delegation rules |
| GET | /escalation-rules | User | Get escalation rules |
| GET | /alert-thresholds | User | Get alert thresholds with defaults |
| GET | /briefing | User | Get briefing config |
| GET | /context | User | Get master context text |

---

## 4. Service Details

### 4.1 connectorService.ts
Core connector CRUD with:
- **Scope checking**: Users only see admin-enabled connectors
- **Credential encryption**: AES-256-GCM for sensitive config fields (apiKey, accessToken, refreshToken, password, secret, token, botToken, webhookSecret)
- **testAndConnect()**: Always saves config first, then tests. Config persists even on error.
- **testConnectedConnector()**: Live API verification per connector type (Gmail profile, Calendar events, Tasks lists, Todoist projects, Trello members, Telegram getMe, WhatsApp Graph API, etc.)
- **getOAuthUrl()**: Generates OAuth redirect URL. For Google: requests ALL scopes at once (gmail + calendar + tasks + drive). Falls back through: user-provided credentials → saved UserConnector credentials → sibling Google connector credentials → env vars.
- **handleOAuthCallback()**: Saves tokens to UserConnector. For Google: marks ALL enabled Google connectors as connected with same token. Also updates legacy User table for backward compatibility.
- **Disconnect preserves config**: Only changes status, never deletes credentials.

### 4.2 connectorRegistry.ts
Static registry of 32 connector types (19 personal + 13 organizational). Seeded on deploy via `seedConnectorTypes()`.

Categories: email (2), calendar (2), tasks (5), messaging (2), chat (3), drive (2), social (2), meetings (1), notes (1), erp (3), crm (2), data_warehouse (1), spreadsheets (1), project_mgmt (3), hr (2), intelligence (1), support (1), dev (1), kb (1), custom (2).

### 4.3 dayBriefingService.ts
Aggregates data from ALL connected sources based on user's Brain Config sections:
- **Summary**: Open items stats + calendar count + email count
- **Critical Items**: High/critical priority open items with details
- **Calendar**: Today's events from Google Calendar API
- **Email Digest**: Today's emails from Gmail API (count, unread, top 5)
- **Delegation Follow-up**: Stale delegated items based on alertThresholds.overdueHours
- **ERP Snapshot**: Placeholder for ERP connector data
- **Thought Prompts**: Draft thought entries

All sections built in parallel. Bypasses LLM — pure data aggregation. Triggered by pattern match: "day brief", "daily brief", "morning brief".

### 4.4 userContextService.ts
Builds per-user setup snapshot injected into every LLM system prompt:
- Connected connectors with capabilities (read/write)
- Open items stats (total, critical, high, delegated, overdue)
- Brain config status (has context, has delegation rules)
- Active agents with schedules
- Active scheduled reports

Cached per-user with 30-second TTL. Auto-cleanup of inactive users after 10 minutes. No explicit invalidation needed.

### 4.5 entityResolverService.ts
LLM-powered entity extraction and matching:
1. Fast path: direct email match against existing entities
2. LLM extraction: Gemini Flash extracts person/company/project mentions
3. Fuzzy name match against entity graph
4. Auto-create new entities for unknown mentions

### 4.6 integrationService.ts (Modified)
Updated `getAuthenticatedClient()` to check UserConnector table first:
1. Find ANY connected Google connector for the user (gmail, calendar, tasks, chat, drive)
2. Decrypt stored OAuth tokens (accessToken, refreshToken, clientId, clientSecret)
3. Auto-refresh expired tokens
4. Fall back to legacy User table integration fields

---

## 5. Frontend Architecture

### 5.1 New Pages

| Page | Route | Description |
|---|---|---|
| ConnectorsPage | /connectors | Manage personal connectors. Grouped by category. Configure modal with 2-step flow (credentials → test & connect). OAuth connectors show "Authorize" flow. Test button verifies live API. Guide links. |
| OpenItemsPage | /open-items | Kanban-style view with status filters. Stats cards (total, critical, high, delegated, done). Create modal. Item detail modal with delegation trail. Quick status change buttons. |
| BrainConfigPage | /brain | Tabbed interface: Context, Briefing, Alert Thresholds, Automation Level. Each tab saves independently. Briefing section checkboxes. Threshold numeric inputs with defaults. |
| ConnectorGuidePage | /connector-guide?slug=X | Step-by-step setup guides per connector. Dynamic redirect URI from backend. Print/Save as PDF. Guides for 20+ connectors. |

### 5.2 Navigation (IconRail)
Three new buttons added to bottom section:
- Open Items (checkmark in box)
- My Brain (lightbulb)
- My Connectors (hub)

### 5.3 Welcome Screen
- "Day Brief" chip replaces "Schedule Events" and "Today's Emails"
- Triggers day briefing aggregation from all connected sources

### 5.4 Chat Enhancements
- User context block injected into every LLM system prompt (connected connectors, open items stats, agents, schedules)
- Day briefing shortcut bypasses LLM for instant structured response
- Follow-up pills extraction stricter — only real suggestions, not data descriptions

---

## 6. Security

### 6.1 Credential Encryption
All sensitive connector config fields encrypted with AES-256-GCM before storage. Fields: apiKey, apiToken, password, secret, token, refreshToken, accessToken, botToken, webhookSecret.

### 6.2 Multi-Tenant Isolation
All MyOS tables include clientNumber column. Queries always scoped by clientNumber. Users cannot access other tenants' connectors, items, or entities.

### 6.3 Connector Scope Control
Admin explicitly enables which personal connectors users can see. Users never see unenabled connectors. Org connector credentials visible only to admins.

### 6.4 OAuth Security
- Tokens stored encrypted in UserConnector.config
- OAuth state includes userId + connectorTypeId (JSON, validated on callback)
- User-provided clientId/clientSecret stored alongside tokens for refresh
- Legacy User table updated for backward compatibility

### 6.5 Disconnect Preserves Data
Disconnect only changes status — credentials remain for easy reconnect. No accidental data loss.

---

## 7. Deployment

### 7.1 Environment Variables (new)

| Variable | Description | Required |
|---|---|---|
| GOOGLE_CONNECTOR_REDIRECT_URI | OAuth callback URL for connectors | Yes (production) |
| GOOGLE_CLIENT_ID | Google OAuth Client ID (org-level) | Optional |
| GOOGLE_CLIENT_SECRET | Google OAuth Client Secret (org-level) | Optional |
| MICROSOFT_CLIENT_ID | Microsoft OAuth Client ID | Optional |
| MICROSOFT_CLIENT_SECRET | Microsoft OAuth Client Secret | Optional |

### 7.2 Database Migration
Run `npx prisma db push` to create new tables. Existing data preserved. Connector types seeded via `seedConnectorTypes()` on first deploy.

### 7.3 Seed Data
Run `node server/seed-connectors.js` to populate connector_types table with 32 connector definitions.
