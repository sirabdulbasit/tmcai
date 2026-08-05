# Nexeo — AI Self-Learning & Controlled Self-Development Implementation Prompt

## Purpose

This document is an implementation-ready prompt/specification for adding **AI Self-Learning** and **Controlled AI Self-Development** capabilities into **Nexeo**, the AI-powered executive assistant / Brain platform.

Nexeo already operates across email, calendar, WhatsApp, chat, drives, connectors, Day Brief, Open Items, and Brain Chat. The next evolution is to make Nexeo a **self-learning, self-improving, human-governed executive operating system**.

The goal is:

> Nexeo continuously learns from user work patterns, decisions, delegations, communication style, contacts, connectors, open items, daily briefs, and task outcomes. It detects gaps, improves workflows, recommends automations, generates product improvement proposals, prepares technical designs, creates development requests, and optionally asks a coding agent to create branches and pull requests — while never speaking or acting as the user without consent.

---

# 1. Product Vision

Build Nexeo as a **Self-Learning Executive Brain** that continuously improves both:

1. The user's personal executive operating system.
2. The Nexeo product itself.

Nexeo should learn how each user works and then improve:

- email triage
- calendar intelligence
- WhatsApp communication
- open-item tracking
- follow-ups
- delegation
- day brief quality
- contact understanding
- connector health
- reminder quality
- language and tone
- personal preferences
- knowledge retrieval
- proactive alerts
- workflow automation
- product features

The product should eventually behave like:

> "I noticed you regularly ask me to summarize pending approvals from Gmail and WhatsApp before your morning review. I can create an automated section in your Day Brief for this. I have prepared the product proposal, technical design, and test plan. Please approve before I create a development request."

---

# 2. Non-Negotiable Governance Principle

Nexeo may learn, recommend, draft, automate, and prepare actions.

Nexeo must not independently:

- speak as the user without consent
- send messages from the user's identity without explicit user-initiated chain
- fabricate messages, senders, timestamps, or context
- bypass quiet hours except approved emergency rules
- bypass outbound opt-in
- bypass daily caps and rate limits
- bypass tenant or user isolation
- expose one user's data to another user
- promote private contacts to public without owner approval
- act on uncertainty without confirmation
- modify production code directly
- deploy itself
- create permissions for itself
- change security isolation logic without approval
- change connector credentials or auth rules without approval

This must remain aligned with Nexeo's core rule:

> Brain never speaks or acts in your identity without your consent.

---

# 3. Existing Nexeo Context

Current Nexeo architecture uses six layers:

```text
L6 — Interaction Surfaces: Day Brief, Brain Chat, WhatsApp
L5 — Reasoning + Composition: LLM, tools, prompts
L4 — Triage + Open Items + Knowledge Base
L3 — Feed Ingestion + Adapters: Gmail, WhatsApp, IMAP, Calendar
L2 — Connectors + Auth: OAuth, IMAP/SMTP credentials, webhooks
L1 — Storage: Postgres, Redis, encrypted credentials
```

Current key surfaces:

- Day Brief
- Open Items
- Brain Chat
- WhatsApp Brain channel
- Web Brain Chat panel
- Connectors
- Admin panel
- WhatsApp admin
- User settings

Current stack:

- Backend: Node.js + TypeScript + Express + Prisma
- Database: PostgreSQL 17
- Queue/cache: Redis
- Frontend: React/Vite
- LLM: Gemini default, Gemini Pro heavy, Claude highest-trust
- Auth: session tokens with sha256 hash, bcrypt passwords
- Process manager: PM2
- Public URL: `https://tai.tmcltd.com`
- Repo: `github.com/sirabdulbasit/tmcai`
- Current tenancy key: `client_number`
- Tenant scope enforced via Prisma tenant-scope middleware

---

# 4. Self-Learning Scope

Nexeo should learn from all user and system activity.

## 4.1 User Work Pattern Learning

Learn from:

- emails user reads, ignores, replies to, archives, delegates
- WhatsApp messages user responds to or ignores
- calendar meetings user attends, declines, reschedules
- open items created, delegated, completed, overdue
- contacts frequently involved in work
- follow-up patterns
- user decisions
- repeated instructions
- tone preferences
- language preferences
- quiet hours
- preferred brief timing
- preferred output format
- recurring meeting patterns
- priority patterns
- escalation patterns

## 4.2 Communication Learning

Learn from:

- accepted email drafts
- edited email drafts
- rejected drafts
- WhatsApp replies approved by user
- tone differences by channel
- user-preferred language
- formal vs informal style
- response length
- greeting/signature preferences
- contact-specific communication style
- language mirroring patterns

Important rule:

> WhatsApp tone samples must not pool into email drafts, and email tone samples must not pool into WhatsApp replies.

## 4.3 Triage Learning

Learn from:

- items marked important
- items ignored
- items dismissed from Day Brief
- items promoted to Open Items
- items delegated
- items escalated
- false positive critical alerts
- missed important items
- delayed responses
- calendar conflicts
- urgent sender patterns
- topic importance patterns

## 4.4 Connector Learning

Learn from:

- connector health
- token expiry
- failed syncs
- missing permissions
- feed freshness
- duplicate feed events
- sync latency
- user connector usage
- per-tenant connector adoption
- data quality from connectors

