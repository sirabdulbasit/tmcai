# Nexeo — Complete Specification

**Last updated:** 2026-06-19
**Tenant:** TallyMarks Consulting (TMC-0001)
**Maintainer:** Basit Ahmed
**Internal canonical refs:** `server/docs/brain_architecture.md`, `tmcai/docs/myos_architecture.md`

---

## 1. What Nexeo Is

Nexeo is an **AI-powered executive assistant** that runs alongside you across email, calendar, WhatsApp, chat, drives, and other workplace tools. It is multi-tenant, multi-user, and explicitly designed so the AI ("Brain") never speaks or acts in your identity without your consent.

**Three things Brain does:**
1. **Triages incoming work** — reads your inbox, WhatsApp, calendar, chat. Surfaces what genuinely needs you.
2. **Acts on your behalf with consent** — drafts replies, schedules meetings, delegates, follows up. Every action is auditable.
3. **Learns continuously** — remembers patterns, preferences, contacts, and decisions across sessions.

**What it is NOT:**
- A chatbot. It runs continuously, not just when you ask.
- A standalone tool. It plugs into your existing accounts.
- A replacement for the user. It defers decisions on uncertainty.

---

## 2. Architecture — Six Layers

The system is organized into six layers (canonical model from `tmcai/docs/myos_architecture.md`):

