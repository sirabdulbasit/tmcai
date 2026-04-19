# TMC AI Intelligence -- Architecture & Roadmap

**Last Updated**: 2026-04-11

## Project Overview

TMC AI Intelligence is a custom AI-powered business intelligence platform for TallyMarks Consulting (TMC). It provides executive-quality insights over internal business data (clients, projects, sales, HR) using multi-provider AI with semantic search, privacy protection, and interactive dashboards.

**Current Status**: All core phases complete + **MyOS Phase 1 (Foundation)** in progress. Full-stack multi-tenant platform with PostgreSQL, password-based auth, React login page, chat history, user profiles, scheduled tasks, audit logging, optimized RAG pipeline (~5-15s response times), and the MyOS personal intelligence layer (connectors, open items, entities, brain config).

### MyOS — Personal Intelligence Operating System (NEW)
MyOS adds a per-user configurable AI chief-of-staff layer on top of TMCAI. See [MYOS.md](MYOS.md) for full spec.
- **Phase 1 (Gather & Present)**: Unified connector framework, open items DB, entity knowledge graph, brain config — **IN PROGRESS**
- **Phase 2 (AI Brain Suggests)**: Email intelligence pipeline, delegation engine, conversational briefing — PLANNED
- **Phase 3 (Decisions & Memory)**: Decision logging, pattern analysis, auto-action promotion, thought pipeline — PLANNED

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 19, Vite 7, Chart.js |
| **Backend** | Express 5, TypeScript, Node.js |
| **Database** | PostgreSQL + Prisma 6 (12 tables, multi-tenant via client_number) |
| **AI Providers** | Gemini 2.5 Pro/Flash, Claude Sonnet 4, GPT-4o, Groq Llama 4, OpenRouter |
| **Embeddings** | Gemini embedding-001 (3072 dimensions) |
| **Search** | Hybrid: Vector cosine + TF-IDF + Reciprocal Rank Fusion |
| **Re-ranking** | Gemini Flash cross-encoder (skipped for simple queries) |
| **Query Enhancement** | Parallel intent + rewrite via Promise.all |
| **PII Detection** | AI-powered NER via Gemini Flash (cached, no hardcoded patterns) |
| **Auth** | Password-based (client_number + email/empcode + password), bcrypt, HttpOnly cookies, session lockout |
| **Frontend Auth** | React LoginPage + AuthContext, protected routing, dark theme |
| **Multi-Tenancy** | client_number on all tables, tenant-scoped queries, composite keys |
| **Encryption** | AES-256-GCM for system_config sensitive values |
| **Security** | Rate limiting, dedup, abort-on-close, content sanitizer, CORS, security headers, PII masking |
| **Scheduler** | node-cron with timezone support (Asia/Karachi), email notifications |
| **Data Source** | Google Drive (TMC_Drive_Index.md) via DataConnector interface |

---

## Phase 1 -- Foundation (Completed)

### What Was Built
The initial working system: a chat-based AI interface connected to Google Drive business data with multi-provider AI streaming.

### Architecture

```
Client (React 19 + Vite)
    |  SSE
Server (Express 5 + TypeScript)
    |-- Intent Classification (Gemini Flash)
    |-- TF-IDF Text Search (keyword-based)
    |-- System Prompt Builder (with data interpretation rules)
    +-- Multi-Provider AI Streaming
         |-- Gemini 2.5 Pro (Deep)
         |-- Gemini 2.5 Flash (Fast)
         |-- Claude Sonnet 4
         |-- GPT-4o
         |-- Groq (Llama 4)
         +-- OpenRouter (Free models with auto-fallback)
```

### Key Features
- Google Drive OAuth 2.0 integration (reads `TMC_Drive_Index.md`)
- Local file fallback when Drive is unavailable
- Intent classification for smart response formatting
- Interactive widgets (dashboards, org charts, charts)
- Auto-refresh every 5 minutes
- Smart model routing (Flash for simple queries, Pro for deep analysis)
- SSE streaming with animated status updates

---

## Phase 1a -- RAG + PII (Completed)

### What Was Built
Replaced keyword search with semantic vector search (RAG) and added AI-powered PII protection. Source-agnostic DataConnector interface for future data sources.

### Components