## 4.5 Product Learning

Learn from:

- repeated user prompts
- support requests
- admin actions
- failed Brain responses
- manual workarounds
- incomplete answers
- missing connector requests
- repeated Day Brief customization requests
- repeated automation requests
- repeated open-item issues
- repeated WhatsApp delivery issues
- repeated parity mismatches between web and WhatsApp

---

# 5. Self-Learning Architecture

```text
Feed Events
   ↓
Brain Interactions
   ↓
User Actions
   ↓
Open Items
   ↓
Connector Health
   ↓
User Feedback
   ↓
Decision / Delegation Outcomes
   ↓
Reflection Agent
   ↓
Rule Miner
   ↓
Learning Memory
   ↓
Gap Detection
   ↓
Product Improvement Agent
   ↓
Human Approval
   ↓
Technical Architect Agent
   ↓
Development Request
   ↓
Coding Agent
   ↓
Branch + Pull Request
   ↓
QA + Security Review
   ↓
Human Review
   ↓
Staging / UAT
   ↓
Production Approval
   ↓
Deployment
   ↓
Post-release Monitoring
```

---

# 6. AI Memory Layer

Nexeo already has memory concepts. Extend them into governed self-learning memory.

## 6.1 Memory Categories

### User Preference Memory

Stores:

- communication preferences
- tone preferences
- language preference
- preferred output length
- preferred brief structure
- important contacts
- quiet hour preferences
- escalation preference
- decision style
- approval preference

### Contact Memory

Stores:

- relationship to user
- organization
- preferred channel
- importance level
- past delegation pattern
- response expectations
- source of contact discovery

Important:

- contacts must remain private by default
- auto-discovered contacts must be `scope='user'`
- public promotion must require owner approval

### Decision Memory

Stores:

- user-approved decisions
- repeated approvals
- rejection patterns
- delegation choices
- scheduling preferences
- response preferences

### Workflow Memory

Stores:

- repeated workflows
- open-item patterns
- follow-up thresholds
- recurring day-brief sections
- repeated automations requested by user

### Product Learning Memory

Stores:

- missing features
- repeated prompts
- failed answers
- parity mismatches
- accepted product suggestions
- rejected suggestions
- implemented improvements

### Connector Memory

Stores:

- connector health patterns
- token expiry patterns
- feed freshness issues
- frequently failing connectors
- tenant connector preferences

---

# 7. Suggested Database Tables

Use existing Prisma conventions and `client_number` tenant scoping. Adapt field names to existing schema style.

## 7.1 Brain Interaction Learning Log

```sql
CREATE TABLE brain_interaction_learning_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_number TEXT NOT NULL,
    user_id UUID NOT NULL,

    surface VARCHAR(50) NOT NULL,
    -- web_chat, whatsapp_brain, day_brief, open_items, admin, connector, background_job

    interaction_type VARCHAR(100) NOT NULL,
    -- ask, compose, summarize, triage, draft_reply, follow_up, alert, schedule, delegate

    user_prompt TEXT NULL,
    brain_response TEXT NULL,
    context_snapshot JSONB NULL,
    data_blocks_used JSONB NULL,

    model_provider VARCHAR(100) NULL,
    model_name VARCHAR(100) NULL,
    tokens_used INTEGER NULL,

    risk_level VARCHAR(50) DEFAULT 'low',
    -- low, medium, high, critical

    status VARCHAR(50) DEFAULT 'success',
    -- success, failed, blocked, escalated, pending_approval

    user_outcome VARCHAR(100) NULL,
    -- accepted, edited, rejected, ignored, delegated, marked_done, dismissed

    created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_brain_learning_client_user_surface
ON brain_interaction_learning_logs (client_number, user_id, surface, created_at);
```

## 7.2 Brain Feedback

```sql
CREATE TABLE brain_feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_number TEXT NOT NULL,
    user_id UUID NOT NULL,
    interaction_id UUID NULL,

    feedback_type VARCHAR(100) NOT NULL,
    -- helpful, incorrect, incomplete, too_generic, too_long, too_short,
    -- wrong_priority, wrong_tone, wrong_language, hallucinated, privacy_concern,
    -- cross_channel_tone_issue, parity_issue

    feedback_comment TEXT NULL,
    corrected_output TEXT NULL,

    created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_brain_feedback_client_user
ON brain_feedback (client_number, user_id, created_at);
```

## 7.3 Governed Brain Memories

```sql
CREATE TABLE governed_brain_memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_number TEXT NOT NULL,
    user_id UUID NULL,

    memory_scope VARCHAR(50) NOT NULL,
    -- user_preference, contact, decision, workflow, product, connector, tenant

    scope_reference_id UUID NULL,
    memory_type VARCHAR(100) NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,

    source_type VARCHAR(100) NULL,
    source_reference_id UUID NULL,

    confidence_score NUMERIC(5,2) DEFAULT 0,
    sensitivity_level VARCHAR(50) DEFAULT 'normal',
    -- low, normal, sensitive, critical

    status VARCHAR(50) DEFAULT 'pending_approval',
    -- pending_approval, active, archived, rejected

    created_by_brain BOOLEAN DEFAULT true,
    approved_by UUID NULL,
    approved_at TIMESTAMP NULL,

    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_governed_memories_client_user_scope
ON governed_brain_memories (client_number, user_id, memory_scope, status);
```

