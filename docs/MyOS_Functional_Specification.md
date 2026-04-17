# MyOS — Functional Specification

**Version:** 4.0
**Date:** 2026-04-13
**Platform:** TMCAI (TallyMarks Consulting AI Intelligence)

---

## 1. Product Vision

MyOS (My Operating System) is a **Personal Intelligence Operating System** that turns TMCAI into a configurable AI chief-of-staff for every user. Each user connects their own data sources, configures their AI brain, and receives personalized briefings and action suggestions — all within the existing chat interface.

### 1.1 Core Principle
> Every user gets their own AI assistant that knows their role, their tools, their team, and their priorities — without any two users seeing the same thing.

### 1.2 Three-Phase Pipeline

```
PHASE 1: GATHER & PRESENT          PHASE 2: AI BRAIN SUGGESTS          PHASE 3: DECISIONS & MEMORY
─────────────────────────           ─────────────────────────           ─────────────────────────
Connect all data sources            AI analyzes gathered data            Log every user decision
Ingest from all feeds               Proactively suggests actions         Build decision patterns
Resolve entities                    Draft emails, delegations            Learn user preferences
Present via briefings,              Classify & prioritize items          Auto-action promotion
dashboards, open items              User reviews & approves              Supervised → full auto

Data flows IN → User SEES           AI THINKS → User DECIDES             System LEARNS → Gets smarter
```

---

## 2. User Roles & Permissions

### 2.1 Three-Tier Connector Model

| Level | Who | What They Do |
|---|---|---|
| **Platform** | System | Defines all available connector types (32 types across 20 categories) |
| **Admin** | Client Admin | Enables which personal connectors users can access + configures org connectors with credentials |
| **User** | Individual | Connects their own personal accounts (only sees admin-enabled connectors) |

### 2.2 Feature Tier Gating

| Feature | Basic | Standard | Premium |
|---|---|---|---|
| Open Items + Entities | Yes | Yes | Yes |
| Personal Connectors | Up to 3 | Unlimited | Unlimited |
| Brain Config | Basic context | Full rules + briefing | Full + automation |
| Feed Intelligence | — | Yes | Yes |
| Delegation Engine | — | Yes | Yes |
| Decisions Log | — | Yes | Yes |
| Thought Pipeline | — | Yes | Yes |
| Org Connectors | — | — | Yes |
| ERP / OKR | — | — | Yes |
| Auto-action | — | — | Yes |
| Team Briefers | — | — | Yes |
| Org Intelligence | — | — | Yes |

---

## 3. Feature Specifications

### 3.1 My Connectors (Phase 1 — Built)

**What it does:** Users connect their personal tools (email, calendar, tasks, messaging, cloud drive, social media) and admins connect organizational tools (ERP, CRM, data warehouse).

**User flow:**
1. User navigates to **My Connectors** page via left nav
2. Sees all admin-enabled connectors grouped by category (Email, Calendar, Tasks, Messaging, Chat, Drive, Social, Meetings, Notes)
3. Each connector shows status: disconnected (gray), configured (yellow), connected (green), error (red)
4. Clicks **Configure** → modal opens:
   - **OAuth connectors** (Gmail, Calendar, etc.): If sibling connector already connected → "Credentials will be reused, just click Connect". Otherwise → enter Client ID + Secret + copy Redirect URI
   - **API key connectors** (Todoist, Trello, etc.): 2-step flow: Enter credentials → Save & Continue → Connect (tests API)
   - **Webhook connectors** (WhatsApp): Enter phone number + API credentials → Save & Continue → Connect (tests Meta API)
5. Clicks **"? Guide"** → opens step-by-step setup guide in new tab (printable as PDF)
6. Clicks **Test** on connected connector → makes live API call, shows result or error
7. **Disconnect** keeps all config data — easy to reconnect

**Connector categories (32 types):**

