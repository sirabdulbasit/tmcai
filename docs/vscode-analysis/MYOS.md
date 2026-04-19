# MyOS — Personal Intelligence Operating System for TMCAI

**Version 3.1** · April 2026 · TallyMarks Consulting

Multi-tenant, per-user configurable AI chief-of-staff built into the TMCAI platform.

**Changelog:**
| Version | Date | Changes |
|---|---|---|
| v1.0 | 2026-04-11 | Initial plan — 4 phases (A-D), basic connector list, gap analysis |
| v2.0 | 2026-04-11 | Rebranded HaseebOS → MyOS. Multi-tenant per-user design. 3-tier connector model (personal/org/admin scope). Category-based connectors (vendor-agnostic). Tasks connector expanded. |
| v3.0 | 2026-04-11 | Restructured into 3 parts (Features/Config/Technical). 3-phase pipeline (Gather → Suggest → Decide). Added 5 missing features: ERP Monitoring, Risk Register, OKR, Team Briefers, Thought Pipeline. 15-feature transplant map. 28 verification tests. |
| v3.1 | 2026-04-11 | Closed final gap: Org-Wide Email Intelligence (Known system) with full service spec, 6 output types, privacy enforcement. Score: 93/100. 31 verification tests. |

---

# PART 1: FUNCTIONALITIES, FEATURES & PROCESSES

## The 3-Phase Pipeline

Every user's data flows through three stages:

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

## HaseebOS → MyOS Feature Transplant Map

Every feature from the source vision maps into MyOS. None require architecture changes — they fill existing service gaps or add small new services.

| # | Source Feature | MyOS Landing Zone | Work Type |
|---|---|---|---|
| 1 | **TMC Master Context** (Sec 4.1) | `brainConfigService.ts` → `BrainConfig.masterContext` | Enhance existing — user edits context, system refreshes from connectors every 6h |
| 2 | **Entity Knowledge Graph** (Sec 4.2) | `entityService.ts` + `entityResolverService.ts` | New service — already in plan |
| 3 | **Decisions Log** (Sec 4.3) | `decisionsLogService.ts` + `DecisionLog` model | New service — already in plan |
| 4 | **Rules Engine** (Sec 4 + 6) | `BrainConfig.delegationRules/escalationRules/privacyRules` | Config-driven — reads from BrainConfig instead of hardcoded rules |
| 5 | **Morning Briefing** (Sec 5) | `briefingService.ts` upgrade — 8 sections (A-H) | Enhance existing — add sections, make per-user configurable |
| 6 | **Decision & Delegation Engine** (Sec 6) | `delegationService.ts` + `actionSuggestionService.ts` | New service — already in plan |
| 7 | **Pattern Learning → Auto-Action** (Sec 7) | `patternAnalysisService.ts` + `autoActionService.ts` | New service — already in plan |
| 8 | **Delegation Follow-Up & Monitoring** (Sec 8) | `openItemsService.ts` — add monitoring rules + stale checks | Enhance existing — add 48h/72h/overdue checks as scheduler jobs |
| 9 | **Email Intelligence** (Sec 9) | `emailIntelligenceService.ts` — 7-stage pipeline | New service — already in plan |
| 10 | **ERP Financial Monitoring** (Sec 10) | `erpMonitoringService.ts` — reads from ERP connector | New service — see F4.1 |
| 11 | **Project Status & Risk Register** (Sec 11) | `riskRegisterService.ts` — reads from ERP/PM connectors | New service — see F4.2 |
| 12 | **OKR System** (Sec 12) | `okrService.ts` + `OKR` model | New service — see F4.3 |
| 13 | **Team Briefers** (Sec 5.1, step 7) | `teamBrieferService.ts` — outbound via org Chat connector | New service — see F4.4 |
| 14 | **Thought Pipeline** (Sec 5.2 Section H) | `thoughtPipelineService.ts` + `ThoughtEntry` model | Genuinely new, no equivalent — see F4.5 |
| 15 | **Org-Wide Email Intelligence / Known** (Sec 9.2) | `orgIntelligenceService.ts` — reads from Intelligence connector | New service — see F4.6 |

All 15 features are fully specified below.

---

## Phase 1 Features: GATHER & PRESENT

### F1.1 Unified Connector System
- Users connect their personal tools: email (Gmail/Outlook/Yahoo), calendar, tasks (Google Tasks/Todoist/Trello/ClickUp/etc.), WhatsApp, Slack, LinkedIn, personal Drive, Zoom, Notion, etc.
- Admins connect organizational tools: ERP (SAP/Odoo/Dynamics), CRM (Salesforce/HubSpot), company Drive, BigQuery, Google Sheets, HR systems, Jira/Asana, etc.
- Connectors are **category-based** — user picks ONE provider per category (e.g., Gmail OR Outlook for email)
- Admin controls which personal connectors users can see/access
- Data flows in automatically on schedule (configurable polling intervals)

### F1.2 Entity Knowledge Graph
- Every person, company, and project mentioned across ANY feed is identified as a unique entity
- "Ahmed Khan" in Gmail + "Ahmed" in WhatsApp + "A. Khan" in CRM = ONE entity
- AI-powered entity resolution runs automatically on every incoming data item
- Entities link to all related open items, decisions, and interactions
- Tracks: sentiment score, relationship strength, last interaction date
- Entity types: Contact, Account, Project, Opportunity, Risk, OKR