## 7.4 Brain Detected Gaps

```sql
CREATE TABLE brain_detected_gaps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_number TEXT NOT NULL,
    user_id UUID NULL,

    gap_type VARCHAR(100) NOT NULL,
    -- missing_feature, workflow_automation, triage_quality, day_brief_quality,
    -- connector_issue, whatsapp_issue, open_item_issue, knowledge_gap,
    -- parity_issue, security_issue, privacy_issue, ux_improvement,
    -- product_performance, language_tone_issue

    title TEXT NOT NULL,
    description TEXT NOT NULL,
    evidence JSONB NOT NULL,

    affected_surfaces TEXT[],
    affected_connectors TEXT[],
    affected_roles TEXT[],

    frequency_count INTEGER DEFAULT 0,
    business_impact VARCHAR(50),
    risk_level VARCHAR(50),
    brain_confidence NUMERIC(5,2),

    suggested_action TEXT,

    status VARCHAR(50) DEFAULT 'new',
    -- new, under_review, approved, rejected, converted_to_proposal, implemented

    reviewed_by UUID NULL,
    reviewed_at TIMESTAMP NULL,

    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_brain_detected_gaps_client_status
ON brain_detected_gaps (client_number, status, gap_type, created_at);
```

## 7.5 Product Improvement Proposals

```sql
CREATE TABLE brain_product_proposals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_number TEXT NOT NULL,
    user_id UUID NULL,
    gap_id UUID NULL,

    title TEXT NOT NULL,
    problem_statement TEXT NOT NULL,
    business_impact TEXT NULL,
    user_impact TEXT NULL,

    affected_surfaces TEXT[],
    affected_connectors TEXT[],
    affected_services TEXT[],

    proposal_markdown TEXT NOT NULL,

    risk_level VARCHAR(50) DEFAULT 'medium',
    priority VARCHAR(50) DEFAULT 'medium',
    estimated_complexity VARCHAR(50) DEFAULT 'medium',

    status VARCHAR(50) DEFAULT 'draft',
    -- draft, awaiting_approval, approved, rejected, converted_to_development

    created_by_brain BOOLEAN DEFAULT true,
    approved_by UUID NULL,
    approved_at TIMESTAMP NULL,

    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_brain_product_proposals_client_status
ON brain_product_proposals (client_number, status, created_at);
```

## 7.6 AI Development Requests

```sql
CREATE TABLE brain_development_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_number TEXT NOT NULL,
    user_id UUID NULL,

    gap_id UUID NULL,
    proposal_id UUID NULL,

    title TEXT NOT NULL,
    description TEXT NOT NULL,
    requirement_markdown TEXT NOT NULL,
    technical_spec_markdown TEXT NULL,

    target_repository TEXT NULL,
    target_branch TEXT NULL,
    generated_branch TEXT NULL,
    pull_request_url TEXT NULL,

    test_status VARCHAR(50) DEFAULT 'not_started',
    security_status VARCHAR(50) DEFAULT 'not_started',

    status VARCHAR(50) DEFAULT 'draft',
    -- draft, awaiting_approval, approved_for_development,
    -- coding_in_progress, pr_created, review_required,
    -- uat_required, approved_for_release, deployed, rejected

    risk_level VARCHAR(50) DEFAULT 'high',

    requested_by UUID NULL,
    approved_by UUID NULL,
    approved_at TIMESTAMP NULL,

    created_at TIMESTAMP DEFAULT now(),
    updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_brain_development_requests_client_status
ON brain_development_requests (client_number, status, created_at);
```

---

# 8. Gap Detection Engine

The Gap Detection Engine should detect recurring product and workflow issues.

## 8.1 Gap Types

- missing_feature
- workflow_automation
- triage_quality
- day_brief_quality
- connector_issue
- whatsapp_issue
- open_item_issue
- knowledge_gap
- parity_issue
- security_issue
- privacy_issue
- ux_improvement
- product_performance
- language_tone_issue
- alert_quality_issue
- follow_up_quality_issue
- delegation_issue
- calendar_conflict_issue
- contact_resolution_issue

## 8.2 Example Gap Detection

```markdown
### Gap Detected
Title: Day Brief Missing Pending Approval Summary

Evidence:
- User asked 11 times in 30 days for pending approval summary.
- 6 requests combined Gmail and WhatsApp context.
- 4 Day Brief feedback items marked "missing important approvals".
- 3 open items were manually created after Day Brief.

Suggested Action:
Add an optional "Pending Approvals" section in Day Brief using Gmail, WhatsApp, and Open Items.

Risk:
Medium

Approval Required:
User / Admin
```

---

# 9. Self-Improvement / Controlled Self-Development Workflow

Nexeo can propose and develop improvements, but only through a safe workflow.

