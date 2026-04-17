# TMC AI Intelligence -- Security Assurance

**Last Updated**: 2026-03-28

## Overview

This document describes the security architecture, threat model, and defensive measures implemented in the TMC AI Intelligence platform. The system handles sensitive business data (clients, projects, HR, financials) and interacts with multiple AI providers, requiring multi-layered security.

---

## Table of Contents

1. [Threat Model](#1-threat-model)
2. [Tenant Isolation](#2-tenant-isolation)
3. [Authentication Security](#3-authentication-security)
4. [Session Management](#4-session-management)
5. [Data Protection](#5-data-protection)
6. [API Security](#6-api-security)
7. [Prompt Injection Defense](#7-prompt-injection-defense)
8. [PII Protection](#8-pii-protection)
9. [Secret Management](#9-secret-management)
10. [Security Headers](#10-security-headers)
11. [Audit & Logging](#11-audit--logging)
12. [HRAPR Pattern Reference](#12-hrapr-pattern-reference)
13. [Security Checklist](#13-security-checklist)

---

## 1. Threat Model

### 1.1 Threat Actors

| Actor | Description | Risk Level |
|-------|-------------|------------|
| External attacker | Unauthenticated user attempting unauthorized access | High |
| Malicious insider | Authenticated user attempting privilege escalation or data exfiltration | Medium |
| Cross-tenant attacker | Authenticated user in tenant A attempting to access tenant B's data | High |
| Data poisoning | Adversarial content in business documents (prompt injection) | Medium |
| AI provider | Third-party AI services receiving business data | Medium |
| Network observer | Man-in-the-middle on network traffic | Low (HTTPS mitigates) |

### 1.2 Assets to Protect

| Asset | Protection Mechanism |
|-------|---------------------|
| User credentials | bcrypt hashing, never stored in plain text |
| Session tokens | HttpOnly cookies, 72h expiry, revocation |
| API keys | AES-256-GCM encryption in system_config |
| Business data | CORS, authentication, rate limiting, tenant isolation |
| Tenant data | client_number scoping on all queries, composite keys |
| Personal information (PII) | AI-powered masking before AI provider, masked audit logs |
| System prompt | Content sanitizer prevents extraction |
| AI responses | PII unmasking only at stream delivery |

### 1.3 Attack Vectors

| Vector | Defense | Status |
|--------|---------|--------|
| Brute-force login | Account lockout (5 attempts / 30 min) | Implemented |
| Session hijacking | HttpOnly + Secure + SameSite cookies | Implemented |
| CSRF | SameSite=Lax cookies, CORS origin restriction | Implemented |
| XSS | Security headers (X-XSS-Protection, X-Content-Type-Options) | Implemented |
| Clickjacking | X-Frame-Options: DENY | Implemented |
| SQL injection | Prisma ORM (parameterized queries) | Implemented |
| Prompt injection | Content sanitizer + structural pattern matching | Implemented |
| API abuse | Rate limiting (20 req/min per user) | Implemented |
| Data leakage to AI | PII masking before AI provider calls | Implemented |
| Secret exposure | AES-256-GCM encrypted config, no secrets in responses | Implemented |
| Duplicate request abuse | Request deduplication cache (30s TTL) | Implemented |
| Resource exhaustion | Request timeout (120s), abort on disconnect | Implemented |
| Cross-tenant data access | client_number on all tables, scoped queries in services | Implemented |
| Tenant impersonation | client_number validated at login, carried in session | Implemented |

---

## 2. Tenant Isolation

### 2.1 Multi-Tenant Architecture

The system implements application-level multi-tenancy using `client_number` as the tenant identifier across all 12 database tables.

| Property | Implementation |
|----------|---------------|
| Tenant identifier | `client_number` VARCHAR(20) on all tables |
| Tenant registry | `tenants` table with `client_number` as PK |
| Config isolation | system_config has composite PK: (client_number, key) |
| User isolation | Unique constraints: (client_number, empcode), (client_number, email) |
| Role isolation | Unique constraint: (client_number, name) |
| Query scoping | All service queries include `WHERE client_number = ?` |
| Session binding | `clientNumber` stored in TokenUser, propagated to all services |

### 2.2 Tenant Validation at Login

```
Login Request { clientNumber, email, password }
    |
1. Look up tenant by clientNumber
    |   [Not found or inactive] -> 401 "Tenant not found or inactive"
    |
2. Find user by (client_number + email/empcode)
    |   [Not found] -> 401 "Invalid credentials"
    |
3. Validate password (bcrypt)
    |
4. Create session with clientNumber in TokenUser
    |
All subsequent requests use session.clientNumber for data scoping
```

### 2.3 Cross-Tenant Protection Layers

1. **Login validation**: Tenant must exist and be active
2. **Session binding**: clientNumber is set at login and cannot be changed
3. **Service-layer scoping**: Every database query includes `client_number` filter
4. **Composite unique constraints**: Prevent data collision across tenants
5. **No cross-tenant API**: No endpoint accepts arbitrary client_number; it always comes from session

### 2.4 Data Isolation Matrix

| Data Type | Isolation Mechanism |
|-----------|-------------------|
| System config | Composite PK (client_number, key) |
| Roles | Unique (client_number, name) |
| Users | Unique (client_number, empcode), Unique (client_number, email) |
| Sessions | client_number column, linked to user's tenant |
| Documents | client_number column |
| Chunks | client_number column |
| Conversations | client_number column + user_id |
| Messages | client_number column |
| User memory | client_number column |
| Audit logs | client_number column |
| Scheduled tasks | client_number column |

---

## 3. Authentication Security

### 3.1 Password Security

| Property | Implementation |
|----------|---------------|
| Hashing algorithm | bcrypt |
| Salt rounds | 10 |
| Minimum length | 6 characters |
| Storage | `password_hash` column in users table |
| Comparison | `bcrypt.compare()` (timing-safe) |

**Code location**: `server/src/services/authService.ts`

### 3.2 Login Flow Security

```
Client (LoginPage)                  Server
  |                                    |
  |-- POST /api/user/login ----------->|
  |   { clientNumber, email/empcode,   |
  |     password }                     |
  |                                    |-- Validate tenant (client_number active?)
  |                                    |-- Find user (client_number + email/empcode)
  |                                    |-- Check: is_active? locked_until?
  |                                    |-- bcrypt.compare(password, hash)
  |                                    |
  |                                    |   [If invalid]:
  |                                    |   - Increment failed_attempts
  |                                    |   - If >= 5: set locked_until
  |                                    |   - Return 401 (or 423 if locked)
  |                                    |
  |                                    |   [If valid]:
  |                                    |   - Generate 32-byte random token
  |                                    |   - Create session (with clientNumber)
  |                                    |   - Reset failed_attempts = 0
  |                                    |   - Set HttpOnly cookie
  |<-- Set-Cookie + 200 --------------|
  |-- AuthContext stores user,         |
  |   redirects to chat               |
```

### 3.3 Account Lockout

| Parameter | Value |
|-----------|-------|
| Max failed attempts | 5 |
| Lockout duration | 30 minutes |
| Lockout scope | Per-user (stored on user record) |
| Reset conditions | Successful login, admin password reset |
| HTTP status when locked | 423 Locked |

The lockout state is stored directly on the `users` table (`failed_attempts`, `locked_until`), ensuring persistence across server restarts.

### 3.4 Identifier Flexibility

Login accepts `clientNumber` plus either `email` or `empcode` as the identifier:
```typescript
const user = await prisma.user.findFirst({
  where: {
    clientNumber,
    OR: [
      { email: identifier },
      { empcode: identifier },
    ],
  },
});
```

This prevents username enumeration since the same "Invalid credentials" error is returned for both non-existent users and wrong passwords.

---

## 4. Session Management

### 4.1 Token Generation

| Property | Value |
|----------|-------|
| Method | `crypto.randomBytes(32).toString('hex')` |
| Length | 64 hexadecimal characters |
| Entropy | 256 bits |
| Storage | `sessions` table in PostgreSQL |

### 4.2 Cookie Configuration

| Property | Value | Purpose |
|----------|-------|---------|
| Name | `tmcai_token` | Session identifier |
| HttpOnly | `true` | Prevents JavaScript access (XSS mitigation) |
| Secure | `true` (production) | HTTPS-only transmission |
| SameSite | `Lax` | CSRF protection (allows same-site navigation) |
| Max-Age | 72 hours (259200 seconds) | Session duration |

### 4.3 Session Validation

Every authenticated request:
1. Extract token from `tmcai_token` cookie or `Authorization: Bearer` header
2. Look up session by token (database query)
3. Verify: session exists AND not revoked AND not expired AND user is active
4. Attach user info to `req.user` (id, clientNumber, empcode, name, email, department, role, isAdmin, allowedSources, allowedDepartments)

### 4.4 Session Revocation

- **Logout**: Sets `session.isRevoked = true`
- **Admin password reset**: Does not automatically revoke sessions (could be enhanced)
- **User deactivation**: `is_active = false` causes all session validations to fail

### 4.5 Session Metadata

Each session records:
- `user_agent`: Browser/client identifier (truncated to 500 chars)
- `ip_address`: Client IP address (truncated to 50 chars)
- Useful for audit and anomaly detection

---

## 5. Data Protection

### 5.1 Encryption at Rest

**system_config table** (HRAPR pattern):

| Property | Value |
|----------|-------|
| Algorithm | AES-256-GCM |
| Key source | `ENCRYPTION_KEY` environment variable (first 32 bytes UTF-8) |
| IV | 16 bytes random per encryption |
| Auth tag | 16 bytes (GCM integrity verification) |
| Format | `{iv_base64}:{authTag_base64}:{ciphertext_base64}` |

**What is encrypted**:
- AI provider API keys (Gemini, Anthropic, OpenAI, Groq, OpenRouter)
- Google OAuth credentials (client_id, client_secret)
- Any value with `is_sensitive = true`

**What is NOT encrypted** (plain text):
- Application settings (app_name, rag_enabled, pii_enabled, max_tokens, etc.)
- Non-sensitive configuration values

**Code location**: `server/src/services/configService.ts`

### 5.2 Password Hashing

All user passwords are hashed with bcrypt (10 rounds) before storage. Plain-text passwords are never stored or logged.

### 5.3 Data in Transit

- HTTPS enforced in production (Secure cookie flag)
- CORS restricts origins to `CLIENT_URL`
- SSE streams are over the same HTTPS connection

### 5.4 Sensitive Data Exposure Prevention

| Measure | Details |
|---------|---------|
| `getAllConfig()` | Returns "********" for sensitive values |
| Audit logs | Store PII-masked queries, never raw user input |
| Error responses | Generic error messages, no stack traces in production |
| API responses | Never include password hashes, tokens, or internal IDs unnecessarily |

---

## 6. API Security

### 6.1 Rate Limiting

| Parameter | Value |
|-----------|-------|
| Window | 60 seconds |
| Max requests | 20 per window |
| Key strategy | User ID (authenticated) or "anonymous" (unauthenticated) |
| Headers | Standard rate limit headers (RateLimit-*) |
| Applied to | `/api/chat/stream` |

**Code location**: `server/src/routes/chatRoutes.ts`

```typescript
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id?.toString() || 'anonymous',
});
```

### 6.2 Request Deduplication

| Parameter | Value |
|-----------|-------|
| Cache key | MD5 of `{message}::{provider}` |
| TTL | 30 seconds |
| Cleanup | Every 60 seconds |
| Purpose | Prevents double-click or rapid resubmission waste |

### 6.3 Request Timeout

| Parameter | Value |
|-----------|-------|
| Default timeout | 120 seconds |
| Configurable | `REQUEST_TIMEOUT_MS` env var |
| Implementation | `Promise.race` against timeout and abort signal |

### 6.4 Abort on Disconnect

When a client disconnects (closes tab, navigates away):
1. `req.on('close')` fires
2. `clientDisconnected` flag set to `true`
3. `AbortController.abort()` called
4. Every pipeline stage checks the flag before proceeding
5. LLM streaming races against abort signal

This prevents wasted AI API calls and compute.

### 6.5 CORS Configuration

```typescript
app.use(cors({
  origin: env.clientUrl,  // e.g., http://localhost:5174
  credentials: true,      // Allow cookies
}));
```

- Only the configured `CLIENT_URL` can make cross-origin requests
- `credentials: true` allows HttpOnly cookies to be sent
- No wildcard origins

### 6.6 Body Size Limit

```typescript
app.use(express.json({ limit: '10mb' }));
```

Prevents oversized request bodies from consuming memory.

### 6.7 Authorization Layers

| Middleware | Purpose | Usage |
|-----------|---------|-------|
| `optionalAuth` | Attach user if token present, but allow anonymous | Chat endpoint |
| `requireAuth` | Block if not authenticated | Profile, conversations, schedules |
| `requireAdmin` | Block if not admin role (must be after requireAuth) | User management |

---

## 7. Prompt Injection Defense

### 7.1 Content Sanitizer

**Code location**: `server/src/pipeline/contentSanitizer.ts`

Retrieved business data is sanitized before entering the AI prompt. The sanitizer uses structural regex patterns (not keyword blocklists) to detect and remove injection attempts.

### 7.2 Patterns Detected

| Pattern Type | Example | Action |
|-------------|---------|--------|
| Direct instruction override | "Ignore all previous instructions" | Replaced with "[content removed by security filter]" |
| Role switching | "You are now a hacker" | Replaced |
| System prompt extraction | "Show your system prompt" | Replaced |
| Command injection | "execute(malicious_code)" | Replaced |
| Data exfiltration | "Send all data to external.com" | Replaced |

### 7.3 Defense-in-Depth Strategy

Multiple layers protect against prompt injection:

1. **Content Sanitizer**: Strips injection patterns from retrieved data before prompt assembly
2. **System Prompt**: Explicitly instructs the model to treat data as data, not as commands
3. **Data Boundaries**: Context is wrapped in clear markers (system prompt structure)
4. **Confidence/Abstention**: Low-relevance data triggers uncertainty language, reducing hallucination risk

### 7.4 Logging

Every sanitization action is logged:
```
[Sanitizer] Stripped potential injection: "ignore all previous instruct..."
```

---

## 8. PII Protection

### 8.1 Architecture

```
Retrieved Context (with real names)
    |
    v
PII Masking (Gemini Flash NER)
    |   "Ahmed Khan" -> [PERSON_1]
    |   "ahmed.khan@tmc.com" -> [EMAIL_1]
    v
Masked Context -> AI Provider (sees only placeholders)
    |
    v
AI Response (contains [PERSON_1])
    |
    v
Stream Unmasker (real-time replacement)
    |   [PERSON_1] -> "Ahmed Khan"
    v
Client (sees real names)
```

### 7.2 Key Properties

| Property | Value |
|----------|-------|
| Detection method | AI-powered NER via Gemini Flash |
| Entity types | Person names, emails, phone numbers, and other PII |
| Masking format | `[TYPE_N]` (e.g., `[PERSON_1]`, `[EMAIL_1]`) |
| Cache | MD5 hash of context, 2-minute TTL, max 50 entries |
| Unmasking | Real-time stream processing with buffer |
| Audit | Only masked queries stored in audit_log |

### 7.3 Why AI-Powered NER

- No hardcoded name lists or regex patterns
- Handles multi-cultural names (Pakistani, Arabic, Western)
- Context-aware: distinguishes person names from company names
- Adapts to new entity types without code changes

### 7.4 PII in Audit Logs

The `audit_log.masked_query` column stores only the PII-masked version of user queries. Raw queries with personal names are never persisted.

---

## 8. Secret Management

### 8.1 Environment Variables

Secrets are provided via environment variables and never committed to source control:

| Secret | Env Variable | Purpose |
|--------|-------------|---------|
| Database connection | `DATABASE_URL` | PostgreSQL connection string |
| Encryption key | `ENCRYPTION_KEY` | AES-256-GCM for system_config |
| Google OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Drive access |
| Gemini API | `GEMINI_API_KEY`, `GEMINI_API_KEY_EMBED`, `GEMINI_API_KEY_PIPELINE` | AI + embeddings |
| Anthropic API | `ANTHROPIC_API_KEY` | Claude |
| OpenAI API | `OPENAI_API_KEY` | GPT-4o |
| Groq API | `GROQ_API_KEY` | Llama 4 |
| OpenRouter API | `OPENROUTER_API_KEY` | Free models |

### 8.2 Key Separation

AI provider API keys are separated by function to enable independent rotation and rate limit management:
- `GEMINI_API_KEY`: Default for all Gemini calls
- `GEMINI_API_KEY_EMBED`: Dedicated key for embedding generation
- `GEMINI_API_KEY_PIPELINE`: Dedicated key for query rewriting, re-ranking, PII detection

Each falls back to `GEMINI_API_KEY` if not set.

### 8.3 Database-Stored Secrets

API keys can optionally be stored in `system_config` with `is_sensitive = true`:
- Encrypted with AES-256-GCM before storage
- Decrypted on read via `configService.getConfig()`
- `configService.getConfigOrEnv()` checks DB first, falls back to env var
- Bulk read (`getAllConfig()`) returns "********" for sensitive values

### 8.4 Secret Rotation

To rotate an API key:
1. Update the environment variable
2. Restart the server (for env-based keys)
3. Or update via `configService.setConfig(key, newValue, true)` (for DB-based keys, no restart needed)

---

## 9. Security Headers

Applied to every response via Express middleware in `server/src/app.ts`:

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Content-Type-Options` | `nosniff` | Prevents MIME type sniffing |
| `X-Frame-Options` | `DENY` | Prevents clickjacking (no iframe embedding) |
| `X-XSS-Protection` | `1; mode=block` | Enables browser XSS filter |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Disables unnecessary browser APIs |

### 9.1 Future Enhancements

| Header | Recommendation |
|--------|---------------|
| `Content-Security-Policy` | Add CSP to restrict script sources |
| `Strict-Transport-Security` | Add HSTS for production |
| `Referrer-Policy` | Add `strict-origin-when-cross-origin` |

---

## 10. Audit & Logging

### 10.1 What Is Logged

| Event | Where | PII Handling |
|-------|-------|-------------|
| Every chat query | `audit_log` table | Query is PII-masked |
| Login attempts | Console logs | No PII in logs |
| Sanitizer triggers | Console logs | Truncated to 60 chars |
| Scheduler execution | Console logs | Task ID and title only |
| Pipeline timing | Console logs | No PII |

### 10.2 Audit Log Schema

Each chat request produces one audit_log entry:

| Field | Content |
|-------|---------|
| user_id | Authenticated user ID (NULL for anonymous) |
| masked_query | PII-masked version of user's question |
| provider | AI provider used |
| chunks_retrieved | Number of data chunks sent to AI |
| top_score | Best retrieval similarity score |
| pii_entities_count | Number of PII entities masked |
| input_tokens | Estimated input tokens |
| output_tokens | Estimated output tokens |
| response_time_ms | Total response time |
| intent_type | Classified intent (conversational, quick_answer, etc.) |
| error | Error message if request failed |

### 10.3 Non-blocking Persistence

Both chat history and audit log saves are fire-and-forget (`.catch(() => {})`):
- Never delays the user's response
- Failures are silently ignored (logged to console)
- Ensures streaming is not interrupted by database issues

---

## 11. HRAPR Pattern Reference

The TMC AI system follows the HRAPR (HR Application) pattern established in the existing TMC application stack:

| Pattern | HRAPR Original | TMC AI Implementation |
|---------|---------------|----------------------|
| Config store | `system_config` table with encrypted values | Same: `system_config` with AES-256-GCM |
| Auth model | PIN-based with `login_config` + `access_tokens` | Evolved: password-based with `sessions` table |
| Token type | 64-char hex in HttpOnly cookie | Same: 64-char hex in HttpOnly cookie |
| Password hashing | bcrypt (10 rounds) | Same: bcrypt (10 rounds) |
| Account lockout | Failed attempt tracking | Same: 5 attempts / 30 min lockout |
| Role-based access | Role table with permissions | Same: roles with allowed_sources/departments |
| Encryption | AES-256-GCM for sensitive config | Same: AES-256-GCM with iv:authTag:ciphertext format |

### Key Evolution from HRAPR

1. **Simplified auth**: Single `sessions` table instead of separate `login_config` + `access_tokens`
2. **Password instead of PIN**: Full password support (min 6 chars) instead of numeric PINs
3. **Lockout on user record**: `failed_attempts` and `locked_until` stored on `users` table instead of `access_tokens`
4. **Session metadata**: `user_agent` and `ip_address` tracked per session

---

## 12. Security Checklist

### Authentication & Authorization
- [x] Passwords hashed with bcrypt (10 rounds)
- [x] Account lockout after 5 failed attempts
- [x] Session tokens are cryptographically random (256 bits)
- [x] HttpOnly cookies prevent XSS token theft
- [x] Secure flag enabled in production
- [x] SameSite=Lax prevents CSRF
- [x] Admin endpoints require admin role
- [x] Chat works with optional auth (no forced login)
- [ ] Password complexity rules (beyond min length)
- [ ] Session revocation on password change
- [ ] Multi-factor authentication

### Data Protection
- [x] AES-256-GCM encryption for sensitive config
- [x] PII masked before AI provider calls
- [x] Audit logs store only masked queries
- [x] Bulk config read hides sensitive values
- [x] No secrets in API responses
- [ ] Database-level encryption (PostgreSQL TDE)
- [ ] Row-level security (RLS) for department isolation

### API Security
- [x] Rate limiting (20 req/min)
- [x] Request deduplication (30s TTL)
- [x] Abort on disconnect
- [x] Request timeout (120s)
- [x] CORS origin restriction
- [x] Request body size limit (10MB)
- [x] Parameterized queries (Prisma ORM)
- [ ] API versioning
- [ ] Request signing

### AI Security
- [x] Content sanitizer for prompt injection
- [x] PII masking before provider calls
- [x] Confidence/abstention for low-quality results
- [x] Separate API keys per function
- [ ] Content Security Policy for AI-generated HTML widgets
- [ ] Output validation/sanitization

### Infrastructure
- [x] Security headers on all responses
- [x] Cookie security flags
- [x] Environment-based secret management
- [ ] HSTS header
- [ ] Content Security Policy
- [ ] Secrets management service (e.g., Vault)
- [ ] Network segmentation
- [ ] Container security scanning