### F1.3 Open Items Database
- Single unified view of ALL tasks, follow-ups, delegations, alerts, and action items
- Items auto-created from connected feeds (email flagged → open item, overdue task → open item)
- Each item linked to an entity, a source connector, and has a priority/status lifecycle
- Status flow: Open → In Progress → Delegated → Blocked → Done (or Overdue)
- Priority: Critical / High / Medium / Low
- Dedicated page with kanban board + table view + filters
- Also accessible in chat: "show my open items"

### F1.4 Brain Configuration
- Each user defines their personal AI context: role, responsibilities, team, key relationships
- User sets delegation rules: who handles what type of item, via which channel
- User sets escalation rules: what items they must handle personally
- User sets privacy rules: what items should never be shared/delegated
- User configures feed preferences: which feeds to monitor, polling intervals
- User configures briefing: which sections, delivery time, format

### F1.5 Presentation Layer
- **Morning Briefing**: Structured daily summary delivered as a chat message at user's configured time
- **Dashboards**: AI-generated visual widgets (charts, tables, cards) from connected data
- **Open Items Page**: Kanban + table view with filters, search, entity linking
- **Entity View**: Click any entity to see all related items, interactions, history across feeds
- **Feed Digest**: Summarized view of what happened in the last 24h across all connected feeds

### F1.6 Data Ingestion Process
```
1. Connector fires on schedule (or webhook for real-time feeds)
2. Raw data normalized into standard feed item format
3. Entity resolver extracts person/company/project mentions
4. Entity matched against existing graph (or new entity created)
5. Open item created/updated if actionable
6. Data stored and indexed for search/retrieval
7. Presentation layer updated (briefing, dashboard, open items)
```

---

## Phase 2 Features: AI BRAIN SUGGESTS

### F2.1 Feed Intelligence (All Connectors)
AI analyzes every incoming item and classifies it:

**Email classification (7 stages):**
1. CRITICAL — From key contacts (CXO, legal, board) → surface immediately
2. ESCALATION — Reply chain >72h, frustration detected → draft apology + resolution
3. FINANCIAL — Invoice, payment, overdue keywords → route to finance person
4. APPROVAL — Requires user's sign-off → surface with approve/reject options
5. DELEGATION — Can be handled by team → suggest assignee + draft forwarding message
6. FYI — Informational, no action needed → log, mark read, don't surface
7. NOISE — Newsletters, automated notifications → auto-archive

**Other feed intelligence:**
- **WhatsApp/Chat:** Summarize threads, detect sentiment, flag awaiting-reply, suggest responses
- **Calendar:** Identify prep-needed meetings, flag conflicts, suggest RSVPs
- **Tasks:** Detect overdue, suggest priority changes, correlate with open items
- **ERP:** Flag financial anomalies (overdue AR, budget overruns), suggest actions
- **CRM:** Flag stale deals, suggest follow-ups, detect sentiment changes

### F2.2 Delegation Engine
- Reads user's delegation rules + escalation rules + privacy rules
- For each open item, suggests: **who** should handle it, **via what channel**, with **what draft message**
- Respects escalation rules (certain items always go to user personally)
- Respects privacy rules (certain items never in team briefers)
- Capacity awareness: if assignee is overloaded, suggest alternative
- All suggestions are **drafts only** — user must approve before execution

### F2.3 Conversational Briefing (enhanced)
- Each item now has a **suggested action** with full draft
- User responds inline: "approve", "delegate to X", "snooze until Monday", "override — I'll handle"
- Actions execute through user's OWN connected connectors

### F2.4 Action Execution
When user approves:
- **Reply** → Draft sent via user's email connector
- **Delegate** → Message sent via user's chat/email connector, open item updated
- **Schedule meeting** → Event created via user's calendar connector
- **Close/resolve** → Open item marked done, entity context updated
- **Snooze** → Item deferred, reappears at specified time

### F2.5 Suggestion Process
```
1. Open item exists (from Phase 1 ingestion)
2. Brain context loaded (user's master context + entity history + delegation rules)
3. AI generates ranked action suggestions with full drafts
4. Suggestions surfaced in briefing or on-demand
5. User reviews: approve / override / delegate / snooze / dismiss
6. Approved action executed via user's connectors
7. Open item status updated
```

---

## Phase 3 Features: DECISIONS & MEMORY

### F3.1 Decision Auto-Capture
- Every action the user takes is automatically logged: what AI suggested, what user decided, whether it matched
- Zero effort — happens silently on every approve/override/delegate/snooze
- Optional: user adds override reason ("wrong person", "not now", "I'll handle")
- Response time tracked (fast = confident/routine)

### F3.2 Pattern Analysis
- Weekly scheduled job analyzes last 30+ days of decisions
- Groups by: item type × entity category × action type × connector
- Calculates match rate (how often user accepted AI suggestion)
- Surfaces patterns: "You always delegate SAP queries to Mohsin (95% match, 40 decisions)"

### F3.3 Decision Memory
- Confirmed patterns improve future suggestions
- Override reasons prevent repeated bad suggestions
- Entity-specific rules auto-learned ("for Client X, always handle personally")
- Temporal patterns detected ("user snoozes afternoon items, acts on morning items")