```text
Brain detects repeated need
   ↓
Brain creates gap record
   ↓
User/Admin reviews gap
   ↓
Brain creates product proposal
   ↓
Human approval
   ↓
Brain creates technical design
   ↓
Human approval for development
   ↓
Coding agent works in branch
   ↓
Automated tests
   ↓
Security review
   ↓
Pull request
   ↓
Human code review
   ↓
Staging
   ↓
UAT
   ↓
Production release approval
```

## Hard Rules

- No direct production edits.
- No production deploy by Brain.
- No credentials modification without approval.
- No auth/session changes without approval.
- No tenant isolation changes without approval.
- No outbound message policy changes without approval.
- No WhatsApp sender policy changes without approval.
- No automated sending from user identity without explicit user chain.
- No private memory promotion without approval.
- No cross-user data access.
- No cross-tenant data access.

---

# 10. AI Agents to Implement

## 10.1 Reflection Learning Agent

Already conceptually exists as a background job. Strengthen it.

Responsibilities:

- Aggregate decisions.
- Aggregate delegations.
- Identify repeated user behavior.
- Extract stable preferences.
- Recommend memories.
- Recommend workflow automations.
- Detect repeated open-item patterns.
- Detect repeated communication patterns.

Important:

- Sensitive memories should go to pending approval.
- Low-risk preferences can be proposed to the user.
- Never silently store sensitive personal data.

---

## 10.2 Rule Miner Agent

Already conceptually exists as a job. Strengthen it.

Responsibilities:

- Mine operational rules from logs.
- Detect repeated if/then patterns.
- Suggest standing orders.
- Suggest triage rules.
- Suggest Day Brief rules.
- Suggest follow-up rules.
- Suggest connector monitoring rules.

Example:

> If email sender is MD and subject contains "approval", mark as high priority and include in Day Brief.

Must require approval before activation.

---

## 10.3 Triage Learning Agent

Responsibilities:

- Improve classification of inbox/WhatsApp/calendar items.
- Learn priority patterns.
- Detect false positives.
- Detect missed important items.
- Learn sender importance.
- Learn topic importance.
- Suggest triage rules.

---

## 10.4 Day Brief Optimization Agent

Responsibilities:

- Learn what user reads/dismisses.
- Improve sections.
- Recommend new brief blocks.
- Detect missing high-priority items.
- Personalize format.
- Respect user time, timezone, quiet hours, and language preferences.

---

## 10.5 Open Items Learning Agent

Responsibilities:

- Detect stale open items.
- Learn follow-up thresholds.
- Recommend delegation follow-ups.
- Suggest auto-creation of open items.
- Detect repeated unfinished workflows.
- Summarize open-item risk.

---

## 10.6 Connector Intelligence Agent

Responsibilities:

- Learn connector reliability.
- Detect sync failure patterns.
- Detect token expiry.
- Detect feed freshness issues.
- Recommend connector repair actions.
- Recommend missing connectors.
- Detect duplicate or noisy connectors.

---

## 10.7 Communication Style Agent

Responsibilities:

- Learn tone per channel.
- Learn language preference.
- Learn contact-specific style.
- Learn email signature and greeting style.
- Learn WhatsApp brevity preference.
- Keep channel tone separated.

---

## 10.8 Contact Intelligence Agent

Responsibilities:

- Resolve contacts accurately.
- Prevent cross-user contact leakage.
- Learn important contacts.
- Detect duplicate contacts.
- Suggest contact enrichment.
- Keep auto-discovered contacts private by default.

---

## 10.9 Product Manager Agent

Responsibilities:

- Convert detected gaps into product proposals.
- Generate user stories.
- Generate acceptance criteria.
- Estimate risk and impact.
- Suggest priority.
- Convert approved proposal into development request.

---

## 10.10 Technical Architect Agent

Responsibilities:

- Convert proposal into implementation-ready technical spec.
- Identify affected files/services.
- Define DB changes.
- Define APIs.
- Define UI changes.
- Define tests.
- Define security impact.
- Define rollback plan.

---

## 10.11 Developer Agent

Responsibilities:

- Implement only approved technical specs.
- Work in branch.
- Create pull request.
- Add tests.
- Update docs.
- Never deploy directly.

---

## 10.12 QA Agent

Responsibilities:

- Validate functionality.
- Validate parity across surfaces.
- Validate user isolation.
- Validate tenant isolation.
- Validate suppression gates.
- Validate quiet hours.
- Validate outbound consent.
- Validate connector status truth.
- Validate no hardcoded Brain replies.

---

## 10.13 Security & Privacy Agent

Responsibilities:

- Check cross-user leakage.
- Check cross-tenant leakage.
- Check outbound consent.
- Check credential encryption.
- Check connector auth safety.
- Check prompt injection.
- Check memory sensitivity.
- Check private contact protection.
- Check production deployment risk.

---

# 11. Backend Architecture

Use existing Nexeo structure and conventions.

## Suggested Structure