| Component | File | Purpose |
|-----------|------|---------|
| DataConnector Interface | `connectors/DataConnector.ts` | Source-agnostic interface |
| Drive Connector | `connectors/DriveConnector.ts` | Google Drive -> Documents |
| Chunker | `pipeline/chunker.ts` | Semantic chunking (headers, tables, paragraphs) |
| Embedder | `pipeline/embedder.ts` | Gemini `embedding-001` -- 3072-dim vectors |
| Vector Store | `pipeline/vectorStore.ts` | In-memory cosine similarity + JSON persistence |
| Retriever | `pipeline/retriever.ts` | Orchestrator: connectors -> chunks -> embeddings -> search |
| PII Service | `pipeline/piiService.ts` | AI-powered NER (Gemini Flash), streaming unmask |

### Metrics
- 12 documents -> 401 chunks -> 398 vectors (3072 dimensions)
- Second startup: zero re-embedding (loads from disk)

---

## Phase 1b -- Search Quality (Completed)

### What Was Built
Query rewriting, hybrid search (vector + TF-IDF + RRF), cross-encoder re-ranking, source grounding, rate limiting.

| Component | File | Purpose |
|-----------|------|---------|
| Query Rewriter | `pipeline/queryRewriter.ts` | Expands short queries via Flash |
| Re-ranker | `pipeline/reranker.ts` | Cross-encoder scoring via Flash |
| Hybrid Search | `pipeline/hybridSearch.ts` | Vector + TF-IDF + Reciprocal Rank Fusion |
| Source Grounding | `services/promptService.ts` | AI cites _(Source: Section Name)_ |

---

## Phase 1c -- Hardening & Reliability (Completed)

### What Was Built
Security hardening, abort-on-disconnect, request dedup, PII cache, prompt injection defense, confidence/abstention, stale chunk purge, separate API keys.

| Component | File | Purpose |
|-----------|------|---------|
| Abort on Disconnect | `controllers/chatController.ts` | Stops pipeline when client closes tab |
| Request Dedup Cache | `controllers/chatController.ts` | 30s TTL prevents double-click waste |
| Content Sanitizer | `pipeline/contentSanitizer.ts` | Prompt injection defense |
| Confidence/Abstention | `controllers/chatController.ts` | Low-score queries get uncertainty directive |
| Stale Chunk Purge | `pipeline/vectorStore.ts` | Removes ghost vectors on refresh |
| Separate API Keys | `config/env.ts` | `GEMINI_API_KEY_EMBED` / `GEMINI_API_KEY_PIPELINE` |

---

## Phase 1d -- Performance Optimization (Completed)

### What Was Built
Five optimizations that reduced response times from 50-170s to 5-25s.

### Optimizations

| # | Optimization | Savings |
|---|-------------|---------|
| 1 | **Parallel intent + rewrite + history + profile** -- run simultaneously via `Promise.all` | ~1.5s |
| 2 | **PII cache** -- same context = skip NER call (2-min TTL) | ~3-5s |
| 3 | **Reduced context** -- provider-specific limits (20-30K chars max), 5-7 chunks instead of 10 | LLM 2-3x faster |
| 4 | **Flash for dashboards** -- auto-route widget generation to Flash | ~100-120s |
| 5 | **Skip re-rank for simple queries** -- quick_answer/list/conversational bypass cross-encoder | ~2-4s |

### Response Times (Before vs After)

| Query Type | Before | After |
|-----------|--------|-------|
| Conversational ("hello") | 1-2s | 1-2s |
| Quick answer ("how many projects?") | 15-25s | **5-8s** |
| List/table | 20-30s | **8-12s** |
| Detailed analysis | 40-60s | **15-25s** |
| Dashboard widget | 150-170s | **20-35s** |

### Request Flow (Current -- Optimized Pipeline)