| Scope | Categories |
|---|---|
| Personal (19) | Email (Gmail, Outlook), Calendar (Google, Outlook), Tasks (Google Tasks, MS To Do, Todoist, Trello, ClickUp, Notion Tasks), Messaging (WhatsApp, Telegram), Chat (Google Chat, Slack, MS Teams), Drive (Google Drive, OneDrive), Social (LinkedIn, Twitter/X), Meetings (Zoom), Notes (Notion) |
| Organizational (13) | Drive (Google Drive Org, OneDrive Org), Data Warehouse (BigQuery), Spreadsheets (Google Sheets), Chat (Google Chat Spaces, Slack Workspace, MS Teams Org), Project Mgmt (Notion Org, Jira, Asana), ERP (SAP, Odoo, Dynamics 365), CRM (Salesforce, HubSpot), HR (Custom ESS, BambooHR), Intelligence (Vertex AI), Support (Zendesk), Dev (GitHub), Custom (REST API, Webhook) |

**Google OAuth behavior:**
- First Google connector: User enters Client ID + Secret → redirected to Google with ALL scopes (email + calendar + tasks + drive)
- Subsequent Google connectors: Auto-reuses credentials → one click connect
- One Google consent covers Gmail, Calendar, Tasks, and Drive simultaneously

---

### 3.2 Open Items (Phase 1 — Built)

**What it does:** Single unified view of ALL tasks, follow-ups, delegations, alerts, and action items across all connected sources.

**User flow:**
1. Navigate to **Open Items** page via left nav
2. See stats cards: Total Open, Critical, High, Delegated, Done
3. Filter by status tabs: All, Open, In Progress, Delegated, Blocked, Done, Overdue
4. Each item shows: type icon, title, priority badge, status badge, source, due date, delegatee
5. Click item → detail modal with full description, delegation trail, notes
6. Quick actions: Mark Done, Start Working, Delegate, Add Note
7. Create new items manually via "+ New Item" button
8. Items also created automatically from connected feeds (future)

**Item lifecycle:**
```
Open → In Progress → Done
  │        │
  ├→ Delegated → (48h no update) → Overdue
  │        │
  └→ Blocked → (resolved) → Open
```

**Item types:** task, email, delegation, alert, erp, okr, risk
**Priority levels:** critical (red), high (yellow), medium (blue), low (gray)

---

### 3.3 My Brain (Phase 1 — Built)

**What it does:** Each user configures their personal AI behavior — who they are, how the AI should route items, when to alert, and what to include in briefings.

**Tabs:**

#### My Context
Free-text editor where user describes their role, responsibilities, team members, key relationships, and active projects. Injected into every LLM call as context.

Example:
```
I am the Managing Director of TMC. My team:
- Salman (Finance) — handles invoices and payments
- Mohsin (SAP Pre-sales) — technical queries
- Saba (BD) — business development
I personally handle: CXO emails, financial approvals, HR matters
```