### F3.4 Path to Auto-Action
```
Days 1-30     FULL HUMAN REVIEW
              Every suggestion reviewed. Decisions logged. AI learns silently.

Day 31+       PATTERN SURFACING
              "These patterns have been consistent — approve auto-action?"
              User reviews: pattern, match rate, count, examples.

Post-confirm  SUPERVISED AUTO-ACTION
              Confirmed patterns execute automatically.
              Visible in briefing as "auto-actioned" log. Revocable anytime.

Month 6+      FULL AUTO (opt-in only)
              High-confidence patterns run silently. Monthly audit.
```

### F3.5 Feedback Loop
- 30-day outcome tracking per decision (positive / negative / neutral)
- Outcomes refine pattern engine: bad outcomes demote patterns, good outcomes reinforce
- Continuous improvement cycle

---

## Cross-Phase Features (active across all 3 phases)

### F4.1 ERP Financial Monitoring
- Reads from ERP org connector (SAP/Odoo/Dynamics) every 6 hours (configurable)
- Data fetched: cash position, AR/AP aging, project budget vs actual, revenue vs plan, payroll status, open POs
- Threshold-based alerts auto-create open items:
  - Cash below runway threshold → CRITICAL
  - Invoice overdue >60 days → HIGH
  - Budget overrun >10% → HIGH
  - Revenue below 85% of plan → HIGH
  - Unapproved PO >72 hours → MEDIUM
- Surfaced in briefing Section F (ERP snapshot)
- Alert routing follows user's delegation rules (e.g., financial alerts → finance person)
- All thresholds configurable per user in `brainConfig.alertThresholds`

### F4.2 Project Status & Risk Register
- Reads from ERP + project management org connectors
- Monitors: RAG status per project, milestone adherence, resource utilization, budget variance, client sentiment
- Risk register read from ERP/PM connector every 6 hours, enriched with signals from email/chat intelligence
- Alert conditions:
  - Project turning Red → CRITICAL open item
  - Milestone at risk (<7 days to deadline) → HIGH
  - Budget variance >10% → HIGH
  - Client negative sentiment sustained >3 days → HIGH
  - Scope change detected in email → flag to user
  - Quality complaint detected → CRITICAL
- All risks linked to entity in knowledge graph, tracked until closed

### F4.3 OKR System
- Per-user/team OKR CRUD: objectives, key results, owners, periods, targets
- Progress tracking: manual entry + auto-fetch from ERP metrics if connected
- Status calculated: On Track (>85%) / At Risk (70-85%) / Behind (<70%) / Critical (<50%)
- Monitoring rules:
  - Key result below 50% with >25% period remaining → CRITICAL open item
  - Key result below 70% → HIGH, owner alerted
  - No OKR update in 14 days → stale warning
  - OKR consistently below target for 3+ weeks → strategic review prompt in thought pipeline
  - Period ends in <30 days → deadline warning
- OKR dashboard widget in chat + dedicated page
- OKRs linked to entities (projects, teams, accounts) enabling root cause correlation

### F4.4 Team Briefers (Org-Level Outbound)
- Admin configures team spaces/channels via org Chat connector (Google Chat Spaces/Slack/Teams)
- Daily at configurable time (default 8am), personalized briefing dispatched to each team space
- Content: relevant open items, delegation assignments, project status, today's priorities
- Each team member sees only what's relevant to them
- Never includes privacy-flagged items
- Requires Premium tier + org Chat connector configured

### F4.5 Thought Pipeline (Genuinely New Feature)
The most differentiating feature — no competing product has this.

**What it is:** A personal strategic reflection system that captures insights, generates prompts for deeper thinking, and builds institutional knowledge over time.

**How it works:**
- AI observes patterns across all feeds and decisions throughout the week
- Generates reflection prompts: "You've overridden delegation for Client X three times this week — is there a trust issue worth addressing?"
- Drafts thought entries based on observed patterns (user reviews and publishes)
- Weekly summary (Fridays): what happened, decisions made, patterns observed, open questions
- Strategic questions surfaced: "Three projects are competing for the same resource next month — how should we prioritize?"
- Long-form analysis notes from complex multi-feed correlations

**Surfaced in:**
- Briefing Section H (Thought Pipeline Prompts)
- Dedicated "My Thoughts" page — timeline of entries, drafts, published reflections
- On-demand: "What should I be thinking about?"

**Write-back:** Published entries sync to user's Notes connector (Notion/OneNote/Evernote) if connected

**What makes it unique:**
- Not a to-do list — it's a *thinking* list
- AI doesn't just remind you of tasks — it prompts you to *reflect* on patterns
- Builds institutional knowledge: past reflections are searchable context for future decisions
- Connects the dots across feeds that humans miss in daily noise

### F4.6 Org-Wide Email Intelligence (Known System)
The final remaining gap. HaseebOS calls this "Known" — a Vertex AI system that reads every email across the entire organization via domain-wide delegation and surfaces derived intelligence (never individual email content) to the user.

**How it works in MyOS (multi-tenant):**
- Admin connects an Intelligence org connector (Vertex AI, or a custom analysis pipeline)
- The connector reads aggregated/derived signals — NOT individual email bodies
- A dedicated `orgIntelligenceService.ts` processes the nightly digest and classifies outputs into 6 types

**Output types (each becomes an open item or briefing entry):**