```text
server/src/services/learning/
  brainLearningLogService.ts
  brainFeedbackService.ts
  governedMemoryService.ts
  gapDetectionService.ts
  productProposalService.ts
  developmentRequestService.ts
  riskScoringService.ts
  learningAuditService.ts

server/src/services/learning/agents/
  reflectionLearningAgent.ts
  ruleMinerAgent.ts
  triageLearningAgent.ts
  dayBriefOptimizationAgent.ts
  openItemsLearningAgent.ts
  connectorIntelligenceAgent.ts
  communicationStyleAgent.ts
  contactIntelligenceAgent.ts
  productManagerAgent.ts
  technicalArchitectAgent.ts
  developerAgent.ts
  qaAgent.ts
  securityPrivacyAgent.ts

server/src/routes/learningRoutes.ts

server/src/jobs/
  learningReflectionJob.ts
  gapDetectionJob.ts
  productImprovementJob.ts
```

---

# 12. API Endpoints

```http
POST /api/learning/feedback
GET  /api/learning/interactions

GET  /api/learning/memories
POST /api/learning/memories
PATCH /api/learning/memories/:id/approve
PATCH /api/learning/memories/:id/reject
PATCH /api/learning/memories/:id/archive

GET  /api/learning/gaps
POST /api/learning/gaps/detect
GET  /api/learning/gaps/:id
PATCH /api/learning/gaps/:id/approve
PATCH /api/learning/gaps/:id/reject

POST /api/learning/proposals/from-gap/:gapId
GET  /api/learning/proposals
GET  /api/learning/proposals/:id
PATCH /api/learning/proposals/:id/approve
PATCH /api/learning/proposals/:id/reject

POST /api/learning/development-requests
GET  /api/learning/development-requests
GET  /api/learning/development-requests/:id
POST /api/learning/development-requests/:id/generate-technical-spec
POST /api/learning/development-requests/:id/send-to-coding-agent
PATCH /api/learning/development-requests/:id/approve
PATCH /api/learning/development-requests/:id/reject

GET /api/learning/audit
GET /api/learning/risk-events
```

All endpoints must:

- require authentication
- enforce `client_number`
- enforce user scope
- enforce role/admin permissions where required
- never trust client-submitted tenant/user scope
- log all actions

---

# 13. Frontend Features

## 13.1 Brain Learning Center

Add an admin/user screen:

> Brain Learning Center

Sections:

- Learned Preferences
- Pending Memory Approvals
- Triage Learning
- Day Brief Improvements
- Open Item Learning
- Connector Intelligence
- Communication Style Learning
- Contact Intelligence
- Detected Gaps
- Product Improvement Proposals
- Development Requests
- Learning Audit

---

## 13.2 Memory Approval UI

Show:

- memory title
- scope
- sensitivity
- confidence
- evidence/source
- proposed content
- approve
- reject
- edit before approve
- archive

---

## 13.3 Detected Gaps Inbox

Show:

- title
- gap type
- evidence
- affected surface
- affected connector
- frequency
- risk
- confidence
- suggested action
- approve
- reject
- convert to proposal

---

## 13.4 Product Proposal Screen

Show:

- problem
- evidence
- user impact
- product impact
- affected services
- suggested solution
- user stories
- acceptance criteria
- data requirements
- privacy/security risk
- approval required
- convert to development request

---

## 13.5 Development Request Screen

Show:

- requirement markdown
- technical spec
- target repo
- generated branch
- pull request URL
- test status
- security status
- UAT status
- approval history
- approve/reject
- send to coding agent

---

# 14. Risk Scoring

Every AI action must be risk-scored.

## Low Risk

Brain may proceed and log.

Examples:

- summarize email
- summarize open items
- suggest Day Brief wording
- propose reminder text
- suggest low-risk memory
- draft non-sensitive note

## Medium Risk

Brain may draft, but user confirmation is required before action.

Examples:

- create open item from inferred message
- send follow-up from Nexeo tenant number
- suggest triage rule
- update Day Brief structure
- save workflow memory
- suggest contact enrichment

## High Risk

Brain may recommend only. Approval required.

Examples:

- send message from user identity
- schedule meeting on behalf of user
- delegate task to another person
- change connector configuration
- activate standing order
- create code branch
- update product behavior affecting many users

## Critical Risk

Brain must not execute directly.

Examples:

- change tenant isolation logic
- change auth/session logic
- change credential encryption
- expose private contacts as public
- bypass outbound consent
- bypass quiet hours/emergency rules
- deploy production code
- modify production database manually
- send as user without explicit chain

---

# 15. Approval Matrix

| Action | Risk | Brain Can Auto-Execute | Approval Required |
|---|---:|---:|---|
| Summarize email/calendar/WA | Low | Yes | No |
| Suggest reply | Low/Medium | Draft only | User sends |
| Send from Nexeo tenant number | Medium/High | Only if policy allows | User/Admin depending on kind |
| Send from user's identity | High/Critical | No | Explicit user action |
| Create open item | Medium | Yes if user setting allows | User confirmation for inferred items |
| Delegate open item | High | Draft/recommend | User |
| Follow up delegatee | Medium | Yes if approved workflow | User policy |
| Update low-risk preference | Low/Medium | Proposed | User approval |
| Update sensitive memory | High | No | User/Admin |
| Promote contact to public | Critical | No | Contact owner |
| Change connector config | High | No | User/Admin |
| Change auth/tenant logic | Critical | No | Tech Lead + Security |
| Generate product proposal | Low/Medium | Yes | User/Admin to proceed |
| Generate technical spec | Medium | After proposal approval | Product/Tech owner |
| Create code branch | High | After dev approval | Tech Lead |
| Create PR | High | Yes after approved dev request | Code reviewer |
| Deploy to production | Critical | No | Release manager |