```
┌──────────────────────────────────────────────────────────────┐
│  L6 — Interaction Surfaces (Day Brief, Brain Chat, WhatsApp) │
├──────────────────────────────────────────────────────────────┤
│  L5 — Reasoning + Composition (LLM, tools, prompts)          │
├──────────────────────────────────────────────────────────────┤
│  L4 — Triage + Open Items + Knowledge Base                   │
├──────────────────────────────────────────────────────────────┤
│  L3 — Feed Ingestion + Adapters (Gmail, WA, IMAP, Calendar)  │
├──────────────────────────────────────────────────────────────┤
│  L2 — Connectors + Auth (OAuth, IMAP/SMTP creds, webhooks)   │
├──────────────────────────────────────────────────────────────┤
│  L1 — Storage (Postgres, Redis, encrypted credentials)       │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. User-Facing Surfaces

Brain exposes three surfaces — all serving the same composer for parity.

### 3.1 Day Brief
Scheduled morning summary delivered via WhatsApp at the user's configured time (default 08:30 PKT).
- Composes from: calendar, open items, last 24h Gmail, last 24h WhatsApp
- Sender: tenant WhatsApp notifier (Nexeo)
- Cadence: once per local day, with 1h failure throttle
- Dispatch job: `server/src/jobs/dayBriefDispatchJob.ts`

### 3.2 Open Items
Living list of in-flight work for the user.
- Sources: explicit Brain creation, delegation from email/WA, follow-up workflows
- Status flow: NEW → IN_PROGRESS → DELEGATED → DONE → ARCHIVED
- Auto-follow-up: hourly worker pings delegatees past their threshold (3d/7d/14d)

### 3.3 Brain Chat (Web + WhatsApp)
Conversational interface, identical reasoning path on both.
- Web: `tai.tmcltd.com` → BrainChatPanel
- WhatsApp: tenant Nexeo number
- Shared composer: `reasoningComposeWithTools` (since f8ff5a1)
- Parity rule: "same question → same answer" regardless of channel

---

## 4. Inbound Pipeline

Brain ingests work from many sources through a unified pipeline.

### 4.1 Email
| Provider | Mechanism | Status |
|---|---|---|
| **Gmail** | OAuth + polling every 30s | Fully wired |
| **Microsoft 365** | OAuth + Graph polling | Fully wired |
| **IMAP/SMTP** (Zoho, ProtonMail, cPanel, custom) | Password auth + IMAP poll | Fully wired (since d16ff20) |

For non-Gmail/non-Microsoft users: `imap_smtp` connector — credentials (host/port/user/password) encrypted via `encryptConnectorConfig` chokepoint. `ImapSmtpFeedAdapter` polls inbox every ~30s on the same loop as Gmail/Outlook.

### 4.2 WhatsApp (Inbound)
Two layers:
- **User's personal WA pair** (`whatsapp_personal` connector via QR scan, `UserWebjsProvider`): incoming messages from all the user's contacts land in My Attention as `feed_events` for triage.
- **Brain's tenant number** (Nexeo number — Meta Cloud API once migrated, currently webjs QR fallback): users message Nexeo directly to talk to Brain.

**Inbound policy:** unregistered senders are dropped without DB write or reply (feedback_unregistered_wa_drop_silently). Only PM2 log line preserves the attempt.

**Per-user gender drives Urdu grammar:** Brain refers to female users with "آپ آئیں" / "she", male users with "آپ آئے" / "he", unspecified with "آپ ہیں" / "they". Default: female.

### 4.3 Calendar
Polling every 2 min for Google Calendar, equivalent for Outlook Calendar. Meeting invites become triage events; conflicts surface in Day Brief.

### 4.4 Other
- **Drive (Google + OneDrive)** — file index for context
- **Slack / Google Chat / MS Teams** — message ingest
- **Notion** — wiki sync
- **CRM** — contacts + accounts
- **Custom** — generic webhook (HMAC-signed) for any other integration

---

## 5. Outbound — Brain Reaches the User

Brain proactively contacts the user via `brainContactsUser` primitive. The same primitive is used for:
- Day Brief delivery
- Criticality alerts (red bundle)
- Watchpoint fires
- Emergency pings
- Open-item follow-ups

**Channels (per urgency):**
| Urgency | Channels tried |
|---|---|
| `low` / `normal` | text |
| `high` | text + voice note |
| `emergency` | voice note + Meta Business Call (falls back to tap-to-call CTA if not enrolled) |

**Suppression gates (in order):**
1. Smoke isolation (test traffic blocked unless `SMOKE_LIVE=true`)
2. User suspended (`is_active=false`) — refuses with `reason='user_suspended'`
3. Per-kind rate limit (60s between same-kind messages)
4. Quiet hours (configurable; bypass for explicit-time messages like Day Brief)
5. Daily cap per user

**Channel routing:** Meta Cloud API preferred when `tenant_whatsapp_notifier.isActive=true` AND token valid; otherwise falls back to legacy webjs (QR pair).

---

## 6. Voice & Language

### 6.1 Speech-to-Text (Inbound)
Voice notes arriving via WhatsApp are transcribed automatically:
- Provider: Google Cloud Speech / Gemini transcription
- Languages auto-detected: English, Urdu, Hindi, mixed
- Brain reasons over the transcript identically to text messages

### 6.2 Text-to-Speech (Outbound)
When urgency=high or user prefers voice:
- Provider: Google Cloud Text-to-Speech
- Voices: `en-US-Neural2-F` (English, female), `ur-IN-Standard-A` (Urdu, female)
- Gender: default female (per Basit's preference). All voice variants female.

### 6.3 Language Mirroring
Brain mirrors the user's most recent message language:
- English text → English reply
- Urdu script → Urdu reply
- Roman-Urdu (latin chars with Urdu words like `aap`, `kya`, `hain`) → Roman-Urdu reply

---

## 7. Multi-Tenancy & User Model

### 7.1 Tenants
- Each customer is a `Tenant` row with `client_number` (e.g. `TMC-0001`)
- All user-scoped tables enforce `client_number` filter via Prisma tenant-scope middleware
- SuperAdmin can switch tenants via `?cn=` query param

### 7.2 User Types
- **SA** — SuperAdmin (cross-tenant, platform-level)
- **AD** — Admin (manages users + connectors in one tenant)
- **ST** — Standard user
- **BS** — Business user
- **Custom tiers** — defined per tenant

### 7.3 User Lifecycle
- **Create** — via Admin → Users → + New User (optional invite email)
- **Suspend** — `is_active=false`. Login blocked, all Brain outbound refused, but data preserved. Reversible.
- **Reactivate** — flip back, clears failed attempts + locks
- **Delete** — hard delete with typed-phrase confirmation. Cascade FKs remove: conversations, sessions, scheduled_tasks, user_connectors, feed_events, memories, etc. Audit log SET NULL preserved for compliance.
- **Demo with expiry** — `expires_at` column set on creation; hourly cron flips `is_active=false` at expiry. Reversible — admin can extend or reactivate.

### 7.4 Per-User Settings (Profile)
- City, contact number, gender, preferred title
- Background / Standing orders (free-text, fed into Brain prompt)
- Custom Brain name (user can name Brain anything)
- Quiet hours, Day Brief time, timezone (default Asia/Karachi)
- Outbound opt-in toggle

---

## 8. Connectors

Per-tenant eligibility: admin selects which connectors users in this tenant can see on their `/connectors` page. Disabled connectors are hidden entirely.

**Categories:**
- Email (Gmail, Outlook, IMAP+SMTP)
- Calendar (Google Calendar, Outlook Calendar)
- Tasks (Google Tasks, Todoist, Trello, Jira)
- Messaging (WhatsApp personal, Slack, Telegram, Google Chat)
- Drive (Google Drive, OneDrive)
- Notes (Notion)
- CRM (HubSpot)
- Support (Zendesk)
- ERP (SAP, Odoo)

**Auth methods:**
- OAuth2 (Google, Microsoft, Notion)
- API key (Todoist, Trello, HubSpot, Jira)
- Credentials (IMAP+SMTP, SAP)
- Bot token (Telegram, Slack)
- Webhook (custom HMAC)
- QR pair (WhatsApp personal)

**Default user filter:** `/connectors` page opens to "Connected only". Admin can show "All" to see the catalogue.

---

## 9. Admin Features

### 9.1 Admin Panel (`/?tab=admin`)
Tabs: Client Management, Licenses, User Tiers, Application Configuration, **WhatsApp**, **Connectors**, LLM Spend.

### 9.2 WhatsApp Admin
- Pair number via QR (webjs fallback) OR configure Meta Cloud API
- Reset Pairing button — destroys session + clears DB + shows fresh QR (no SSH needed)
- Recent Messages with per-row Delete + Clear All (typed-phrase confirmation)
- Verify Brain ↔ User Channel panel — 6 test cards (text/voice/call × EN/Urdu)
- Send/receive audit + Brain → User audit log

### 9.3 Connectors Admin
- Per-tenant eligibility grid (toggle each connector on/off for the tenant)
- Categorized view with enabled/disabled/all filter + search
- Backend already enforced — UI is the management surface

### 9.4 Users Admin
- Per-row: Edit, Invite, Reset password, Suspend, Reactivate, Delete
- Demo user creation with expiry date picker (date OR days-from-now)
- Status badges: Active / Suspended / ⌛ Demo: N days left

---

## 10. Security & Data Integrity Rules

These are non-negotiable principles enforced in code:

1. **Zero tolerance on cross-user data leakage** — every entity_person writer must use the actual feeder's `user_id`, never `pickTenantScope`.
2. **Contacts private by default** — auto-discovered contacts are `scope='user'` on creation. "Public" promotion is owner-only opt-in.
3. **Brain never speaks as the user** — no message sent from the user's identity without explicit user-initiated chain.
4. **No hardcoded Brain replies** — every Brain-surface response is LLM-generated or a bracketed system marker. Hardcoded English sentences pretending to be Brain are forbidden.
5. **No Brain fabrication** — Brain never invents message content, senders, timestamps, contact origins. Cites only from relevant `dataBlocks`.
6. **Connector status is truth** — health is the `status` field only; metadata fields are historical breadcrumbs.
7. **Surface data parity** — Day Brief / Brain Chat / WhatsApp Nexeo return the same answer for the same question.
8. **Unregistered WA inbound dropped silently** — no DB write, no reply, no feed_event. PM2 log only.
9. **WhatsApp calls one-way** — Brain → user only. Inbound calls auto-rejected.
10. **Channel tone separation** — WhatsApp tone samples never pool into email drafts or vice versa.

---

## 11. Tech Stack

| Layer | Tech |
|---|---|
| Backend | Node.js + TypeScript, Express, Prisma |
| Database | PostgreSQL 17 |
| Cache / queues | Redis |
| LLM | Gemini 2.5 Flash (default), Gemini 2.5 Pro (heavy), Claude (highest-trust) |
| TTS / STT | Google Cloud Text-to-Speech + Speech-to-Text |
| Embeddings | Google Generative AI embeddings |
| Frontend | React (Vite), modern functional components |
| Auth | Session tokens (sha256 hash stored), bcrypt passwords |
| Process manager | PM2 |
| Reverse proxy | Apache 2.4 |
| Email | nodemailer (SMTP), imapflow (IMAP), Google + Microsoft APIs |
| WhatsApp | Meta Cloud API (primary), whatsapp-web.js (fallback) |

---

## 12. Deployment

### 12.1 Hosts
- **Local dev:** Mac (`/Users/tmc_ai_node_02/TMCAI/tmcai/`)
- **Production:** Ubuntu host `deepmarks` at IP `160.187.160.9` (`/var/www/tmcai/`)
- **Public URL:** `https://tai.tmcltd.com`