| Output Type | What It Detects | How Surfaced | Priority |
|---|---|---|---|
| **Client risk** | Client expressing frustration, delay, or complaint in email to any org person | Open item: CRITICAL or HIGH. Briefing Section G. All open items for that entity re-prioritized. | Critical/High |
| **Opportunity** | Client or prospect mentioning new project, budget, expansion | Open item: MEDIUM. Briefing Section G. CRM record draft created if CRM connector active. | Medium |
| **Follow-up gap** | Any org person's email thread with client unanswered >48h | Open item: HIGH. Delegation follow-up item created. Responsible person identified via entity graph. | High |
| **Employee signal** | High stress, disengagement, conflict, compliance concern detected | **Private to user only** — NEVER in team briefers, NEVER delegated. 1:1 meeting suggestion drafted. | High (private) |
| **Client sentiment trend** | Rolling 7-day sentiment per client based on email tone | Entity `sentimentScore` updated in knowledge graph. Trend shown in briefing. Negative trend sustained >3 days → alert. | Medium |
| **Risk intelligence** | Legal, compliance, regulatory, financial risk mentioned in any org email | `RiskRegisterItem` created. Briefing Section G if High/Critical. Linked to entity. | Per severity |

**Processing pipeline:**
```
1. Intelligence connector delivers nightly digest (JSON array of signals)
2. orgIntelligenceService.ts parses each signal
3. Entity resolver links signal to existing entity (or creates new one)
4. Signal classified into one of 6 output types
5. Open item created with appropriate priority
6. Entity sentimentScore and lastInteraction updated
7. Employee signals flagged as privacy-protected (never shared)
8. Results surfaced in user's briefing Section G + open items view
```

**Privacy rules enforced:**
- Employee signals visible ONLY to users whose `brainConfig.escalationRules` include HR/people management scope
- Admin can restrict which users receive org intelligence outputs via feature flags
- Individual email content is NEVER surfaced — only derived intelligence (sentiment, risk category, opportunity signal)
- All outputs link to entity, not to specific email thread

**Configurable per user in Brain Config:**
- `feedSettings.org_intelligence.enabled` — on/off
- `feedSettings.org_intelligence.outputTypes` — which of the 6 types to receive (default: all)
- `feedSettings.org_intelligence.sentimentAlertDays` — days of negative sentiment before alert (uses `alertThresholds.sentimentAlertDays`)

---

# PART 2: CONFIGURABLE OBJECTS

## Platform-Level (TMCAI ships with these)

### Connector Registry
All supported connector types, pre-defined by the platform:

**Personal Connector Categories:**

| Category | Providers | What It Does |
|---|---|---|
| Email | Gmail, Outlook, Yahoo | Read/send emails |
| Calendar | Google Calendar, Outlook Calendar | View/create events |
| Tasks | Google Tasks, MS To Do, Todoist, TickTick, Any.do, Asana, Trello, ClickUp, Notion Tasks | Sync tasks ↔ open items |
| Messaging | WhatsApp, Telegram, Signal | Read/send messages |
| Chat | Google Chat, Slack, MS Teams | Read/send chat messages |
| Drive (Personal) | Google Drive, OneDrive, Dropbox | Read personal files |
| Social | LinkedIn, Facebook, Twitter/X, Instagram | Read/post social content |
| Meetings | Zoom, Google Meet, MS Teams Meetings | Schedule/view meetings |
| Notes | Notion, Evernote, OneNote | Read/create notes |

**Organizational Connector Categories:**

| Category | Providers | What It Does |
|---|---|---|
| Drive (Org) | Google Drive, OneDrive/SharePoint, Dropbox Business | Org document access |
| Data Warehouse | BigQuery, Snowflake | Query business data |
| Spreadsheets | Google Sheets, Excel Online | Read/write reports and logs |
| Chat (Org) | Google Chat Spaces, Slack Workspace, MS Teams Org | Team briefers, delegation messages |
| Project Mgmt | Notion, Jira, Asana, Monday.com, Linear | Issues, boards, backlogs |
| ERP | SAP, Odoo, Microsoft Dynamics 365 | Financials, projects, AR/AP, risks |
| CRM | Salesforce, HubSpot, Zoho CRM | Leads, deals, contacts, pipeline |
| HR / ESS | Custom HR, BambooHR, Workday | Appraisals, leave, payroll |
| Intelligence | Vertex AI, OpenAI Assistants | Org-wide risk/opportunity analysis |
| Social (Org) | LinkedIn Company, Facebook Page | Company page insights |
| Support | Zendesk, Freshdesk, Intercom | Support ticket monitoring |
| Dev / Ops | GitHub, GitLab | Repos, issues, PRs, deployments |
| Knowledge Base | Confluence, SharePoint | Org wiki/knowledge pages |
| Custom | Custom REST API, Inbound Webhook | Any external system |

### Feature Tier Gating
| Feature | Basic | Standard | Premium |
|---|---|---|---|
| Open Items + Entities | Yes | Yes | Yes |
| Personal Connectors | Up to 3 | Unlimited | Unlimited |
| Brain Config | Basic context only | Full rules + briefing | Full + automation |
| Feed Intelligence | — | Yes | Yes |
| Delegation Engine | — | Yes | Yes |
| Decisions Log | — | Yes | Yes |
| Thought Pipeline | — | Yes | Yes |
| Org Connectors | — | — | Yes |
| ERP Financial Monitoring | — | — | Yes |
| Project Status & Risk Register | — | — | Yes |
| OKR System | — | — | Yes |
| Auto-action | — | — | Yes |
| Team Briefers | — | — | Yes |
| Org-Wide Intelligence | — | — | Yes |