---

# 16. Prompt Templates

## 16.1 Reflection Learning Agent Prompt

```text
You are Nexeo's Reflection Learning Agent.

Your job is to analyze user decisions, delegations, open items, email actions, WhatsApp actions, calendar actions, and Brain interactions to identify stable patterns that can improve future assistance.

Rules:
- Do not invent facts.
- Do not store sensitive personal information unless the user explicitly approved it.
- Do not create cross-user or cross-tenant memories.
- Use only the authenticated user's data.
- Keep WhatsApp tone and email tone separate.
- Mark uncertain patterns as suggestions, not facts.
- For sensitive or high-impact memories, set status to pending_approval.
- Never override user preferences without approval.

Output:
1. Observed pattern
2. Evidence
3. Suggested memory
4. Memory scope
5. Confidence score
6. Sensitivity level
7. Approval requirement
8. Expected benefit
```

---

## 16.2 Rule Miner Agent Prompt

```text
You are Nexeo's Rule Miner Agent.

Your job is to identify repeated operational rules from Brain logs, feed events, open items, user feedback, and user actions.

Examples:
- If sender is MD and topic is approval, mark high priority.
- If open item is silent for 3 days, follow up.
- If meeting conflicts with MD review, alert user.
- If WhatsApp message contains urgent client escalation, notify user immediately.

Rules:
- Do not activate rules automatically if they affect outbound communication, delegation, scheduling, or priority escalation.
- Do not bypass quiet hours.
- Do not bypass rate limits.
- Do not bypass consent.
- Do not create rules using private contacts for other users.
- Every suggested rule must include evidence.

Output:
1. Rule title
2. If condition
3. Then action
4. Evidence
5. Risk level
6. Approval required
7. Suggested default status
```

---

## 16.3 Product Manager Agent Prompt

```text
You are Nexeo's AI Product Manager.

Analyze detected gaps, repeated user prompts, failed answers, connector issues, Day Brief feedback, Open Item issues, WhatsApp issues, and parity mismatches.

Create a structured product improvement proposal.

Rules:
- Do not invent evidence.
- Do not recommend unsafe autonomy.
- Do not recommend sending as the user without explicit consent.
- Do not recommend bypassing quiet hours, suppression gates, tenant isolation, or user isolation.
- For security/privacy-impacting changes, mark risk high or critical.
- For code changes, require branch + pull request + human review.

Produce:
1. Title
2. Problem statement
3. Evidence summary
4. Affected surfaces
5. Affected services/files if known
6. User impact
7. Product impact
8. Suggested solution
9. User stories
10. Acceptance criteria
11. Data required
12. Privacy/security considerations
13. Risk level
14. Approval required
15. Success metrics
16. Estimated complexity
17. Suggested priority
```

---

## 16.4 Technical Architect Agent Prompt

```text
You are Nexeo's AI Technical Architect.

Current architecture:
- Backend: Node.js + TypeScript + Express + Prisma
- Frontend: React/Vite
- Database: PostgreSQL 17
- Queue/cache: Redis
- Tenant key: client_number
- Tenant scoping: Prisma tenant-scope middleware
- Brain composer: server/src/services/knowledge/brainComposer.ts
- Brain persona: server/src/services/knowledge/brainPersonaService.ts
- Day Brief job: server/src/jobs/dayBriefDispatchJob.ts
- WhatsApp inbound: server/src/services/whatsapp/WhatsAppInbound.ts
- Brain outbound: server/src/services/notifications/brainOutboundService.ts
- Connector service: server/src/services/connectorService.ts

Convert an approved product proposal into technical design.

Include:
1. Technical summary
2. Affected backend files/services
3. Affected frontend files/components
4. Database schema changes
5. API endpoints
6. Prisma model changes
7. Tenant isolation controls
8. User isolation controls
9. Suppression gate impact
10. Outbound consent impact
11. Connector impact
12. Audit log requirements
13. Test strategy
14. Security/privacy review
15. Rollback plan
16. Deployment notes

Rules:
- Do not bypass tenant/user isolation.
- Do not bypass outbound consent.
- Do not bypass quiet hours/rate limits/daily caps.
- Do not hardcode Brain replies.
- Do not change production directly.
- Do not edit production server manually.
```

---

## 16.5 Developer Agent Prompt