```
User Query
    |
1.  Dedup Check -- same query within 30s? Return cached instantly
    |
2.  Intent + Query Rewrite + Chat History + User Profile (PARALLEL via Promise.all, ~2s)
    |   Gemini Flash classifies intent
    |   Gemini Flash expands short queries (if < 8 words)
    |   Last 4 messages loaded for context continuity
    |   User profile loaded for personalization
    |
3.  [If conversational -> Flash response, no data needed, ~1s]
    |
4.  Hybrid Search (parallel vector + keyword + RRF)
    |   5 chunks for simple queries, 7 for complex
    |
5.  [Re-ranking -- SKIPPED for quick_answer/list/conversational]
    |   Complex queries: Flash cross-encoder scores top results
    |
6.  Score-based Context Trimming (provider-specific limits)
    |   + Content Sanitization (prompt injection defense)
    |   + Confidence check (< 0.4 = abstention directive)
    |
7.  PII Detection (CACHED -- skip if same context seen recently)
    |   "Ahmed Khan" -> [PERSON_1]
    |
8.  Build Prompt (profile directive + conversation history + intent directive + system prompt)
    |
9.  AI Provider (AUTO-ROUTED)
    |   Dashboard/list/export/quick_answer -> Flash (faster widget gen)
    |   Detailed analysis/comparison -> Pro
    |
10. Stream Unmasker -> User sees real names
    |
11. Save: chat history + audit log (non-blocking)
    |
    [Abort on disconnect at any point]
```

---

## Phase 2A -- Production Core (Completed)

### What Was Built
PostgreSQL database with Prisma ORM, password-based authentication, session management, system_config encrypted key-value store, audit logging with PII-masked queries.

### Architecture

```
User -> Login Page (client_number + email/empcode + password)
    |
HttpOnly Cookie (session token, 72h expiry, clientNumber in payload)
    |
Request -> Auth Middleware (requireAuth / optionalAuth / requireAdmin)
    |       (session carries clientNumber for tenant-scoped queries)
Chat Pipeline (RAG + PII + streaming, all queries scoped by client_number)
    |
Save: conversation + messages + audit_log (all in PostgreSQL, tenant-scoped)
```

### Database (PostgreSQL -- 12 tables, multi-tenant)

```
tenants          -- Multi-tenant registry: client_number (PK), name, is_active
system_config    -- Encrypted key-value store (AES-256-GCM, HRAPR pattern)
                    Composite PK: (client_number, key)
roles            -- admin, management, hr, sales, delivery, viewer
                    Unique: (client_number, name)
users            -- empcode, email, password_hash (bcrypt), department, role, profile fields,
                    failed_attempts, locked_until
                    Unique: (client_number, empcode), (client_number, email)
sessions         -- Token-based sessions with user_agent, ip_address tracking
documents        -- Source lifecycle: sync_status, last_checked_at, content_hash
chunks           -- Embeddings stored as JSON (future: pgvector), ACL metadata
conversations    -- Per-user chat threads with auto-titles
messages         -- User + assistant messages with token counts
user_memory      -- AI-extracted durable facts (profile, preference, insight)
audit_log        -- PII-masked query + provider + score + response time
scheduled_tasks  -- Cron-based AI reports with email notifications

All tables include client_number column for tenant isolation.
```

### Components Built

| Component | File | Purpose |
|-----------|------|---------|
| Prisma Client | `db/prisma.ts` | Singleton database connection |
| ConfigService | `services/configService.ts` | system_config CRUD + AES-256-GCM encryption |
| AuthService | `services/authService.ts` | Login, token validation, password management, lockout |
| Auth Middleware | `middleware/auth.ts` | `requireAuth`, `optionalAuth`, `requireAdmin` |
| AuditService | `services/auditService.ts` | PII-masked query logging |
| User Auth Routes | `routes/userAuthRoutes.ts` | Login, logout, profile, password change, admin CRUD |

### Authentication Flow
1. Admin creates user with empcode, email, password, and client_number
2. User opens React login page -> enters Client Number, Email (or Employee Code), and Password
3. Client sends: `POST /api/user/login { clientNumber, email, password }` (or empcode + password)
4. Server finds user by (client_number + email/empcode) -> validates bcrypt hash
5. Creates session with 64-char hex token in HttpOnly cookie; session carries clientNumber in TokenUser
6. Session valid for 72 hours; all subsequent queries scoped by clientNumber from session
7. After 5 failed attempts -> account locked for 30 minutes
8. Chat works with or without auth (`optionalAuth` on `/api/chat/stream`)

### Login Page (React Frontend)
- **AuthContext** (`client/src/context/AuthContext.jsx`): manages auth state (user, login, logout), persists across page refreshes
- **LoginPage** (`client/src/pages/LoginPage.jsx`): form with Client Number, Email/Employee Code, and Password fields
- **Protected Routing**: unauthenticated users redirect to `/login`; authenticated users redirect from `/login` to chat
- **Dark Theme**: styled to match the main app theme