---

## Client Admin Configures (per tenant)

### Connector Scope Control
| Setting | Description |
|---|---|
| Enabled personal connectors | Toggle on/off which personal connectors users can access (e.g., allow Gmail + WhatsApp, block Facebook) |
| Org connector credentials | Provide endpoint URL + API key + auth for each org connector |
| Org connector sync schedule | Cron expression per org connector (e.g., "every 6 hours" for ERP) |
| Default delegation rules | Org-wide default delegation matrix (users can override) |
| Default brain context | Org-level context injected into all users' brains (company info, policies) |
| Feature flags | Enable/disable MyOS features per tenant: `ff_email_intelligence`, `ff_delegation_engine`, `ff_decisions_log`, `ff_auto_action` |
| Alert thresholds (org-wide) | Default overdue hours, budget variance %, follow-up timer |
| License tier per user | Assign Basic/Standard/Premium per user |

---

## User Configures (per user)

### My Connectors
| Setting | Description |
|---|---|
| Connected personal connectors | Connect/disconnect personal accounts (OAuth or API key). Only sees admin-enabled connectors. |
| Sync preferences | Polling interval per connector (e.g., Gmail every 5 min, Tasks every 15 min) |

### My Brain
| Setting | Description |
|---|---|
| Master context | Free-text: user's role, responsibilities, team members, key relationships, active projects |
| Delegation rules | Table of rules: item type → default assignee → channel → CC rules |
| Escalation rules | Conditions where user must handle personally (e.g., "CXO emails", "financial approvals >$X") |
| Privacy rules | Item types that should never be delegated or shown in team briefers |
| Feed settings | Per-connector: enable/disable classification, polling interval, priority keywords |

### My Briefing
| Setting | Description |
|---|---|
| Sections | Which briefing sections to include (summary, critical items, calendar, feed digest, delegation follow-up, ERP snapshot, intelligence, thought prompts) |
| Delivery time | Cron expression (e.g., "8:30 AM PKT weekdays") |
| Format | Detailed / summary / bullet-points |
| Channel | Chat message / email / both |

### My Automation
| Setting | Description |
|---|---|
| Automation level | `observe_only` → `drafts_only` (default) → `supervised` → `full_auto` |
| Confirmed patterns | Patterns user has reviewed and approved for auto-action |
| Revoked patterns | Previously-confirmed patterns user has disabled |
| Monthly audit schedule | When to surface auto-action audit report |

### My Alert Thresholds
| Setting | Description |
|---|---|
| Overdue hours | After how many hours a delegated item with no update becomes "stale" (default: 48h) |
| Follow-up timer | When to auto-create follow-up reminder (default: 72h) |
| Budget variance % | Threshold for ERP budget alerts (default: 10%) |
| AR overdue days | Threshold for accounts receivable alerts (default: 60 days) |
| Revenue alert % | Below what % of plan to flag revenue (default: 85%) |
| Cash runway days | Minimum days of cash runway before CRITICAL alert (default: 30) |
| OKR critical threshold | Below what % an OKR becomes critical (default: 50%) |
| OKR at-risk threshold | Below what % an OKR becomes at-risk (default: 70%) |
| Sentiment alert days | Days of sustained negative sentiment before alert (default: 3) |
| PO approval hours | Unapproved PO age before alert (default: 72h) |

### My OKRs
| Setting | Description |
|---|---|
| Objectives | Create/edit objectives with key results, targets, owners, period |
| Progress mode | Manual entry OR auto-fetch from ERP connector metrics |
| Review schedule | When to surface OKR review prompt (default: weekly Monday) |

### My Thought Pipeline
| Setting | Description |
|---|---|
| Enabled | On/off — whether AI generates reflection prompts |
| Frequency | How often thought prompts appear (daily / weekly / on-demand only) |
| Weekly review day | Which day the weekly summary generates (default: Friday) |
| Notes connector | Which connected Notes app to sync published thoughts to (Notion/OneNote/Evernote) |
| Focus areas | Topics user wants strategic prompts about (optional filter) |

### My Org Intelligence (Premium only, requires Intelligence org connector)
| Setting | Description |
|---|---|
| Enabled | On/off — whether org-wide intelligence signals are surfaced to this user |
| Output types | Which of the 6 signal types to receive: client_risk, opportunity, follow_up_gap, employee_signal, sentiment_trend, risk_intelligence (default: all) |
| Employee signals | On/off — whether to receive private employee signals (requires HR/management scope) |
| Sentiment alert days | Days of sustained negative client sentiment before alert (inherits from alert thresholds) |

### My Team Briefers (Premium only, requires org Chat connector)
| Setting | Description |
|---|---|
| Enabled | On/off — whether daily team briefers are dispatched |
| Delivery time | When to send (default: 8:00 AM user timezone) |
| Target spaces | Which org Chat spaces/channels to send to |
| Content scope | What to include: delegations, project status, priorities, alerts |

---

# PART 3: TECHNICAL ASPECTS

## Data Models (Prisma)

### ConnectorType (platform registry)
```prisma
model ConnectorType {
  id            String   @id @default(cuid())
  slug          String   @unique
  name          String
  description   String?
  category      String   // email | calendar | tasks | messaging | chat | drive | social | meetings | notes |
                         // data_warehouse | spreadsheets | project_mgmt | erp | crm | hr | intelligence |
                         // support | dev | kb | custom
  scope         String   // personal | organizational
  authMethod    String   // oauth2 | api_key | webhook | credentials | bot_token | service_account | none
  configSchema  Json     // JSON Schema for setup form fields
  capabilities  Json     @default("[]") // ["read", "write"]
  icon          String?
  isActive      Boolean  @default(true)
  createdAt     DateTime @default(now())
}
```