### 12.2 Repo
- `github.com/sirabdulbasit/tmcai`
- Main branch: `main`
- Active work branch: `feat/myos-whatsapp-brain-channel`

### 12.3 Deploy Flow
- Push from local
- On prod: `git pull && npx prisma migrate deploy && npm run build && pm2 restart tmcai-server`
- Client rebuild: `cd client && npm run build`
- Source parity rule: server code is identical local + prod; only `.env` differs. Never edit code on production.

### 12.4 Background Jobs (Cron / Interval)
| Job | Cadence | Purpose |
|---|---|---|
| Gmail / Outlook / IMAP poller | ~30s | New email ingest |
| Calendar poller | 2 min | Meeting changes |
| Gmail read-state sync | 2 min | Brain knows what user has read |
| WhatsApp freshness heartbeat | 2 min | Stamp lastSyncAt |
| Google Chat poller | 5 min | New chat ingest |
| Connector health sweep | 5 min | Detect token expiry / disconnects |
| Notion mirror | 10 min | Push wiki → Notion |
| Day Brief dispatch | 1 min tick | Fire per-user at configured time |
| Demo expiry sweep | 1 hr | Auto-suspend expired demo users |
| Open-item follow-up | 1 hr | Ping silent delegatees |
| Reflection agent | 6 hr | Aggregate decisions + delegations |
| Wiki linter | 1 hr | Classify wiki pages |
| Rule miner | 15 min | Extract patterns from logs |