### Security

| Measure | Details |
|---------|---------|
| Password storage | bcrypt (10 rounds) |
| Token format | 64-char hex (32 bytes crypto.randomBytes) |
| Cookie | HttpOnly, Secure (prod), SameSite=Lax |
| Lockout | 5 failed attempts -> 30 min lock |
| Config encryption | AES-256-GCM for sensitive values |
| Rate limiting | Per-user ID when authenticated, per-IP anonymous |
| Security headers | X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Permissions-Policy |

---

## Phase 2B -- Intelligence (Completed)

### What Was Built
Chat history with per-user conversations, message persistence, conversation listing/archiving, auto-generated titles. User profile personalization (JD, about me, custom instructions, tone preference). Scheduled AI tasks with cron + email notifications.

### Components Built

| Component | File | Purpose |
|-----------|------|---------|
| ChatHistoryService | `services/chatHistoryService.ts` | Conversations + messages CRUD, auto-titles |
| Conversation Routes | `routes/conversationRoutes.ts` | List, get, create, archive conversations |
| ProfileService | `services/userProfileService.ts` | User profile CRUD (JD read-only) |
| Profile Routes | `routes/profileRoutes.ts` | Get/update profile |
| SchedulerService | `services/schedulerService.ts` | Cron task management + execution + email |
| EmailService | `services/emailService.ts` | SMTP email sending |
| Scheduler Routes | `routes/schedulerRoutes.ts` | CRUD + on-demand run |
| Chat Integration | `controllers/chatController.ts` | Auto-creates conversation, saves both messages, uses profile + history |

### How Chat History Works
1. Authenticated user sends a message
2. Controller auto-creates a conversation (or appends to existing `conversationId`)
3. User message saved immediately
4. After AI response completes, assistant message saved (non-blocking)
5. Conversation title auto-generated from first user message
6. `GET /api/conversations` returns user's conversation list (most recent first)
7. `GET /api/conversations/:id` returns full conversation with all messages

### How User Profiles Shape AI Responses
1. Profile loaded in parallel with intent/rewrite (no latency cost)
2. Job Description (HR-synced, read-only) tells AI the user's responsibilities
3. Custom instructions override default AI behavior
4. Tone preference adjusts response style
5. Profile directive injected at the top of the system prompt

### How Scheduled Tasks Work
1. User creates task with title, prompt, cron expression, and email recipients
2. node-cron registers the job (timezone: Asia/Karachi)
3. At scheduled time: fetch data -> run AI prompt with user's profile -> email result
4. Results stored in DB (last_result, last_error)
5. Users can also run any task on-demand

---

## Phase 2C -- Multi-Tenant Architecture & Login Page (Completed)

### What Was Built
Multi-tenant data isolation via `client_number` on all tables, React login page with AuthContext, and removal of PIN-based auth in favor of password-only authentication.

### Multi-Tenant Design

- **Tenants table**: `client_number` VARCHAR(20) as primary key, with `name` and `is_active`
- **All 11 data tables** include `client_number` column (system_config, roles, users, documents, chunks, conversations, messages, user_memory, audit_log, scheduled_tasks, sessions)
- **Composite primary key**: system_config uses (client_number, key)
- **Unique constraints**: roles (client_number, name), users (client_number, empcode), users (client_number, email)
- **Service layer**: all queries filter by `client_number` from the authenticated session
- **Session carries tenant**: `TokenUser` includes `clientNumber`, propagated to all downstream services

### Login Page (React Frontend)

| Component | File | Purpose |
|-----------|------|---------|
| AuthContext | `client/src/context/AuthContext.jsx` | Auth state management (user, login, logout) |
| LoginPage | `client/src/pages/LoginPage.jsx` | Login form with client_number, email, password |
| Protected Routing | `client/src/App.jsx` | Unauthenticated users redirect to /login |

### Seed Data
- Tenant "TMC" (TallyMarks Consulting) created with `client_number = "TMC"`
- All seed roles, admin user, and config entries scoped to tenant "TMC"

---

## Phase 3 -- Advanced Intelligence (Future)

### Planned Features