### TenantConnectorConfig (admin controls)
```prisma
model TenantConnectorConfig {
  id              String   @id @default(cuid())
  clientNumber    String
  connectorTypeId String
  scope           String   // personal | organizational
  isEnabled       Boolean  @default(false)
  config          Json?    // encrypted credentials for org connectors
  syncSchedule    String?  // cron expression
  lastSyncAt      DateTime?
  syncStatus      String?  // idle | syncing | error
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([clientNumber, connectorTypeId])
  @@index([clientNumber])
}
```

### UserConnector (user's personal connections)
```prisma
model UserConnector {
  id              String   @id @default(cuid())
  userId          String
  clientNumber    String
  connectorTypeId String
  config          Json?    // encrypted OAuth tokens, phone number, etc.
  status          String   @default("disconnected") // connected | disconnected | expired | error
  lastSyncAt      DateTime?
  syncStatus      String?  // idle | syncing | error
  errorMessage    String?
  metadata        Json?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@unique([userId, connectorTypeId])
  @@index([clientNumber, userId])
}
```

### OpenItem
```prisma
model OpenItem {
  id              String    @id @default(cuid())
  itemNumber      Int       @default(autoincrement())
  title           String
  description     String?
  entityId        String?
  type            String    // task | email | delegation | alert | erp | okr | risk
  status          String    @default("open") // open | in_progress | delegated | blocked | done | overdue
  priority        String    @default("medium") // critical | high | medium | low
  ownerId         String
  delegateeId     String?
  delegateeName   String?
  delegateeEmail  String?
  dueDate         DateTime?
  sourceFeed      String?
  sourceRef       String?
  connectorId     String?
  delegationTrail Json      @default("[]")
  notes           Json      @default("[]")
  metadata        Json?
  clientNumber    String
  userId          String
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt

  @@index([clientNumber, userId, status])
  @@index([clientNumber, userId, priority])
  @@index([clientNumber, entityId])
}
```

### Entity + EntityLink
```prisma
model Entity {
  id                   String    @id @default(cuid())
  entityType           String    // contact | account | project | opportunity | risk | okr
  name                 String
  email                String?
  phone                String?
  company              String?
  role                 String?
  metadata             Json?
  sentimentScore       Float?
  relationshipStrength Float?
  lastInteraction      DateTime?
  clientNumber         String
  createdBy            String?
  createdAt            DateTime  @default(now())
  updatedAt            DateTime  @updatedAt

  @@unique([clientNumber, entityType, email])
  @@index([clientNumber, entityType])
  @@index([clientNumber, name])
}

model EntityLink {
  id             String   @id @default(cuid())
  entityId       String
  linkedEntityId String
  linkType       String   // works_at | manages | owns | sponsors | reports_to
  clientNumber   String
  createdAt      DateTime @default(now())

  @@unique([entityId, linkedEntityId, linkType])
  @@index([clientNumber])
}
```

### BrainConfig
```prisma
model BrainConfig {
  id               String   @id @default(cuid())
  userId           String   @unique
  clientNumber     String
  masterContext     String?  @db.Text
  delegationRules  Json     @default("[]")
  escalationRules  Json     @default("[]")
  privacyRules     Json     @default("[]")
  feedSettings     Json     @default("{}")
  briefingConfig   Json     @default("{}")
  alertThresholds  Json     @default("{}")
  automationLevel  String   @default("drafts_only")
  isActive         Boolean  @default(true)
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@index([clientNumber])
}
```

### DecisionLog
```prisma
model DecisionLog {
  id              String   @id @default(cuid())
  userId          String
  clientNumber    String
  sessionType     String   // morning_briefing | intraday | auto_action
  itemType        String   // email | whatsapp | task | calendar | erp | okr | manual
  entityId        String?
  connectorSlug   String?
  suggestedAction String?
  userDecision    String   // approved | overrode | delegated | snoozed | dismissed
  actionTaken     String?
  isMatch         Boolean
  overrideReason  String?
  responseTimeMs  Int?
  outcome         String?  // positive | negative | neutral
  openItemId      String?
  createdAt       DateTime @default(now())

  @@index([userId, clientNumber])
  @@index([clientNumber, createdAt])
  @@index([userId, itemType, isMatch])
}
```

### ThoughtEntry (Thought Pipeline)
```prisma
model ThoughtEntry {
  id              String   @id @default(cuid())
  userId          String
  clientNumber    String
  type            String   // reflection_prompt | weekly_review | strategic_question | pattern_insight | user_note
  title           String
  content         String   @db.Text
  status          String   @default("draft") // draft | published | dismissed | archived
  triggerSource   String?  // what triggered this: pattern_analysis | feed_correlation | user_request | scheduled
  relatedEntities Json     @default("[]") // entity IDs this thought relates to
  relatedItems    Json     @default("[]") // open item IDs
  publishedTo     String?  // connector slug where it was synced (notion_personal, onenote, etc.)
  publishedAt     DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([userId, clientNumber, status])
  @@index([userId, type])
}
```

