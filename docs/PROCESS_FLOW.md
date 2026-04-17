# TMC AI Intelligence -- Process Flow

**Last Updated**: 2026-03-28

This document describes all user-facing functionalities, their flows, and data paths through the system.

---

## Table of Contents

1. [Login Page Flow (React Frontend)](#1-login-page-flow-react-frontend)
2. [Authentication Flow](#2-authentication-flow)
3. [Chat Flow (Full RAG Pipeline)](#3-chat-flow-full-rag-pipeline)
4. [Conversation Management](#4-conversation-management)
5. [User Profile Management](#5-user-profile-management)
6. [Scheduled Tasks Flow](#6-scheduled-tasks-flow)
7. [Index Refresh Flow](#7-index-refresh-flow)
8. [Widget Rendering (Client)](#8-widget-rendering-client)
9. [Admin Operations](#9-admin-operations)

---

## 1. Login Page Flow (React Frontend)

### 1.1 Login Page Architecture

```
User opens app (any route)
    |
AuthContext checks auth state (GET /api/user/me)
    |
[Not authenticated] -> Redirect to /login -> LoginPage renders
    |
LoginPage shows form:
  - Client Number (text input)
  - Email / Employee Code (text input)
  - Password (password input)
    |
User fills form -> clicks Login
    |
AuthContext.login(clientNumber, email, password)
    |
POST /api/user/login { clientNumber, email, password }
    |
[Success] -> AuthContext stores user -> Redirect to / (chat)
[Failure] -> Show error message on LoginPage
```

### 1.2 AuthContext (`client/src/context/AuthContext.jsx`)

| Function | Purpose |
|----------|---------|
| `login(clientNumber, email, password)` | Sends POST /api/user/login, stores user on success |
| `logout()` | Sends POST /api/user/logout, clears user state, redirects to /login |
| `user` | Current authenticated user object (null if not logged in) |
| `loading` | True while checking initial auth state |

### 1.3 Protected Routing

- `App.jsx` wraps routes with AuthContext
- Unauthenticated users accessing any route are redirected to `/login`
- Authenticated users accessing `/login` are redirected to `/` (chat)
- Dark theme styling matches the main application

---

## 2. Authentication Flow

### 2.1 Login

```
User                    Client (React)              Server (Express)              Database (PostgreSQL)
  |                         |                             |                              |
  |-- Enter client_number --+                             |                              |
  |   + email/empcode       |                             |                              |
  |   + password            |                             |                              |
  |                         |-- POST /api/user/login ---->|                              |
  |                         |   { clientNumber, email,    |                              |
  |                         |     password }              |                              |
  |                         |                             |-- Find tenant by client_no -->|
  |                         |                             |<-- Tenant row (active?) ------|
  |                         |                             |                              |
  |                         |                             |-- Find user by (client_no + ->|
  |                         |                             |   email/empcode)              |
  |                         |                             |<-- User row + role -----------|
  |                         |                             |                              |
  |                         |                             |-- Check lockedUntil           |
  |                         |                             |-- bcrypt.compare(password)    |
  |                         |                             |                              |
  |                         |                             |   [If invalid]:               |
  |                         |                             |-- Increment failedAttempts -->|
  |                         |                             |-- Lock if >= 5 attempts ----->|
  |                         |<-- 401 { error } -----------|                              |
  |                         |                             |                              |
  |                         |                             |   [If valid]:                 |
  |                         |                             |-- Create session (64-char   ->|
  |                         |                             |   hex token, 72h expiry,      |
  |                         |                             |   clientNumber in TokenUser)   |
  |                         |                             |-- Reset failedAttempts=0 ---->|
  |                         |                             |-- Update lastLoginAt -------->|
  |                         |                             |                              |
  |                         |<-- Set-Cookie: tmcai_token  |                              |
  |                         |   (HttpOnly, Secure, Lax)   |                              |
  |                         |<-- 200 { success, user } ---|                              |
  |<-- AuthContext stores    |                             |                              |
  |    user, redirect to / --|                             |                              |
```

**Key details**:
- Login requires `clientNumber` + either `email` or `empcode` + `password`
- Server first validates the tenant (client_number) is active
- User lookup is scoped by client_number: `WHERE client_number = X AND (email = Y OR empcode = Y)`
- Password validated via bcrypt (10 rounds)
- Session token: 32 bytes random = 64-char hex string
- Session's TokenUser carries `clientNumber` for all downstream tenant-scoped queries
- Cookie: HttpOnly (no JS access), Secure (HTTPS only in production), SameSite=Lax
- Lockout: 5 failed attempts triggers 30-minute lock on the user record
- Session metadata: user_agent and ip_address stored for audit

### 2.2 Logout

```
Client --> POST /api/user/logout --> Server marks session.isRevoked = true --> Clear cookie
```

### 2.3 Session Validation (Every Request)

```
Request arrives
    |
Extract token from cookie (or Authorization: Bearer header)
    |
Look up session in DB (findUnique by token)
    |
Check: exists? not revoked? not expired? user is active?
    |
[Pass] -> Attach user to req.user -> Continue
[Fail] -> 401 Unauthorized
```

### 2.4 Account Lockout

| Event | Action |
|-------|--------|
| Failed login attempt | `failedAttempts++` on user record |
| 5th failed attempt | Set `lockedUntil = now + 30 minutes` |
| Successful login | Reset `failedAttempts = 0`, clear `lockedUntil` |
| Admin password reset | Reset `failedAttempts = 0`, clear `lockedUntil` |
| Login while locked | Return 423 with minutes remaining |

---

## 3. Chat Flow (Full RAG Pipeline)

This is the core functionality. A single chat request goes through up to 11 stages.

### 3.1 High-Level Flow

```
User types message in chat UI
    |
Client sends POST /api/chat/stream { message, provider, conversationId }
    |
Server opens SSE (Server-Sent Events) stream
    |
[Stage 1]  Dedup Check (30s cache)
[Stage 2]  Intent + Rewrite + History + Profile (PARALLEL)
[Stage 3]  Short-circuit for conversational queries
[Stage 4]  Hybrid Search (vector + TF-IDF + RRF)
[Stage 5]  Re-ranking (conditional)
[Stage 6]  Context trimming + sanitization + confidence check
[Stage 7]  PII masking (cached)
[Stage 8]  Prompt assembly (profile + history + intent + data)
[Stage 9]  AI provider streaming (auto-routed)
[Stage 10] PII unmasking in stream
[Stage 11] Save history + audit (non-blocking)
    |
Client renders markdown + widgets in real time
```

### 3.2 Detailed Stage Breakdown

#### Stage 1: Request Deduplication
- Hash: MD5 of `message::provider`
- If same hash seen within 30 seconds, replay cached SSE chunks
- Cache cleanup runs every 60 seconds

#### Stage 2: Parallel Pre-processing (Promise.all)
Four operations run simultaneously:
1. **Intent Classification** (Gemini Flash) -- determines query type: `conversational`, `quick_answer`, `list`, `detailed_analysis`, `comparison`, `dashboard`, `export`
2. **Query Rewriting** (Gemini Flash) -- expands short queries for better retrieval
3. **Chat History** -- loads last 4 messages from conversation for context continuity
4. **User Profile** -- loads JD, about_me, instructions, tone_preference

#### Stage 3: Conversational Short-Circuit
If intent is `conversational` (greetings, chitchat):
- Skip all data retrieval
- Stream directly from Gemini Flash with a lightweight system prompt
- Return immediately (~1s)

#### Stage 4: Hybrid Search
```
Query
    |
    +-- Vector Search (cosine similarity on 3072-dim embeddings)
    |       Returns top N results with similarity scores
    |
    +-- TF-IDF Search (keyword matching on cached sections)
    |       Returns top N results with relevance scores
    |
    +-- Reciprocal Rank Fusion (RRF)
            Merges both result sets, re-scores by rank position
            Returns deduplicated, merged results
```

- Simple queries (quick_answer, list): fetch 5 * 2 = 10 candidates
- Complex queries (detailed_analysis, dashboard): fetch 7 * 2 = 14 candidates

#### Stage 5: Re-ranking (Conditional)
- **Skipped for**: `quick_answer`, `list`, `conversational` (take top N from hybrid search directly)
- **Applied for**: `detailed_analysis`, `comparison`, `dashboard`, `export`
- Gemini Flash acts as cross-encoder: scores each chunk's relevance to the original query
- Results sorted by re-rank score, top K selected

#### Stage 6: Context Assembly
1. Build context string from selected chunks (score-based trimming)
2. Apply provider-specific character limits:
   - Gemini Pro: 25,000 chars
   - Gemini Flash / Groq / OpenRouter: 20,000 chars
   - Claude / OpenAI: 30,000 chars
3. Run content sanitizer (remove prompt injection patterns)
4. Check confidence: if top retrieval score < 0.4, add abstention directive

#### Stage 7: PII Masking (Cached)
- MD5 hash the context text
- If same hash seen within 2 minutes, reuse cached PII mapping
- Otherwise: Gemini Flash NER identifies names, emails, phones, etc.
- Replace: "Ahmed Khan" -> `[PERSON_1]`, etc.
- Store mapping for later unmasking

#### Stage 8: Prompt Assembly
The final system prompt is assembled in this order:
1. **User Profile Directive** -- JD, about_me, tone, custom instructions
2. **Conversation History** -- last 4 messages (truncated to 300 chars each)
3. **Confidence Directive** -- if low score, tell AI to be uncertain
4. **Intent Directive** -- formatting rules for the query type
5. **System Prompt** -- data interpretation rules + retrieved context

#### Stage 9: AI Provider Streaming
Auto-routing logic:
- If provider is `gemini` AND intent is `quick_answer`/`list`/`dashboard`/`export` -> force Flash
- Otherwise use the provider the user selected

Timeout: configurable (default 120s), races against abort signal.

#### Stage 10: PII Unmasking
- Stream unmasker buffers output tokens
- Replaces `[PERSON_1]` back to "Ahmed Khan" in real time
- Flushes remaining buffer when stream ends

#### Stage 11: Persistence (Non-blocking)
Both operations fire-and-forget (`.catch(() => {})`) so they never delay the response:
1. **Chat History**: save assistant message with token counts and response time
2. **Audit Log**: save PII-masked query, provider, chunks_retrieved, top_score, pii_entities_count, intent_type, response_time_ms

### 3.3 SSE Event Types

| Event Type | Payload | Purpose |
|-----------|---------|---------|
| `status` | `{ type: "status", content: "Searching data..." }` | Progress updates shown to user |
| `chunk` | `{ type: "chunk", content: "The project..." }` | Streamed response text |
| `meta` | `{ type: "meta", elapsed, outputTokens, inputTokens, ... }` | Final statistics |
| `error` | `{ type: "error", content: "..." }` | Error message |
| `done` | `{ type: "done" }` | Stream complete signal |

### 3.4 Abort on Disconnect
- `req.on('close')` sets `clientDisconnected = true` and fires `AbortController.abort()`
- Every stage checks `clientDisconnected` before proceeding
- LLM call races against abort signal via `Promise.race`
- Prevents wasted compute when user navigates away

---

## 4. Conversation Management

### 4.1 Conversation Lifecycle

```
[No conversationId in request]
    |
    +-- Auto-create conversation (title = null, provider set)
    |   Returns new conversationId
    |
[conversationId exists]
    |
    +-- Append messages to existing conversation
    |
[First message triggers title generation]
    |
    +-- Title auto-set from first user message
    |
[User can rename]  -- PATCH /api/conversations/:id { title }
[User can archive] -- DELETE /api/conversations/:id (sets isArchived = true)
```

### 4.2 Context Continuity

When `conversationId` is provided:
1. Load last 4 messages from the conversation
2. Format as alternating User/Assistant turns (300-char truncation)
3. Inject as `RECENT CONVERSATION` block in the system prompt
4. AI uses this to resolve references like "their", "it", "that project"

### 4.3 Conversation API Flow

| Action | Endpoint | What Happens |
|--------|----------|-------------|
| Start chatting | POST /api/chat/stream | Auto-creates conversation if none specified |
| List conversations | GET /api/conversations | Returns user's conversations, most recent first |
| View conversation | GET /api/conversations/:id | Returns conversation + all messages |
| Rename | PATCH /api/conversations/:id | Updates title |
| Archive | DELETE /api/conversations/:id | Sets isArchived = true (soft delete) |
| New conversation | POST /api/conversations | Creates empty conversation |

---

## 5. User Profile Management

### 5.1 Profile Fields

| Field | Editable By | Source | Effect on AI |
|-------|------------|--------|-------------|
| `job_description` | HR only (read-only for user) | Centralized HR data sync | AI understands user's responsibilities |
| `about_me` | User | Self-written | Personality, background context |
| `instructions` | User | Self-written | Custom AI behavior rules |
| `tone_preference` | User | Self-selected | Response style: friendly, formal, executive, casual, technical |

### 5.2 How Profile Affects AI

```
User asks: "What should I focus on this week?"

Profile loaded:
  JD: "Director of Delivery - SAP Practice"
  Instructions: "Always flag project risks and delays"
  Tone: "executive"

AI response tailored:
  - Focuses on SAP delivery projects (from JD)
  - Highlights risks and delays (from instructions)
  - Crisp, decision-focused language (from tone)
```

### 5.3 Profile API Flow

```
GET /api/profile
    |
    +-- requireAuth middleware validates session
    |
    +-- Load user's profile fields from users table
    |
    +-- Return { jobDescription, aboutMe, instructions, tonePreference }
```

```
PUT /api/profile { aboutMe, instructions, tonePreference }
    |
    +-- requireAuth middleware validates session
    |
    +-- Validate tonePreference (friendly|formal|executive|casual|technical|null)
    |
    +-- Update user record (jobDescription intentionally excluded)
    |
    +-- Return updated profile
```

### 5.4 Tone Options

| Tone | AI Behavior |
|------|-------------|
| friendly | Warm, conversational, uses simple language |
| formal | Professional, structured, business language |
| executive | Crisp, data-driven, focuses on decisions and impact |
| casual | Relaxed, brief, direct |
| technical | Detailed, includes technical terms and specifics |

---

## 6. Scheduled Tasks Flow

### 6.1 Task Creation

```
User --> POST /api/schedules { title, prompt, cronExpression, provider, notifyEmail, notifySelf }
    |
Validate cron expression (node-cron.validate)
    |
Insert into scheduled_tasks table
    |
Register job with node-cron (timezone: Asia/Karachi)
    |
Return task record
```

### 6.2 Task Execution (Automatic)

```
node-cron fires at scheduled time
    |
1. Load task + user from DB
    |
2. Fetch current business data (getCachedSections)
    |
3. TF-IDF search with the task's prompt
    |
4. Load user profile for personalization
    |
5. Build system prompt (profile + data + interpretation rules)
    |
6. Generate AI response via Gemini Flash (non-streaming, collect full text)
    |
7. Update task: lastRunAt, lastResult, nextRunAt
    |
8. Build email (HTML template with TMC branding)
    |
9. Send to recipients:
    |   - User's own email (if notifySelf = true)
    |   - Additional emails (notifyEmail, comma-separated)
    |
10. Log completion
```

### 6.3 On-Demand Execution

```
User --> POST /api/schedules/:id/run
    |
Verify task belongs to user
    |
Execute same flow as automatic execution (steps 1-10)
    |
Return { success: true, message: "Task executed. Check your email." }
```

### 6.4 Task Management

| Action | Endpoint | Description |
|--------|----------|-------------|
| List tasks | GET /api/schedules | All tasks for current user, newest first |
| Create | POST /api/schedules | New task with cron schedule |
| Update | PATCH /api/schedules/:id | Modify title, prompt, cron, provider, notifications; re-registers cron job |
| Delete | DELETE /api/schedules/:id | Stops cron job + removes from DB |
| Run now | POST /api/schedules/:id/run | Immediate execution |

### 6.5 Example Schedules

| Schedule | Prompt | Cron | Recipients |
|----------|--------|------|------------|
| Weekly Risk Report | "Summarize projects with critical risks" | `0 9 * * 1` (Mon 9am) | Delivery team |
| Daily Sales Pipeline | "Show today's pipeline status" | `0 8 * * *` (Daily 8am) | Sales manager |
| Monthly Revenue Summary | "Revenue breakdown by client" | `0 10 1 * *` (1st of month) | CEO |

---

## 7. Index Refresh Flow

### 7.1 Automatic Refresh (Every 5 Minutes)

```
setInterval (INDEX_REFRESH_INTERVAL_MS = 300000)
    |
1. Check Google Drive authorization status
    |
2. Fetch TMC_Drive_Index.md from Google Drive
    |   (fallback to local file if Drive unavailable)
    |
3. Parse markdown into sections
    |
4. Run semantic chunking (headers, tables, paragraphs)
    |
5. Generate/verify embeddings (skip if content_hash unchanged)
    |
6. Update vector store (purge stale chunks)
    |
7. Update cached sections for TF-IDF search
```

### 7.2 Manual Refresh

```
POST /api/index/refresh
    |
Same flow as automatic, but triggered immediately
```

### 7.3 Index Status

```
GET /api/index/status
    |
Returns: { loaded, sectionCount, charCount, lastRefresh, vectorCount, embeddingModel }
```

### 7.4 Stale Chunk Purge
When a refresh occurs:
1. New content hashes computed for all chunks
2. Existing chunks with hashes not in the new set are removed
3. Prevents "ghost vectors" from deleted/modified content

---

## 8. Widget Rendering (Client)

### 8.1 How Widgets Work

The AI generates HTML widgets (dashboards, charts, tables) within the markdown response. The client detects and renders them.

### 8.2 Widget Types

| Widget | Trigger | AI Output |
|--------|---------|-----------|
| Dashboard | Intent: `dashboard` | HTML with Chart.js scripts |
| Data Table | Intent: `list` or `export` | HTML table with row limit filters |
| Org Chart | Org structure queries | Nested HTML/CSS org chart |
| Chart | Comparison/trend queries | Chart.js canvas elements |

### 8.3 Row Limit Filters
Interactive dashboards include filter buttons:
- Top 5 / Top 10 / Top 15 / Top 20 / All
- Client-side filtering without re-querying the AI

### 8.4 Live Timer
During AI generation, the client shows a live elapsed timer so users know the system is working.

---

## 9. Admin Operations

### 9.1 User Creation

```
Admin --> POST /api/user/users { clientNumber, empcode, name, email, password, department, roleId }
    |
Validate: empcode, name, email, password (min 6 chars), roleId required
    |
Hash password with bcrypt (10 rounds)
    |
Insert user into DB
    |
Return { id, empcode, name, email }
```

### 9.2 Password Reset

```
Admin --> POST /api/user/users/:empcode/reset-password
    |
Generate 8-char temporary password (crypto.randomBytes)
    |
Hash with bcrypt and update user record
    |
Reset failedAttempts = 0, lockedUntil = null
    |
Return { tempPassword } (admin communicates to user out-of-band)
```

### 9.3 JD Sync (HR Admin -- Future)
Job Descriptions are managed in centralized HR data:
1. HR updates JD in centralized system
2. Sync process matches by empcode
3. Updates `job_description` field in users table
4. User sees updated JD on next profile load

---

## Data Flow Summary

```
Google Drive (TMC_Drive_Index.md)
    |
    v
DataConnector (DriveConnector) --> Parse + Chunk --> Embed (Gemini) --> Vector Store
    |                                                                       |
    v                                                                       v
Cached Sections (TF-IDF) <-------- Hybrid Search <-------- User Query
                                        |
                                        v
                                  Re-rank (conditional) --> PII Mask --> AI Provider
                                                                            |
                                                                            v
                                                            PII Unmask --> SSE Stream --> Client
                                                                            |
                                                                            v
                                                            Save: conversations + messages + audit_log
```