| Feature | Description |
|---------|-------------|
| **pgvector Migration** | Move embeddings from JSON to native PostgreSQL vector type |
| **User Memory** | AI-extracted durable facts from conversations (schema ready, service pending) |
| **Smart Routing** | AI picks best provider per query type based on historical quality scores |
| **Eval Suite** | 30-50 golden Q&A pairs -- measure quality before/after pipeline changes |
| **Enhanced Citations** | Document title, section, timestamp, source type |
| **Role-based Retrieval** | Filter chunks by user's department/role before they reach the AI |
| **Row Level Security** | PostgreSQL RLS policies for DB-level data isolation |
| **Background Indexing** | BullMQ worker for index refresh without blocking Express |
| **Multi-modal** | Support for images, PDFs, spreadsheets as data sources |
| **Agent Workflows** | Multi-step reasoning across multiple data domains |

### Data Sources (Future)

| Source | Connector | Status |
|--------|-----------|--------|
| Google Drive (.md) | `DriveConnector` | Done |
| BigQuery Metadata | `BigQueryConnector` | Planned |
| Vertex AI | `VertexConnector` | Planned |
| SAP APIs | `SAPConnector` | Future |

Adding a new source: create `connectors/XConnector.ts` implementing `DataConnector`, add to array. Zero pipeline changes.

---

## Full File Structure

```
server/
  prisma/
    schema.prisma           -- 12 tables (Prisma 6 + PostgreSQL, multi-tenant)
    migrations/             -- Migration history
    seed.ts                 -- Tenant (TMC) + roles + admin user + config seeding
  src/
    db/
      prisma.ts             -- Prisma client singleton
    config/
      env.ts                -- Environment config + separate API keys
      models.ts             -- AI model IDs and provider labels
    connectors/
      DataConnector.ts      -- Source-agnostic interface
      DriveConnector.ts     -- Google Drive -> Documents
    controllers/
      chatController.ts     -- Optimized pipeline: parallel, cached, auto-routed
      indexController.ts    -- Index management
    middleware/
      auth.ts               -- requireAuth, optionalAuth, requireAdmin
      errorHandler.ts       -- Global error handler
    pipeline/
      chunker.ts            -- Smart semantic chunking
      embedder.ts           -- Gemini embedding-001 (3072 dims)
      vectorStore.ts        -- Cosine similarity + JSON + stale purge
      retriever.ts          -- Score-based context building
      queryRewriter.ts      -- Query expansion (parallel with intent)
      reranker.ts           -- Cross-encoder re-ranking (skipped for simple queries)
      hybridSearch.ts       -- Vector + TF-IDF + Reciprocal Rank Fusion
      piiService.ts         -- AI-powered NER + streaming unmask
      contentSanitizer.ts   -- Prompt injection defense
    routes/
      authRoutes.ts         -- Google Drive OAuth: /api/auth/*
      userAuthRoutes.ts     -- User auth: /api/user/login, /me, /logout
      profileRoutes.ts      -- User profile: /api/profile
      conversationRoutes.ts -- Chat history: /api/conversations/*
      schedulerRoutes.ts    -- Scheduled tasks: /api/schedules/*
      chatRoutes.ts         -- Chat API + rate limiting + optionalAuth
      healthRoutes.ts       -- Health + RAG/PII status
      indexRoutes.ts        -- Index refresh/status
    services/
      configService.ts      -- system_config + AES-256-GCM encryption
      authService.ts        -- Password auth + session management + lockout
      chatHistoryService.ts -- Conversations + messages
      userProfileService.ts -- User profile CRUD
      schedulerService.ts   -- Cron task management + execution
      emailService.ts       -- SMTP email sending
      auditService.ts       -- PII-masked query logging
      driveService.ts       -- Google Drive file fetching + auth
      indexCacheService.ts  -- Caching + auto-refresh + RAG orchestration
      searchService.ts      -- TF-IDF search (used in hybrid search)
      promptService.ts      -- System prompt + source grounding
      intentService.ts      -- Intent classification + response directives
      geminiService.ts      -- Gemini streaming
      claudeService.ts      -- Claude streaming
      openaiService.ts      -- OpenAI streaming
      groqService.ts        -- Groq streaming
      openrouterService.ts  -- OpenRouter with auto-fallback
    types/
      index.ts              -- All TypeScript interfaces
    utils/
      truncate.ts           -- Legacy context truncation

client/
  src/
    App.jsx                 -- Main React app (protected routing)
    main.jsx                -- Entry point
    index.css               -- Global styles
    components/             -- UI components
    context/
      AuthContext.jsx        -- Auth state management (login/logout/user)
    hooks/                  -- Custom React hooks
    pages/
      LoginPage.jsx          -- Login form (client_number + email + password)
    services/               -- API service layer
```