#### Briefing Config
Checkboxes to select which sections appear in Day Brief:
- Summary (open items count, meeting count, email count)
- Critical Items (must-act-today items)
- Calendar (today's meetings)
- Feed Digest (email summary)
- Delegation Follow-up (stale items)
- ERP Snapshot (financial data)
- Intelligence Feed (org signals)
- Thought Prompts (reflection prompts)

Plus: delivery time, format (detailed/summary/bullets), channel (chat/email/both)

#### Alert Thresholds
Numeric configuration with defaults:

| Threshold | Default | What It Triggers |
|---|---|---|
| Overdue Hours | 48h | Delegated item with no update flagged as stale |
| Follow-up Timer | 72h | Auto-create follow-up reminder |
| Budget Variance % | 10% | ERP budget overrun alert |
| AR Overdue Days | 60 | Accounts receivable alert |
| Revenue Alert % | 85% | Below-plan revenue alert |
| Cash Runway Days | 30 | Critical cash position alert |
| OKR Critical % | 50% | OKR below this = critical |
| OKR At-Risk % | 70% | OKR below this = at risk |
| Sentiment Alert Days | 3 | Sustained negative sentiment alert |
| PO Approval Hours | 72h | Unapproved PO age alert |

#### Automation Level
Radio selection controlling AI autonomy:
- **Observe Only** — just log decisions, no suggestions
- **Drafts Only** (default) — suggest actions but never auto-execute
- **Supervised** — confirmed patterns auto-execute, visible in briefing
- **Full Auto** — high-confidence patterns run silently with monthly audit

---

### 3.4 Day Brief (Phase 2 — Built)

**What it does:** Aggregates data from ALL connected sources into a structured daily briefing delivered as a chat message.

**Trigger:** Click "Day Brief" chip on welcome screen, or type "day brief" / "daily briefing" / "morning brief" in chat.

**How it works:**
1. Reads user's Brain Config for selected sections
2. Runs all sections in parallel (fast — no sequential waits)
3. Returns structured markdown (no LLM call — pure data aggregation)
4. Sections adapt based on what's connected:
   - Gmail connected → email digest section populated
   - Calendar connected → today's events shown
   - No ERP → ERP section shows "not connected" message
   - No open items → "All clear!" message

**Example output:**
```markdown
# Good morning, Basit! Here's your Day Brief

## Summary
**Open Items:** 5 total (1 critical, 2 high, 0 overdue, 1 delegated)
**Meetings Today:** 3
**Emails Today:** 12

## Critical Items
🔴 **Review Q1 financial report** (due: Apr 15) → delegated to Salman
🟡 **Client escalation: PGC project** — scope contradiction

## Today's Calendar (3 events)
**9:00 AM** — Team standup (5 attendees)
**11:00 AM** — Client call: Shan Foods (3 attendees)
**2:00 PM** — Board prep meeting (2 attendees)

## Email Digest (12 today)
**8 unread**
📩 **Ahmed Khan** — Re: Q1 deliverables update
📩 **Sarah Johnson** — Contract review needed
📩 **Salman Sohail** — Invoice approved
✉️ **HR Team** — Monthly attendance report
✉️ **System** — SAP backup notification

## Delegation Follow-up
All delegations are on track. No stale items.
```

---

### 3.5 LLM Context Awareness (Phase 1 — Built)

**What it does:** Every chat message includes a snapshot of the user's complete setup so the LLM knows what data it can access.

**Injected into system prompt:**
```
── USER SETUP & CAPABILITIES ──
Connected data sources:
  ✓ Gmail (email)
  ✓ Google Calendar (calendar)
  ✓ Google Tasks (tasks)
You CAN:
  • Read and send emails
  • View and create calendar events
  • Read and manage tasks
  • Query organizational business data (projects, sales, HR, strategy)
Open items: 5 total (1 critical, 2 high, 1 delegated, 0 overdue)
Brain: user has configured their master context
Active agents: Faria (every 5 minutes)
Scheduled reports: Daily Briefing
── END USER SETUP ──
```

**Caching:** Per-user, 30-second TTL. Auto-cleanup inactive users after 10 minutes. No explicit invalidation needed — changes appear within 30 seconds automatically.

---

### 3.6 Entity Knowledge Graph (Phase 1 — Built, Backend Only)

**What it does:** Every person, company, and project mentioned across any feed is identified as a unique entity with cross-feed deduplication.

**Entity types:** Contact, Account, Project, Opportunity, Risk, OKR

**Entity resolution (entityResolverService):**
1. Fast path: direct email match
2. LLM extraction (Gemini Flash): extract person/company/project from text
3. Fuzzy name match against existing entities
4. Auto-create new entity if no match

**Entity linking:** Relationships between entities (works_at, manages, owns, sponsors, reports_to)

---

### 3.7 Connector Setup Guides (Phase 1 — Built)

**What it does:** Each connector has a detailed step-by-step guide explaining where to get credentials and what to enter.

**Features:**
- Opens in new tab, clean white printable layout
- Print / Save as PDF button
- Dynamic redirect URI (fetched from backend — correct for dev and production)
- Step-by-step with exact URLs, click paths, and field mapping
- Quick reference table: "Field in TMC AI" → "Where to get it"
- 20+ connector-specific guides (Gmail, Outlook, Todoist, Trello, Jira, Zendesk, Telegram, WhatsApp, SAP, Odoo, Notion, HubSpot, GitHub, Slack, LinkedIn, Twitter, Zoom, ClickUp, etc.)

---

## 4. Features Planned (Not Yet Built)

### 4.1 Phase 2 — AI Brain Suggests

| Feature | Description | Status |
|---|---|---|
| Email Intelligence Pipeline | 7-stage classification (Critical → Noise) per user's rules | Planned |
| Feed Intelligence | Classify/summarize all connector feeds | Planned |
| Delegation Engine | Route items per user's delegation rules | Planned |
| Action Suggestions | AI generates ranked action drafts per item | Planned |
| Inline Action Execution | Approve actions in chat → execute via connectors | Planned |
| ERP Financial Monitoring | Threshold alerts from SAP/Odoo | Planned |
| Project Status & Risk Register | RAG monitoring, milestone tracking | Planned |
| OKR System | CRUD + progress + monitoring rules | Planned |
| Team Briefers | Daily briefings to org Chat spaces | Planned |
| Org Intelligence (Known) | Org-wide email intelligence via Vertex AI | Planned |

### 4.2 Phase 3 — Decisions & Memory

| Feature | Description | Status |
|---|---|---|
| Decision Auto-Capture | Log every approve/override/delegate/snooze | Planned |
| Pattern Analysis Engine | Weekly job: identify consistent decision patterns | Planned |
| Decision Memory | Confirmed patterns improve future suggestions | Planned |
| Auto-Action Promotion | Gradual: drafts → supervised → full auto | Planned |
| Outcome Tracking | 30-day assessment: positive/negative/neutral | Planned |
| Thought Pipeline | Reflection prompts, weekly reviews, strategic questions | Planned |

---

## 5. User Configurable Settings

### 5.1 Admin Configures (per tenant)

| Setting | Description |
|---|---|
| Enabled personal connectors | Toggle on/off which connectors users can access |
| Org connector credentials | Endpoint URL + API key + auth for org connectors |
| Org sync schedule | Cron expression per org connector |
| Default delegation rules | Org-wide defaults (users can override) |
| Feature flags | Enable/disable MyOS features per tenant |
| License tier per user | Basic / Standard / Premium |

### 5.2 User Configures (per user)

| Setting | Where | Description |
|---|---|---|
| Personal connectors | My Connectors | Connect/disconnect, configure credentials |
| Master context | My Brain → Context | Free-text role/team description |
| Delegation rules | My Brain → (future tab) | Who handles what type, via which channel |
| Escalation rules | My Brain → (future tab) | What items to handle personally |
| Briefing sections | My Brain → Briefing | Which sections in Day Brief |
| Alert thresholds | My Brain → Thresholds | Numeric trigger values |
| Automation level | My Brain → Automation | AI autonomy level |

---

## 6. Non-Functional Requirements

| Requirement | Target |
|---|---|
| Day Brief generation | < 5 seconds (all sections parallel) |
| Connector test | < 3 seconds per test |
| User context snapshot | < 50ms (cached), < 300ms (cold) |
| Credential encryption | AES-256-GCM, encrypted at rest |
| Multi-tenant isolation | clientNumber on all tables, query-scoped |
| Cache TTL | 30 seconds (auto-reflects changes) |
| Inactive user cleanup | 10 minutes (memory freed) |
| OAuth token refresh | Automatic on expiry |
| Build time (server) | < 60s TypeScript compilation |
| Build time (client) | < 6s Vite production build |