```text
You are Nexeo's AI Developer Agent.

Implement only the approved technical specification.

Repository:
- github.com/sirabdulbasit/tmcai
- main branch: main
- active work branch may exist: feat/myos-whatsapp-brain-channel
- Backend: Node.js + TypeScript + Express + Prisma
- Frontend: React/Vite
- Database: PostgreSQL 17
- Cache/queues: Redis
- Deployment must be local push then production pull/build/restart
- Never edit code directly on production

Hard rules:
1. Work only in a new feature branch.
2. Do not deploy.
3. Do not modify production directly.
4. Do not bypass tenant isolation.
5. Do not bypass user isolation.
6. Do not bypass connector credential encryption.
7. Do not bypass outbound consent.
8. Do not bypass quiet hours, rate limits, or daily caps.
9. Do not send as user without explicit user-initiated chain.
10. Do not hardcode Brain replies.
11. Do not fabricate data.
12. Maintain Web/WhatsApp answer parity.
13. Maintain channel tone separation.
14. Add tests.
15. Update docs.
16. Create pull request.

Before coding:
- Inspect repository structure.
- Identify relevant services/files.
- Identify Prisma schema changes.
- Identify migrations needed.
- Identify route/auth middleware.
- Identify tests/build commands.
- Identify affected background jobs.

After coding:
- Run typecheck/build.
- Run tests if available.
- Verify Prisma migration.
- Verify tenant isolation.
- Verify user isolation.
- Verify parity where relevant.
- Provide PR summary, risks, tests, rollback plan.
```

---

## 16.6 QA Agent Prompt

```text
You are Nexeo's AI QA Agent.

Validate implemented changes against approved acceptance criteria.

Test:
1. Web Brain Chat behavior
2. WhatsApp Brain behavior
3. Same-question same-answer parity where applicable
4. Day Brief behavior
5. Open Items behavior
6. Connector behavior
7. Tenant isolation
8. User isolation
9. Private contact protection
10. Outbound consent
11. Quiet hours
12. Rate limits
13. Daily caps
14. No hardcoded Brain replies
15. No fabricated data
16. Memory approval workflow
17. Suppression gates
18. Admin permissions
19. Prisma migration integrity
20. Rollback safety

Do not recommend release if:
- cross-user data leakage exists
- cross-tenant leakage exists
- Brain sends as user without consent
- outbound suppression gates fail
- hardcoded Brain replies are introduced
- connector credential encryption is bypassed
- parity is broken without documented reason
```

---

## 16.7 Security & Privacy Agent Prompt

```text
You are Nexeo's Security and Privacy Agent.

Review any proposed or implemented change for:

1. Cross-tenant leakage
2. Cross-user leakage
3. Private contact leakage
4. Unauthorized outbound messages
5. User identity impersonation
6. Connector credential exposure
7. Prompt injection
8. Unsafe memory creation
9. Sensitive memory storage
10. Quiet hour bypass
11. Rate-limit bypass
12. Daily cap bypass
13. Auth/session weakness
14. Prisma tenant-scope bypass
15. Production deployment risk
16. Hardcoded Brain replies
17. Data fabrication risk
18. WhatsApp unregistered sender handling
19. WhatsApp inbound call handling
20. Channel tone pooling risk

Classify risk:
- Low
- Medium
- High
- Critical

For high or critical risk:
- Block automatic release.
- Require human review.
- Provide mitigation steps.
```

---

# 17. Frontend Labels

Use these labels:

- Brain Learning Center
- Learned Preferences
- Pending Memories
- Detected Gaps
- Day Brief Improvements
- Triage Learning
- Connector Intelligence
- Open Item Learning
- Product Improvements
- Development Requests
- Approve Memory
- Reject Memory
- Convert to Proposal
- Generate Technical Design
- Send to Coding Agent
- Human Review Required
- Consent Required
- Privacy Review Required
- Security Review Required

---

# 18. Immediate Implementation Scope

Start with Phase 1 and Phase 2.

## Phase 1 — Learning Foundation

Deliver:

1. Brain interaction learning log.
2. Brain feedback capture.
3. Governed memory table/service.
4. Risk scoring service.
5. Learning audit service.
6. Learning API routes.
7. Brain Learning Center basic UI.
8. Memory approval UI.
9. Feedback UI on Brain responses.
10. Auth, tenant isolation, and user isolation enforcement.

## Phase 2 — Gap Detection and Product Improvement

Deliver:

1. Brain detected gaps table/service.
2. Gap detection job.
3. Detected gaps inbox.
4. Product proposal table/service.
5. Proposal generation.
6. Proposal approval/rejection.
7. Development request table/service.
8. Development request screen.
9. Technical design generation endpoint.
10. Approval gates for development requests.

---

# 19. Acceptance Criteria

The implementation is acceptable when:

1. Brain interactions are logged with `client_number` and `user_id`.
2. User feedback can be captured for Brain responses.
3. Governed memories can be proposed, approved, rejected, edited, and archived.
4. Sensitive memories require approval.
5. Memory scope respects user and tenant isolation.
6. Gap detection creates evidence-based suggestions.
7. Brain Learning Center displays memories, feedback, gaps, proposals, and development requests.
8. Product proposals can be generated from approved gaps.
9. Development requests can be created from approved proposals.
10. Technical specs can be generated for approved development requests.
11. Brain cannot deploy code.
12. Brain cannot modify production directly.
13. Brain cannot send as the user without explicit user-initiated chain.
14. Brain cannot bypass quiet hours, rate limits, or daily caps.
15. Brain cannot bypass tenant/user isolation.
16. Private contacts remain private unless owner approves promotion.
17. WhatsApp/email tone separation is preserved.
18. Web/WhatsApp Brain parity is preserved where applicable.
19. No hardcoded Brain replies are introduced.
20. All high-risk actions require human approval.

---

# 20. Master Prompt for Nexeo Coding Agent

Use this as the implementation instruction:

```text
You are working on Nexeo, an AI-powered executive assistant / Brain platform.

Current system:
- Backend: Node.js + TypeScript + Express + Prisma
- Frontend: React/Vite
- Database: PostgreSQL 17
- Cache/queues: Redis
- Tenant key: client_number
- Tenant isolation: Prisma tenant-scope middleware
- Auth: session tokens with sha256 hash stored
- Core surfaces: Day Brief, Open Items, Brain Chat Web, Brain Chat WhatsApp
- Core services:
  - server/src/services/knowledge/brainComposer.ts
  - server/src/services/knowledge/brainPersonaService.ts
  - server/src/jobs/dayBriefDispatchJob.ts
  - server/src/services/whatsapp/WhatsAppInbound.ts
  - server/src/services/whatsapp/UserWebjsProvider.ts
  - server/src/services/notifications/tenantWhatsappSender.ts
  - server/src/services/notifications/brainOutboundService.ts
  - server/src/services/connectorService.ts
  - server/src/services/feed/feedIngestionService.ts
  - server/src/services/adapters/impl/*
  - server/src/routes/admin/*
- Public URL: https://tai.tmcltd.com
- Repo: github.com/sirabdulbasit/tmcai
- Important rules:
  - Brain never speaks or acts in the user's identity without consent.
  - No cross-user data leakage.
  - No cross-tenant data leakage.
  - Contacts are private by default.
  - No hardcoded Brain replies.
  - No Brain fabrication.
  - Connector health truth is status field.
  - Day Brief / Brain Chat / WhatsApp parity should hold for same question.
  - Unregistered WhatsApp senders are dropped silently.
  - WhatsApp calls are one-way Brain → user only.
  - WhatsApp tone samples must not pool into email drafts.

Task:
Add AI Self-Learning and Controlled AI Self-Development capabilities.

Implement Phase 1 and Phase 2 first.

Phase 1:
1. Add learning service structure.
2. Add DB migration / Prisma models for:
   - brain_interaction_learning_logs
   - brain_feedback
   - governed_brain_memories
3. Add risk scoring service.
4. Add learning audit service.
5. Add endpoints:
   - POST /api/learning/feedback
   - GET /api/learning/interactions
   - GET /api/learning/memories
   - POST /api/learning/memories
   - PATCH /api/learning/memories/:id/approve
   - PATCH /api/learning/memories/:id/reject
   - PATCH /api/learning/memories/:id/archive
   - GET /api/learning/audit
6. Add Brain Learning Center UI.
7. Add Memory Approval UI.
8. Add feedback controls on Brain responses.
9. Enforce auth, client_number tenant scope, and user_id scope.
10. Log all learning actions.

Phase 2:
1. Add DB migration / Prisma models for:
   - brain_detected_gaps
   - brain_product_proposals
   - brain_development_requests
2. Add gap detection service and job.
3. Add Detected Gaps Inbox UI.
4. Add Product Proposal service/UI.
5. Add Development Request service/UI.
6. Add endpoint to generate technical specification.
7. Add approval/rejection workflow.
8. Add risk gates for development requests.
9. Ensure Brain cannot deploy or modify production directly.
10. Ensure coding agent flow is branch + PR only.

Hard rules:
- Do not bypass tenant isolation.
- Do not bypass user isolation.
- Do not expose private contacts.
- Do not send as user without explicit user-initiated chain.
- Do not bypass outbound opt-in.
- Do not bypass quiet hours, rate limits, or daily caps.
- Do not hardcode Brain replies.
- Do not fabricate message content, senders, timestamps, or origins.
- Do not pool WhatsApp tone into email drafts or email tone into WhatsApp replies.
- Do not change connector credential encryption without approval.
- Do not change auth/session logic without approval.
- Do not change tenant isolation logic without approval.
- Do not deploy.
- Do not edit production directly.
- All code changes must go through branch, tests, PR, human review, and release approval.

Before coding:
1. Inspect repository structure.
2. Inspect Prisma schema.
3. Inspect auth/session middleware.
4. Inspect tenant-scope middleware.
5. Inspect Brain composer.
6. Inspect Day Brief job.
7. Inspect WhatsApp inbound/outbound services.
8. Inspect connector service.
9. Inspect existing audit logging.
10. Prepare migration plan.
11. Prepare test plan.

After coding:
1. Run typecheck/build.
2. Run tests if available.
3. Verify Prisma migration.
4. Verify tenant isolation.
5. Verify user isolation.
6. Verify no hardcoded Brain replies.
7. Verify outbound consent.
8. Verify quiet hours/rate limits/daily caps are respected.
9. Provide PR summary:
   - files changed
   - migrations
   - APIs
   - UI screens
   - risk controls
   - tests
   - rollback plan
```

---

# 21. Expected Final Behavior

After implementation, Nexeo should be able to say:

> I noticed that you repeatedly ask me to combine Gmail, WhatsApp, and Open Items into a pending approvals summary before your morning review. I found 11 similar requests, 4 Day Brief feedback items, and 3 manual open-item creations. I have prepared a product improvement proposal and technical design. Please approve before I create a development request.

This is the target behavior for Nexeo's self-learning and controlled self-development capability.