---

## 13. Current Migration Status (2026-06-19)

**Active:** Meta WhatsApp Cloud API migration in progress.
- ✅ Webhook verified (token-only check decoupled from provider field)
- ✅ Inbound subscriptions: `messages`, `calls`, `account_alerts`, `message_template_status_update`
- ✅ Permanent Meta token saved (encrypted in tenant_whatsapp_notifier)
- ⏳ Re-test all 6 verify channels via Meta
- ⏳ Flip `provider='meta'` in whatsapp_config
- ⏳ Disconnect legacy webjs QR pair

**Once cutover complete:** WhatsApp becomes Meta-only; QR pair retired. Eliminates the recurring @lid alias issues from whatsapp-web.js.

---

## 14. Where Things Live

| What | Where |
|---|---|
| Brain composer | `server/src/services/knowledge/brainComposer.ts` |
| Brain persona | `server/src/services/knowledge/brainPersonaService.ts` |
| Day Brief | `server/src/jobs/dayBriefDispatchJob.ts` |
| WA inbound (tenant Brain) | `server/src/services/whatsapp/WhatsAppInbound.ts` |
| WA inbound (user personal) | `server/src/services/whatsapp/UserWebjsProvider.ts` |
| WA tenant outbound | `server/src/services/notifications/tenantWhatsappSender.ts` |
| Meta webhook | `server/src/routes/webhookRoutes.ts` |
| Brain outbound primitive | `server/src/services/notifications/brainOutboundService.ts` |
| Connector service | `server/src/services/connectorService.ts` |
| IMAP/SMTP service | `server/src/services/imapSmtpService.ts` |
| Voice (TTS/STT) | `server/src/services/voiceService.ts` |
| Feed ingestion | `server/src/services/feed/feedIngestionService.ts` |
| Feed adapters | `server/src/services/adapters/impl/*` |
| Admin routes | `server/src/routes/admin/*` |
| Settings UI | `client/src/pages/SettingsPage.jsx` |
| Admin UI | `client/src/pages/AdminPage.jsx` + `client/src/pages/admin/*` |
| Connectors UI | `client/src/pages/ConnectorsPage.jsx` |

---

## 15. References (Internal Canonical)

- `server/docs/brain_architecture.md` — Brain's reasoning + tool-use canon (seedOpsManual + /how-it-works derive from this)
- `tmcai/docs/myos_architecture.md` — 6-layer architecture canonical
- `server/docs/security_isolation_model.md` — multi-tenant isolation specifics

---

*This document is a living spec. Update it when adding new surfaces, connectors, or architectural rules.*
