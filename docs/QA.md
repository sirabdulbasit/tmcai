# TMC AI Intelligence -- Quality Assurance

**Last Updated**: 2026-03-28

## Overview

This document defines the testing strategy, test cases, acceptance criteria, known limitations, and performance benchmarks for the TMC AI Intelligence platform.

---

## Table of Contents

1. [Testing Strategy](#1-testing-strategy)
2. [Multi-Tenant Test Cases](#2-multi-tenant-test-cases)
3. [Login Page Test Cases](#3-login-page-test-cases)
4. [Authentication Test Cases](#4-authentication-test-cases)
5. [Chat & RAG Pipeline Test Cases](#5-chat--rag-pipeline-test-cases)
6. [PII Masking Test Cases](#6-pii-masking-test-cases)
7. [Conversation Management Test Cases](#7-conversation-management-test-cases)
8. [User Profile Test Cases](#8-user-profile-test-cases)
9. [Scheduled Tasks Test Cases](#9-scheduled-tasks-test-cases)
10. [Index & Data Refresh Test Cases](#10-index--data-refresh-test-cases)
11. [Security Test Cases](#11-security-test-cases)
12. [Performance Benchmarks](#12-performance-benchmarks)
13. [Known Limitations](#13-known-limitations)
14. [Acceptance Criteria](#14-acceptance-criteria)

---

## 1. Testing Strategy

### Testing Layers

| Layer | Approach | Tools |
|-------|----------|-------|
| **Unit Tests** | Individual service/utility functions | Jest, ts-jest |
| **Integration Tests** | API endpoint testing with database | Supertest, Prisma test DB |
| **Pipeline Tests** | RAG pipeline stages (chunking, search, reranking) | Custom test harness |
| **Manual QA** | UI flows, SSE streaming, widget rendering | Browser testing |
| **Security Testing** | Auth bypass, injection, rate limits | Manual + automated |

### Test Environment

| Component | Test Config |
|-----------|-------------|
| Database | Separate PostgreSQL test database |
| API Keys | Test/sandbox keys where available |
| Rate Limits | Reduced for testing (higher max, shorter window) |
| PII | Enabled with known test entities |

---

## 2. Multi-Tenant Test Cases

### 2.1 Tenant Isolation

| ID | Test Case | Steps | Expected Result |
|----|-----------|-------|-----------------|
| MT-01 | Login scoped to tenant | Login as TMC user with client_number "TMC" | Success; session carries clientNumber="TMC" |
| MT-02 | Login with wrong tenant | Login with valid email but wrong client_number | 401, "Invalid credentials" |
| MT-03 | Inactive tenant | Login to tenant with is_active=false | 401, "Tenant not found or inactive" |
| MT-04 | Cross-tenant user isolation | User in tenant A cannot see users in tenant B | Queries filtered by client_number |
| MT-05 | Cross-tenant conversation isolation | User in tenant A cannot access conversations of tenant B | 404 or empty result |
| MT-06 | Cross-tenant config isolation | system_config for tenant A not visible to tenant B | Composite PK (client_number, key) enforces isolation |
| MT-07 | Cross-tenant role isolation | Role "admin" in tenant A is separate from "admin" in tenant B | Unique constraint (client_number, name) |
| MT-08 | Duplicate empcode across tenants | Same empcode in two different tenants | Both created successfully (unique per tenant) |
| MT-09 | Duplicate email across tenants | Same email in two different tenants | Both created successfully (unique per tenant) |
| MT-10 | Duplicate empcode within tenant | Same empcode in same tenant | 409, uniqueness violation |
| MT-11 | All service queries scoped | Any data query (conversations, messages, audit, etc.) | WHERE client_number = session.clientNumber |
| MT-12 | Seed creates TMC tenant | Run seed script | Tenant "TMC" (TallyMarks Consulting) created |

### 2.2 Cross-Tenant Data Protection

| ID | Test Case | Steps | Expected Result |
|----|-----------|-------|-----------------|
| MT-13 | Audit logs scoped | Query audit_log for tenant A | Only tenant A's logs returned |
| MT-14 | Scheduled tasks scoped | List tasks for tenant A | Only tenant A's tasks returned |
| MT-15 | Documents scoped | Index refresh for tenant A | Only tenant A's documents affected |
| MT-16 | Chunks scoped | Vector search for tenant A | Only tenant A's chunks searched |

---

## 3. Login Page Test Cases

### 3.1 Login Page UI

| ID | Test Case | Steps | Expected Result |
|----|-----------|-------|-----------------|
| LP-01 | Login page renders | Navigate to /login | Form with Client Number, Email, Password fields |
| LP-02 | Unauthenticated redirect | Navigate to / without auth | Redirected to /login |
| LP-03 | Authenticated redirect | Navigate to /login with valid session | Redirected to / (chat) |
| LP-04 | Successful login | Fill all fields, click Login | Redirected to chat, user state set in AuthContext |
| LP-05 | Failed login error | Wrong password | Error message displayed on login page |
| LP-06 | Missing fields | Leave Client Number empty | Validation error displayed |
| LP-07 | Loading state | Click Login | Button shows loading state during API call |
| LP-08 | Dark theme | Open login page | Styled with dark theme matching main app |

### 3.2 AuthContext

| ID | Test Case | Steps | Expected Result |
|----|-----------|-------|-----------------|
| LP-09 | Auth state persists | Login, refresh page | User still authenticated (GET /api/user/me) |
| LP-10 | Logout clears state | Click logout | User state cleared, redirected to /login |
| LP-11 | Loading during init | Page load | AuthContext shows loading=true while checking auth |
| LP-12 | Protected routes | Access any non-login route without auth | Redirected to /login |

---

## 4. Authentication Test Cases

### 4.1 Login

| ID | Test Case | Input | Expected Result |
|----|-----------|-------|-----------------|
| AUTH-01 | Valid login with email | `{ clientNumber: "TMC", email: "admin@tmc.com", password: "admin123" }` | 200, Set-Cookie with HttpOnly token, user object returned |
| AUTH-02 | Valid login with empcode | `{ clientNumber: "TMC", empcode: "ADMIN", password: "admin123" }` | 200, Set-Cookie with HttpOnly token |
| AUTH-03 | Invalid password | `{ clientNumber: "TMC", email: "admin@tmc.com", password: "wrong" }` | 401, error message with remaining attempts |
| AUTH-04 | Non-existent user | `{ clientNumber: "TMC", email: "nobody@tmc.com", password: "x" }` | 401, "Invalid credentials" |
| AUTH-05 | Missing client_number | `{ email: "admin@tmc.com", password: "admin123" }` | 400, "clientNumber, email (or empcode) and password are required" |
| AUTH-06 | Inactive user | User with is_active=false | 401, "Invalid credentials" |
| AUTH-07 | Locked account (within lockout) | User with lockedUntil > now | 423, "Account locked. Try again in X minutes." |
| AUTH-08 | Locked account (lockout expired) | User with lockedUntil < now | 200, successful login (lockout cleared) |

### 4.2 Account Lockout

| ID | Test Case | Steps | Expected Result |
|----|-----------|-------|-----------------|
| AUTH-09 | Progressive lockout | 5 failed login attempts | failedAttempts increments 1-5, account locked on 5th |
| AUTH-10 | Lockout duration | Login during lockout | 423 with minutes remaining |
| AUTH-11 | Lockout reset on success | Correct password after lockout expires | failedAttempts=0, lockedUntil=null |
| AUTH-12 | Admin password reset clears lockout | Admin resets locked user's password | failedAttempts=0, lockedUntil=null |

### 4.3 Session Management

| ID | Test Case | Steps | Expected Result |
|----|-----------|-------|-----------------|
| AUTH-13 | Token in HttpOnly cookie | Login, inspect response headers | Set-Cookie: tmcai_token=...; HttpOnly; SameSite=Lax |
| AUTH-14 | Token validation | GET /api/user/me with valid cookie | 200, user profile returned |
| AUTH-15 | Expired token | Request with token past 72h | 401, "Invalid or expired token" |
| AUTH-16 | Revoked token | Request after logout | 401, "Invalid or expired token" |
| AUTH-17 | Bearer token fallback | Authorization: Bearer {token} | 200, same as cookie auth |
| AUTH-18 | Logout | POST /api/user/logout | Session marked isRevoked=true, cookie cleared |

### 4.4 Password Management

| ID | Test Case | Input | Expected Result |
|----|-----------|-------|-----------------|
| AUTH-19 | Change password (valid) | currentPassword + newPassword (6+ chars) | 200, password updated |
| AUTH-20 | Change password (wrong current) | Wrong currentPassword | 400, "Current password is incorrect" |
| AUTH-21 | Change password (too short) | newPassword < 6 chars | 400, "Password must be at least 6 characters" |
| AUTH-22 | Admin reset password | POST /api/user/users/:empcode/reset-password | 200, 8-char temp password returned |

### 4.5 Admin User Management

| ID | Test Case | Input | Expected Result |
|----|-----------|-------|-----------------|
| AUTH-23 | Create user (valid) | Full user data with roleId | 201, user created |
| AUTH-24 | Create user (missing fields) | Missing empcode | 400, validation error |
| AUTH-25 | Create user (duplicate empcode) | Existing empcode | 409, "User with this empcode or email already exists" |
| AUTH-26 | Create user (non-admin) | Regular user attempts | 403, "Admin access required" |
| AUTH-27 | Create user (short password) | Password < 6 chars | 400, "Password must be at least 6 characters" |

---

## 5. Chat & RAG Pipeline Test Cases

### 5.1 Basic Chat

| ID | Test Case | Input | Expected Result |
|----|-----------|-------|-----------------|
| CHAT-01 | Valid chat request | `{ message: "hello", provider: "gemini-flash" }` | SSE stream with chunks + meta + done |
| CHAT-02 | Missing message | `{ provider: "gemini" }` | 400, "message and provider are required" |
| CHAT-03 | Missing provider | `{ message: "test" }` | 400, "message and provider are required" |
| CHAT-04 | Conversational query | "hello", "how are you" | Short-circuit to Flash, no data retrieval |
| CHAT-05 | Data query | "how many active projects?" | Full pipeline: search + context + AI response |
| CHAT-06 | Dashboard query | "show me a project dashboard" | Intent: dashboard, Flash used, HTML widget in response |

### 5.2 RAG Pipeline

| ID | Test Case | Input | Expected Result |
|----|-----------|-------|-----------------|
| RAG-01 | Hybrid search returns results | Query matching indexed content | Vector + TF-IDF results merged via RRF |
| RAG-02 | No results found | Query about unindexed topic | Fallback to TF-IDF, low confidence directive |
| RAG-03 | Re-ranking applied | Complex analysis query | Cross-encoder scores chunks, top K selected |
| RAG-04 | Re-ranking skipped | Simple list query | Top N from hybrid search used directly |
| RAG-05 | Context trimming | Large result set | Trimmed to provider-specific limit (20-30K chars) |
| RAG-06 | Content sanitization | Content with injection patterns | Injection text replaced with "[content removed by security filter]" |
| RAG-07 | Low confidence | Top score < 0.4 | Abstention directive added to prompt |

### 5.3 Request Deduplication

| ID | Test Case | Steps | Expected Result |
|----|-----------|-------|-----------------|
| DEDUP-01 | Duplicate within 30s | Send same message+provider twice | Second request returns cached response instantly |
| DEDUP-02 | Different message | Different message, same provider | Full pipeline runs |
| DEDUP-03 | Same message, different provider | Same message, different provider | Full pipeline runs (different dedup key) |
| DEDUP-04 | After TTL expires | Wait 30s, resend | Full pipeline runs |

### 5.4 SSE Streaming

| ID | Test Case | Steps | Expected Result |
|----|-----------|-------|-----------------|
| SSE-01 | Status events | During processing | "Understanding your question...", "Searching data...", etc. |
| SSE-02 | Chunk events | During AI streaming | Incremental text chunks |
| SSE-03 | Meta event | After completion | elapsed, tokens, dataLastUpdated, conversationId |
| SSE-04 | Done event | After meta | `{ type: "done" }` |
| SSE-05 | Error event | Provider error | `{ type: "error", content: "..." }` |

### 5.5 Provider Routing

| ID | Test Case | Provider + Intent | Expected Result |
|----|-----------|-------------------|-----------------|
| ROUTE-01 | Gemini + dashboard | gemini + dashboard intent | Auto-routed to Flash |
| ROUTE-02 | Gemini + analysis | gemini + detailed_analysis intent | Uses Pro |
| ROUTE-03 | Gemini Flash explicit | gemini-flash + any | Always Flash |
| ROUTE-04 | Claude | claude + any | Claude Sonnet 4 |
| ROUTE-05 | OpenAI | openai + any | GPT-4o |
| ROUTE-06 | Groq | groq + any | Llama 4 |
| ROUTE-07 | OpenRouter | openrouter + any | Auto-fallback models |

---

## 6. PII Masking Test Cases

| ID | Test Case | Input Context | Expected Result |
|----|-----------|---------------|-----------------|
| PII-01 | Person names detected | "Ahmed Khan is the project lead" | "[PERSON_1] is the project lead" in AI prompt |
| PII-02 | Multiple entities | "Ahmed Khan and Sara Ali discussed..." | "[PERSON_1] and [PERSON_2] discussed..." |
| PII-03 | Stream unmasking | AI response contains "[PERSON_1]" | Client receives "Ahmed Khan" |
| PII-04 | PII cache hit | Same context within 2 minutes | NER call skipped, cached mapping used |
| PII-05 | PII cache miss | New context text | Full NER call to Gemini Flash |
| PII-06 | PII disabled | PII_ENABLED=false | No masking, no NER calls |
| PII-07 | Buffer flush | End of stream | Remaining PII tokens in buffer are flushed and unmasked |
| PII-08 | Audit log masked | After query completion | audit_log.masked_query contains masked version |

---

## 7. Conversation Management Test Cases

| ID | Test Case | Steps | Expected Result |
|----|-----------|-------|-----------------|
| CONV-01 | Auto-create conversation | Chat without conversationId (authenticated) | New conversation created, ID returned in meta |
| CONV-02 | Append to conversation | Chat with existing conversationId | Message added to existing conversation |
| CONV-03 | Anonymous chat | Chat without authentication | No conversation created, chat still works |
| CONV-04 | List conversations | GET /api/conversations | User's conversations, most recent first |
| CONV-05 | Get conversation | GET /api/conversations/:id | Conversation with all messages |
| CONV-06 | Cannot see other user's conversations | GET /api/conversations/:otherId | 404 or empty (user isolation) |
| CONV-07 | Rename conversation | PATCH /api/conversations/:id { title: "New name" } | Title updated |
| CONV-08 | Archive conversation | DELETE /api/conversations/:id | isArchived=true (soft delete) |
| CONV-09 | Message persistence | Send message, reload page | Messages still available |
| CONV-10 | Context continuity | "What about their revenue?" after project query | AI resolves "their" using conversation history |

---

## 8. User Profile Test Cases

| ID | Test Case | Steps | Expected Result |
|----|-----------|-------|-----------------|
| PROF-01 | Get profile | GET /api/profile (authenticated) | Returns jobDescription, aboutMe, instructions, tonePreference |
| PROF-02 | Update about_me | PUT /api/profile { aboutMe: "I manage..." } | Updated successfully |
| PROF-03 | Update instructions | PUT /api/profile { instructions: "Always show PKR" } | Updated successfully |
| PROF-04 | Update tone | PUT /api/profile { tonePreference: "executive" } | Updated successfully |
| PROF-05 | Invalid tone | PUT /api/profile { tonePreference: "rude" } | 400, "Invalid tone" |
| PROF-06 | JD not editable | PUT /api/profile { jobDescription: "hacked" } | jobDescription field ignored |
| PROF-07 | Profile affects AI | Set instructions + ask question | AI response reflects custom instructions |
| PROF-08 | Tone affects AI | Set tone=executive + ask question | Response uses crisp, data-driven language |
| PROF-09 | Unauthenticated | GET /api/profile without auth | 401 |

---

## 9. Scheduled Tasks Test Cases

| ID | Test Case | Steps | Expected Result |
|----|-----------|-------|-----------------|
| SCHED-01 | Create task | POST /api/schedules with valid data | 201, task created, cron job registered |
| SCHED-02 | Invalid cron | POST /api/schedules { cronExpression: "invalid" } | 400, "Invalid cron expression" |
| SCHED-03 | Missing fields | POST /api/schedules { title only } | 400, "title, prompt, and cronExpression are required" |
| SCHED-04 | List tasks | GET /api/schedules | User's tasks, newest first |
| SCHED-05 | Update task | PATCH /api/schedules/:id { title: "New" } | Updated, cron re-registered |
| SCHED-06 | Delete task | DELETE /api/schedules/:id | Cron job stopped, record deleted |
| SCHED-07 | Run on-demand | POST /api/schedules/:id/run | Task executes immediately |
| SCHED-08 | Task not found | POST /api/schedules/999/run | 400, "Task not found" |
| SCHED-09 | Cannot modify other user's task | PATCH /api/schedules/:otherUserId | No effect (updateMany with userId filter) |
| SCHED-10 | Email notification | Task executes with notifySelf=true | Email sent to user's email |
| SCHED-11 | Multiple recipients | notifyEmail = "a@tmc.com, b@tmc.com" | Emails sent to both + self if notifySelf |
| SCHED-12 | Task failure | AI or email error during execution | lastError updated, no crash |
| SCHED-13 | Server restart | Restart server with active tasks | initScheduler re-registers all active cron jobs |

---

## 10. Index & Data Refresh Test Cases

| ID | Test Case | Steps | Expected Result |
|----|-----------|-------|-----------------|
| IDX-01 | Health check | GET /api/health | Returns index status, RAG config, PII status, Drive status |
| IDX-02 | Index status | GET /api/index/status | loaded, sectionCount, charCount, vectorCount |
| IDX-03 | Manual refresh | POST /api/index/refresh | Re-fetches Drive data, re-chunks, updates vectors |
| IDX-04 | Auto-refresh | Wait 5 minutes | Automatic refresh triggered |
| IDX-05 | Drive unavailable | Drive auth expired | Falls back to local cached file |
| IDX-06 | Stale chunk purge | Remove section from Drive, refresh | Old vectors removed, no ghost data |
| IDX-07 | No re-embedding | Refresh with unchanged content | Chunks with same content_hash skip embedding |

---

## 11. Security Test Cases

| ID | Test Case | Steps | Expected Result |
|----|-----------|-------|-----------------|
| SEC-01 | Rate limiting | 21 requests in 60 seconds | 20 succeed, 21st returns 429 |
| SEC-02 | CORS | Request from unauthorized origin | Blocked by CORS |
| SEC-03 | Security headers | Any response | X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, Permissions-Policy |
| SEC-04 | Prompt injection in data | Content with "ignore all instructions" | Stripped by content sanitizer |
| SEC-05 | SQL injection in login | email: "'; DROP TABLE users;--" | No effect (Prisma parameterized queries) |
| SEC-06 | XSS in message | message: "<script>alert(1)</script>" | Treated as text, not executed |
| SEC-07 | Cookie not accessible via JS | document.cookie | tmcai_token not visible (HttpOnly) |
| SEC-08 | Encrypted config values | Read system_config.gemini_api_key | Value is AES-256-GCM encrypted in DB |
| SEC-09 | Bulk config read | getAllConfig() | Sensitive values returned as "********" |
| SEC-10 | Admin endpoint protection | Non-admin calls POST /api/user/users | 403, "Admin access required" |
| SEC-11 | Abort on disconnect | Close browser tab during processing | Pipeline stops, no wasted compute |
| SEC-12 | Request body size | POST with > 10MB body | Rejected by express.json({ limit: '10mb' }) |

---

## 12. Performance Benchmarks

### 12.1 Response Time Targets

| Query Type | Target | Actual (Observed) |
|-----------|--------|-------------------|
| Conversational ("hello") | < 2s | 1-2s |
| Quick answer ("how many projects?") | < 10s | 5-8s |
| List/table query | < 15s | 8-12s |
| Detailed analysis | < 30s | 15-25s |
| Dashboard widget | < 40s | 20-35s |

### 12.2 Pipeline Stage Timing

| Stage | Target | Notes |
|-------|--------|-------|
| Intent + Rewrite (parallel) | < 3s | Promise.all with Flash |
| Hybrid Search | < 2s | In-memory vectors + TF-IDF |
| Re-ranking | < 3s | Flash cross-encoder (skipped for simple) |
| PII masking | < 3s | Cached: ~0ms |
| LLM streaming (first token) | < 5s | Provider-dependent |

### 12.3 Throughput

| Metric | Value |
|--------|-------|
| Rate limit | 20 requests/minute per user |
| Concurrent users | Limited by PostgreSQL connections and AI API quotas |
| Dedup cache size | 50 entries max |
| PII cache size | 50 entries max |
| Request timeout | 120 seconds |

### 12.4 Data Scale

| Metric | Current Value |
|--------|---------------|
| Documents | ~12 |
| Chunks | ~400 |
| Vectors | ~398 (3072 dimensions) |
| Embedding model | Gemini embedding-001 |
| Vector search | In-memory cosine similarity |

---

## 13. Known Limitations

### 13.1 Technical Limitations

| Limitation | Impact | Mitigation |
|-----------|--------|------------|
| Embeddings stored as JSON, not pgvector | In-memory vector search, not scalable beyond ~10K chunks | pgvector migration planned (Phase 3) |
| Vector search is in-memory | High memory usage for large datasets | Works well for current ~400 chunks |
| No background indexing | Refresh blocks the main thread briefly | BullMQ planned for Phase 3 |
| Estimated next_run_at | Placeholder calculation (now + 1hr) | node-cron does not expose next fire time |
| PII detection depends on AI | May miss or over-detect entities | Cached to reduce cost; no hardcoded patterns means fewer false positives |
| No password complexity rules | Only minimum length (6 chars) enforced | Add complexity rules if needed |
| Single server instance | No horizontal scaling | Stateless design allows future scaling |

### 13.2 Functional Limitations

| Limitation | Impact | Planned |
|-----------|--------|---------|
| User memory not active | AI-extracted facts schema ready but extraction not implemented | Phase 3 |
| No role-based data filtering | All authenticated users see all data | Phase 3 (chunk-level ACL) |
| JD sync is manual | No automated HR sync endpoint yet | Future endpoint planned |
| Scheduler uses TF-IDF only | Scheduled tasks do not use full RAG pipeline | Could be enhanced |
| No eval suite | Quality changes not automatically measured | Phase 3 (golden Q&A pairs) |
| Single data source | Only Google Drive (TMC_Drive_Index.md) | BigQuery, Vertex AI planned |

---

## 14. Acceptance Criteria

### 14.1 Multi-Tenancy

- [ ] Tenants table stores client_number as PK
- [ ] All tables include client_number column
- [ ] Login requires client_number + email/empcode + password
- [ ] Session carries clientNumber in TokenUser
- [ ] All service queries filter by client_number
- [ ] Users in tenant A cannot see data from tenant B
- [ ] Duplicate empcode/email allowed across tenants but not within same tenant
- [ ] Seed creates "TMC" tenant with all default data

### 14.2 Login Page

- [ ] Login page renders with Client Number, Email, and Password fields
- [ ] Unauthenticated users are redirected to /login
- [ ] Successful login redirects to chat
- [ ] Failed login shows error message
- [ ] Auth state persists across page refreshes
- [ ] Logout clears state and redirects to /login
- [ ] Dark theme matches main app

### 14.3 Authentication

- [ ] Users can log in with client_number + email + password or client_number + empcode + password
- [ ] Failed login shows remaining attempts
- [ ] Account locks after 5 failures for 30 minutes
- [ ] Sessions persist across page refreshes (HttpOnly cookie)
- [ ] Logout invalidates the session immediately
- [ ] Admin can create users and reset passwords
- [ ] Users can change their own password

### 14.4 Chat

- [ ] Chat works for both authenticated and anonymous users
- [ ] SSE stream delivers status updates, chunks, meta, and done events
- [ ] Conversational queries respond in under 2 seconds
- [ ] Data queries return relevant, sourced information
- [ ] Dashboard queries generate interactive HTML widgets
- [ ] Duplicate requests within 30s return cached responses
- [ ] Closing the browser tab stops server-side processing

### 14.5 RAG Pipeline

- [ ] Hybrid search combines vector and keyword results
- [ ] Re-ranking improves relevance for complex queries
- [ ] Low-confidence queries include uncertainty language
- [ ] Context is trimmed to provider-specific limits
- [ ] Prompt injection patterns in data are sanitized

### 14.6 PII Protection

- [ ] Personal names, emails, and other PII are masked before reaching the AI
- [ ] Masked entities are restored in the streamed response
- [ ] PII is cached to avoid redundant NER calls
- [ ] Audit logs store only PII-masked queries

### 14.7 Conversations

- [ ] Conversations are isolated per user
- [ ] Chat history persists across sessions
- [ ] AI uses last 4 messages for context continuity
- [ ] Users can rename and archive conversations

### 14.8 Profiles

- [ ] Users can set about_me, instructions, and tone_preference
- [ ] Job Description is read-only for users
- [ ] Profile settings visibly affect AI responses

### 14.9 Scheduled Tasks

- [ ] Tasks execute at the specified cron schedule
- [ ] Email notifications are sent to configured recipients
- [ ] Tasks can be run on-demand
- [ ] Task failures are logged without crashing the server
- [ ] Active tasks are re-registered on server restart