### OKR (Objectives & Key Results)
```prisma
model OKR {
  id              String   @id @default(cuid())
  userId          String
  clientNumber    String
  objective       String
  period          String   // Q1-2026 | H1-2026 | 2026
  periodStart     DateTime
  periodEnd       DateTime
  status          String   @default("on_track") // on_track | at_risk | behind | critical
  ownerId         String   // user who owns this OKR
  entityId        String?  // linked entity (project, team, account)
  keyResults      Json     @default("[]") // [{title, target, current, unit, weight}]
  progressPct     Float    @default(0)
  autoFetchMetric String?  // ERP metric ID for auto-progress (if connected)
  lastUpdated     DateTime @default(now())
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([clientNumber, userId])
  @@index([clientNumber, status])
  @@index([clientNumber, ownerId])
}
```

### RiskRegisterItem
```prisma
model RiskRegisterItem {
  id              String   @id @default(cuid())
  clientNumber    String
  description     String
  category        String   // financial | operational | compliance | technical | client | employee
  severity        String   // critical | high | medium | low
  status          String   @default("open") // open | mitigating | mitigated | closed
  mitigation      String?
  ownerId         String?
  entityId        String?  // linked entity (project, account, etc.)
  source          String   // erp | email | chat | known | manual
  sourceRef       String?  // reference to source record
  detectedAt      DateTime @default(now())
  resolvedAt      DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([clientNumber, status])
  @@index([clientNumber, severity])
  @@index([clientNumber, entityId])
}
```

---

## Files to Create

### Phase 1 — Gather & Present
| File | Purpose |
|---|---|
| `server/src/services/connectorService.ts` | Unified connector CRUD + credential mgmt + scope checking |
| `server/src/services/connectorRegistry.ts` | Static connector type definitions + seed data |
| `server/src/services/openItemsService.ts` | Open Items CRUD + lifecycle + delegation trail |
| `server/src/services/entityService.ts` | Entity CRUD + search + merge |
| `server/src/services/entityResolverService.ts` | LLM-powered entity extraction + fuzzy matching |
| `server/src/services/brainConfigService.ts` | Per-user brain configuration CRUD |
| `server/src/routes/connectorRoutes.ts` | User connector API endpoints |
| `server/src/routes/admin/connectorAdminRoutes.ts` | Admin connector config API |
| `server/src/routes/openItemsRoutes.ts` | Open Items API |
| `server/src/routes/entityRoutes.ts` | Entity API |
| `server/src/routes/brainConfigRoutes.ts` | Brain Config API |
| `client/src/pages/ConnectorsPage.jsx` | User "My Connectors" page |
| `client/src/pages/OpenItemsPage.jsx` | Kanban + table view |
| `client/src/pages/BrainConfigPage.jsx` | Brain setup wizard/editor |
| `client/src/components/admin/ConnectorsTab.jsx` | Admin connector management |
| `client/src/components/widgets/OpenItemsWidget.jsx` | Chat widget for open items |

### Phase 2 — AI Brain Suggests
| File | Purpose |
|---|---|
| `server/src/services/emailIntelligenceService.ts` | 7-stage email classification pipeline |
| `server/src/services/feedIntelligenceService.ts` | Generic feed analysis for all connector types |
| `server/src/services/delegationService.ts` | Delegation engine with per-user rules |
| `server/src/services/actionSuggestionService.ts` | AI generates ranked action suggestions |
| `server/src/services/actionExecutionService.ts` | Execute approved actions via user's connectors |
| `server/src/services/erpMonitoringService.ts` | ERP financial monitoring — threshold checks, alert creation |
| `server/src/services/riskRegisterService.ts` | Risk register monitoring — read from ERP/PM + enriched from feeds |
| `server/src/services/okrService.ts` | OKR CRUD + progress tracking + monitoring rules |
| `server/src/services/teamBrieferService.ts` | Dispatch personalized briefers to org Chat spaces |
| `server/src/services/openItemsMonitorService.ts` | 48h/72h stale checks, overdue detection, priority re-scoring |
| `server/src/services/orgIntelligenceService.ts` | Org-wide email intelligence — parse digest, classify 6 output types, privacy enforcement |
| `server/src/routes/okrRoutes.ts` | OKR API endpoints |
| `server/src/routes/riskRoutes.ts` | Risk register API endpoints |
| `client/src/pages/OkrPage.jsx` | OKR management + dashboard |
| `client/src/components/widgets/ErpSnapshotWidget.jsx` | ERP financial snapshot widget |
| `client/src/components/widgets/OkrWidget.jsx` | OKR progress widget |

### Phase 3 — Decisions & Memory
| File | Purpose |
|---|---|
| `server/src/services/decisionsLogService.ts` | Decision auto-capture + storage |
| `server/src/services/patternAnalysisService.ts` | Weekly pattern detection + match rates |
| `server/src/services/decisionMemoryService.ts` | Per-user decision memory management |
| `server/src/services/autoActionService.ts` | Execute confirmed patterns automatically |
| `server/src/services/outcomeTrackingService.ts` | 30-day outcome assessment |
| `server/src/services/thoughtPipelineService.ts` | Reflection prompts, weekly reviews, strategic questions |
| `server/src/routes/decisionsRoutes.ts` | Decisions log API + pattern review |
| `server/src/routes/thoughtRoutes.ts` | Thought pipeline API (drafts, publish, sync) |
| `client/src/pages/DecisionPatternsPage.jsx` | Pattern review + confirmation UI |
| `client/src/pages/ThoughtPipelinePage.jsx` | "My Thoughts" — timeline of reflections + drafts |
| `client/src/components/widgets/DecisionInsightsWidget.jsx` | Pattern insights in chat |
| `client/src/components/widgets/ThoughtPromptWidget.jsx` | Thought prompts in briefing |