---

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | No | System health + RAG/PII/vector status |
| POST | `/api/user/login` | No | Login with client_number + email/empcode + password |
| POST | `/api/user/logout` | Yes | Revoke session token |
| GET | `/api/user/me` | Yes | Current user profile + role + permissions |
| POST | `/api/user/change-password` | Yes | Change own password |
| POST | `/api/user/users` | Admin | Create new user |
| POST | `/api/user/users/:empcode/reset-password` | Admin | Reset user's password |
| GET | `/api/profile` | Yes | Get my profile (JD is read-only) |
| PUT | `/api/profile` | Yes | Update about_me, instructions, tone_preference |
| GET | `/api/conversations` | Yes | List user's conversations |
| GET | `/api/conversations/:id` | Yes | Get conversation with messages |
| POST | `/api/conversations` | Yes | Create new conversation |
| PATCH | `/api/conversations/:id` | Yes | Update title |
| DELETE | `/api/conversations/:id` | Yes | Archive conversation |
| GET | `/api/schedules` | Yes | List my scheduled tasks |
| POST | `/api/schedules` | Yes | Create new scheduled task |
| PATCH | `/api/schedules/:id` | Yes | Update task |
| DELETE | `/api/schedules/:id` | Yes | Delete task |
| POST | `/api/schedules/:id/run` | Yes | Run task immediately |
| POST | `/api/chat/stream` | Optional | Stream chat response (SSE) |
| GET | `/api/auth/status` | No | Google Drive authorization status |
| GET | `/api/auth` | No | Initiate Google Drive OAuth |
| GET | `/api/auth/callback` | No | OAuth callback |
| GET | `/api/index/status` | No | Index status |
| POST | `/api/index/refresh` | No | Force re-index |

---

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | -- | PostgreSQL connection string |
| `ENCRYPTION_KEY` | -- | 32+ chars for AES-256-GCM (system_config) |
| `PORT` | 4002 | Server port |
| `CLIENT_URL` | http://localhost:5174 | Frontend URL for CORS |
| `NODE_ENV` | development | Environment (controls Secure cookie flag) |
| `GOOGLE_CLIENT_ID` | -- | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | -- | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | http://localhost:4002/api/auth/google/callback | OAuth redirect URI |
| `GOOGLE_DRIVE_FOLDER_ID` | -- | Google Drive folder containing business data |
| `GOOGLE_INDEX_FILE_NAME` | TMC_Drive_Index.md | Index file name in Drive |
| `GEMINI_API_KEY` | -- | Default key for all Gemini functions |
| `GEMINI_API_KEY_EMBED` | -- | Separate key for embeddings (falls back to main) |
| `GEMINI_API_KEY_PIPELINE` | -- | Separate key for rewrite/rerank/PII (falls back to main) |
| `ANTHROPIC_API_KEY` | -- | Claude provider |
| `OPENAI_API_KEY` | -- | GPT-4o provider |
| `GROQ_API_KEY` | -- | Groq/Llama provider |
| `OPENROUTER_API_KEY` | -- | OpenRouter free models |
| `RAG_ENABLED` | true | Enable/disable RAG pipeline |
| `RAG_TOP_K` | 10 | Chunks to retrieve (effective: 5 simple, 7 complex) |
| `RAG_MIN_SCORE` | 0.3 | Minimum similarity threshold |
| `PII_ENABLED` | true | Enable/disable PII masking |
| `MAX_CONTEXT_CHARS` | 50000 | Max context sent to AI (overridden per-provider) |
| `MAX_TOKENS` | 4096 | Max output tokens |
| `REQUEST_TIMEOUT_MS` | 120000 | Request timeout (2 minutes) |
| `INDEX_REFRESH_INTERVAL_MS` | 300000 | Auto-refresh interval (5 minutes) |