## Files to Modify

| File | Phase | Change |
|---|---|---|
| `server/prisma/schema.prisma` | 1 | Add all new models |
| `server/src/routes/index.ts` | 1 | Register new route files |
| `server/src/services/gmailService.ts` | 1 | Read tokens from UserConnector |
| `server/src/services/calendarService.ts` | 1 | Read tokens from UserConnector |
| `server/src/services/whatsappService.ts` | 1 | Read tokens from UserConnector |
| `server/src/services/integrationService.ts` | 1 | Bridge to new connector model |
| `client/src/pages/SettingsPage.jsx` | 1 | Link to My Connectors + My Brain |
| `client/src/pages/AdminPage.jsx` | 1 | Add Connectors tab |
| `client/src/components/IconRail.jsx` | 1 | Add Open Items + Brain nav items |
| `server/src/services/briefingService.ts` | 2 | Major upgrade for per-user conversational briefing |
| `server/src/controllers/chat/conversationalHandler.ts` | 2 | Add briefing interaction + inline actions |
| `server/src/controllers/chat/widgetHandler.ts` | 2 | Add open_items widget type |
| `server/src/services/schedulerService.ts` | 2,3 | Register feed polling + pattern analysis jobs |
| `client/src/pages/OpenItemsPage.jsx` | 2 | Add AI suggestion indicators |
| `client/src/pages/BrainConfigPage.jsx` | 3 | Add automation level + pattern management |

## Migration Strategy (existing integrations)
- Current `integration_tokens` on User → migrate to `UserConnector` rows
- Current `whatsapp_connections` → migrate to `UserConnector` rows
- Current BigQuery/Drive config from env vars → migrate to `TenantConnectorConfig` rows
- Existing services continue working but read credentials from `connectorService.getCredentials(userId, slug)`

## Architecture Decisions
1. **Unified Connector Model** — All integrations through `ConnectorType → TenantConnectorConfig → UserConnector`. Existing services become adapters.
2. **PostgreSQL as source of truth** — Not Notion. Notion can be an org connector for syncing.
3. **Per-User Brain Config** — Not hardcoded. Admin sets defaults; users customize.
4. **Admin-Controlled Scope** — Users never see connectors admin hasn't enabled.
5. **Gradual Automation** — `drafts_only` → `supervised` → `full_auto`. Per-user control. Default is drafts_only.
6. **Multi-Provider LLM** — Gemini Flash for classification/extraction (fast+cheap), Claude/Pro for complex reasoning.

## Verification / Testing Plan

### Phase 1 (Gather & Present)
1. Admin enables Gmail + WhatsApp, disables LinkedIn. User sees only Gmail + WhatsApp.
2. Existing Gmail/Calendar tokens migrate to UserConnector. Still works.
3. Admin configures BigQuery. All tenant users benefit from org data.
4. Two tenants, different scopes. No cross-leakage.
5. Gmail connected → emails pulled on schedule → entities extracted → open items created.
6. "Ahmed Khan" in Gmail + WhatsApp → single entity.
7. Briefing shows data from all connected feeds. Widgets render.
8. Open Items kanban + table shows items from all sources.

### Phase 2 (AI Brain Suggests)
9. 7 test emails (one per stage) → correct classification.
10. Each open item gets ranked AI suggestion with draft.
11. Delegation engine consults user's rules, suggests correct assignee + channel.
12. Briefing sections populated, suggestions actionable.
13. Approve in chat → email sent / event created / item delegated.
14. Actions execute through user's OWN connectors only.
15. ERP connector syncs → cash position + AR/AP shown in briefing. Overdue invoice >60 days creates open item.
16. Risk register read from ERP → new Critical risk appears in briefing + open item created.
17. OKR below 70% → HIGH alert open item created, owner notified.
18. Open item delegated >48h ago with no update → flagged in briefing with chase draft.
19. Team briefer dispatched to configured Chat spaces at 8am with relevant items per space.

### Phase 3 (Decisions & Memory)
20. 10 decisions in chat → all logged with match/override status.
21. After 30+ decisions → weekly job detects patterns with match rates.
22. Decision memory improves next suggestion round.
23. Confirm pattern → next match auto-executes, visible in briefing log.
24. 30 days later → outcomes assessed.
25. Thought Pipeline: Friday weekly review generated, reflection prompt surfaced for repeated pattern.
26. Thought entry published → synced to user's connected Notion/OneNote.
27. OKR consistently below target 3 weeks → strategic review thought prompt generated.

28. Org Intelligence digest arrives → client_risk signal parsed → entity matched → open item CRITICAL → briefing Section G shows it → all items for that entity re-prioritized.
29. Employee signal detected → surfaced ONLY to users with HR scope → never in team briefers → 1:1 meeting suggestion drafted.
30. Follow-up gap: org person's client email unanswered >48h → delegation follow-up item created → responsible person identified.

### End-to-End
31. Email arrives → classified → open item → entity linked → briefing → AI suggests → user approves → executed via connector → decision logged → pattern detected → thought prompt generated → next similar item suggested better.
