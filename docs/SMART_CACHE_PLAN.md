# TMC AI Intelligence — Self-Learning Intelligent Cache System

**Document Version**: 1.0
**Date**: 2026-03-31
**Author**: AI Architecture Team
**Status**: Design Review — Pending Approval

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State Analysis](#2-current-state-analysis)
3. [Problem Statement](#3-problem-statement)
4. [Proposed Solution](#4-proposed-solution)
5. [Architecture Design](#5-architecture-design)
6. [Database Schema](#6-database-schema)
7. [Component Details](#7-component-details)
8. [Cache Decision Logic](#8-cache-decision-logic)
9. [Safety & Privacy Rules](#9-safety--privacy-rules)
10. [Cost & Performance Projections](#10-cost--performance-projections)
11. [Implementation Plan](#11-implementation-plan)
12. [Risk Assessment](#12-risk-assessment)
13. [Monitoring & Metrics](#13-monitoring--metrics)
14. [Rollback Strategy](#14-rollback-strategy)

---

## 1. Executive Summary

### What
A self-learning cache system that observes user query patterns and automatically decides what to cache, for how long, and when to invalidate — without any manual configuration.

### Why
With 300 planned users, the current system would:
- Make ~630,000 AI calls/month (many identical queries from different users)
- Consume ~5.7 billion tokens/month
- Cost ~$640/month
- Average 10s response time for every query, even repeated ones

### Expected Outcome
- **89% reduction in AI calls** (630K → ~70K unique)
- **89% reduction in token cost** ($640 → ~$70/month)
- **90% of queries served in <200ms** (from cache instead of AI)
- **Zero manual maintenance** — system learns and adapts automatically

### Key Principle
The AI itself decides the caching strategy by analyzing real usage patterns. No hardcoded rules. The system gets smarter over time.

---

## 2. Current State Analysis

### 2.1 Current Caching Mechanisms

| Cache | Scope | TTL | Key | Limitation |
|-------|-------|-----|-----|-----------|
| Dedup cache | Per-user | 5 min | Exact message text + provider | Different wording = cache miss |
| Weather cache | Global | 15 min | City name | Only weather data |
| News cache | Global | 15 min | Category | Only news data |
| Email snapshot | Per-user | 10 min | User ID | Only welcome screen |
| Calendar snapshot | Per-user | 10 min | User ID | Only welcome screen |

### 2.2 Current Token Consumption (from testing)

| Metric | Value |
|--------|-------|
| Total requests tested | 152 |
| Total tokens consumed | 1,384,659 |
| Average tokens per query | ~9,110 |
| Average cost per query | $0.001 |
| Top 5 queries token share | 8.3% of total |
| Most expensive single query | 25,105 tokens (project dashboard) |

### 2.3 Query Distribution Pattern (observed)

| Query Type | % of Requests | Avg Tokens | Cacheable? |
|-----------|--------------|-----------|-----------|
| Dashboard/widget | 15% | 15,000 | YES — shared |
| Quick answer (counts) | 25% | 3,000 | YES — shared |
| Data analysis | 20% | 8,000 | YES — shared |
| List/table | 15% | 7,000 | YES — shared |
| Conversational | 10% | 100 | NO — personal |
| Email/calendar | 8% | 600 | NO — personal, real-time |
| Admin (logs/tokens) | 5% | 1,500 | NO — real-time |
| Edge cases | 2% | 5,000 | MAYBE — depends |

**~75% of queries are cacheable across users.**

---

## 3. Problem Statement

### 3.1 Repeated Queries Across Users

In a 300-user organization, many people ask the same questions:

```
Monday 9 AM:
  Manager A: "show project dashboard"           → AI: 10s, 15K tokens
  Manager B: "show project status"              → AI: 10s, 15K tokens (same data)
  Manager C: "project overview"                 → AI: 10s, 15K tokens (same data)
  Director:  "give me project summary"          → AI: 10s, 15K tokens (same data)
  VP:        "show all projects"                → AI: 10s, 15K tokens (same data)

  5 users, 5 AI calls, 75K tokens, 50 seconds total
  All got essentially the same answer.
```

With smart cache:
```
Monday 9 AM:
  Manager A: "show project dashboard"           → AI: 10s, 15K tokens (generates + caches)
  Manager B: "show project status"              → CACHE: <200ms, 0 tokens
  Manager C: "project overview"                 → CACHE: <200ms, 0 tokens
  Director:  "give me project summary"          → CACHE: <200ms, 0 tokens
  VP:        "show all projects"                → CACHE: <200ms, 0 tokens

  5 users, 1 AI call, 15K tokens, 10.8 seconds total
  80% cost reduction, 78% time reduction.
```

### 3.2 Fixed Cache Rules Don't Scale

| Problem | Example |
|---------|---------|
| Different wording = cache miss | "project dashboard" ≠ "show project status" |
| Same TTL for all queries | CEO name (never changes) cached same as risk data (changes daily) |
| Per-user isolation | User B doesn't benefit from User A's identical query |
| No cost awareness | Cheap 100-token query cached same as expensive 25K-token query |
| No frequency awareness | A query asked 100x/day and 1x/month get same treatment |

### 3.3 No Visibility Into Usage Patterns

Currently there is no mechanism to:
- Know which queries are asked most frequently
- Know which queries cost the most
- Know which data changes frequently vs rarely
- Adapt caching strategy based on actual usage
- Distinguish shared queries from personal queries

---

## 4. Proposed Solution

### 4.1 Three-Component Architecture

```
┌─────────────────────┐
│  Query Normalizer    │ ← Converts different phrasings to same cache key
└─────────┬───────────┘
          ↓
┌─────────────────────┐
│  Shared Cache        │ ← Stores responses keyed by normalized query
│  (with AI-set TTLs)  │    Shared across all users for non-personal queries
└─────────┬───────────┘
          ↓
┌─────────────────────┐
│  AI Cache Optimizer   │ ← Runs hourly, analyzes patterns, decides TTLs
│  (self-learning)      │    No manual configuration needed
└─────────────────────┘
```

### 4.2 How It Works — Step by Step

```
1. User sends query: "show project dashboard"

2. Query Normalizer:
   - Extracts domain: "projects"
   - Extracts intent: "dashboard"
   - Generates cache_key: "projects_dashboard"

3. Shared Cache Lookup:
   - Checks: shared_cache WHERE key = 'projects_dashboard' AND age < ttl
   - If HIT: return cached response instantly (<200ms, 0 tokens)
   - If MISS: continue to AI pipeline

4. Normal AI Pipeline:
   - BigQuery retrieval → AI generation → stream response
   - Save response to shared_cache with current TTL

5. Pattern Tracking:
   - Update query_patterns: frequency++, avg_tokens, last_seen

6. Background (hourly) — AI Cache Optimizer:
   - Reads all query_patterns
   - AI analyzes: "projects_dashboard asked 47x today, costs 15K tokens"
   - AI decides: "Cache for 30 minutes"
   - Updates recommended_ttl_ms in query_patterns
```

---

## 5. Architecture Design

### 5.1 Request Flow Diagram

```
                        User Query
                            │
                            ▼
                   ┌────────────────┐
                   │ Rate Limiter    │
                   └───────┬────────┘
                           │
                           ▼
                   ┌────────────────┐
                   │ Auth Check      │
                   └───────┬────────┘
                           │
                           ▼
                   ┌────────────────┐     ┌─────────────┐
                   │ Query           │────▶│ Is Personal? │
                   │ Normalizer      │     │ (email/cal/  │
                   └───────┬────────┘     │  memory/conv)│
                           │              └──────┬──────┘
                           │                     │
                           │              YES    │    NO
                           │              ┌──────┘
                           │              │
                           │              ▼
                           │     ┌──────────────┐
                           │     │ Skip Cache    │
                           │     │ Go to AI      │
                           │     └──────────────┘
                           │
                    NO (shared query)
                           │
                           ▼
                   ┌────────────────┐
                   │ Shared Cache    │
                   │ Lookup          │
                   └───────┬────────┘
                           │
                    ┌──────┴──────┐
                    │             │
                 HIT            MISS
                    │             │
                    ▼             ▼
            ┌──────────┐  ┌──────────────┐
            │ Return    │  │ BigQuery      │
            │ Cached    │  │ Retrieval     │
            │ Response  │  └──────┬───────┘
            │ (<200ms)  │         │
            └──────────┘         ▼
                          ┌──────────────┐
                          │ AI Generation │
                          │ (Gemini)      │
                          └──────┬───────┘
                                 │
                          ┌──────┴───────┐
                          │ Save to       │
                          │ Shared Cache  │
                          └──────┬───────┘
                                 │
                          ┌──────┴───────┐
                          │ Update Query  │
                          │ Patterns      │
                          └──────────────┘


═══════════════════════════════════════════════════
            BACKGROUND (every 1 hour)
═══════════════════════════════════════════════════

┌──────────────────────────────────────────────┐
│ AI Cache Optimizer                            │
│                                               │
│ 1. Read query_patterns (last 24h)             │
│ 2. Analyze: frequency, cost, volatility       │
│ 3. Decide TTL per cache_key                   │
│ 4. Update recommended_ttl_ms                  │
│ 5. Evict stale cache entries                  │
│ 6. Log decisions to system_logs               │
└──────────────────────────────────────────────┘
```

### 5.2 Cache Key Generation

```
Raw Query                          → Domain    + Intent         → Cache Key
─────────────────────────────────────────────────────────────────────────────
"show project dashboard"           → projects  + dashboard      → projects_dashboard
"project status overview"          → projects  + dashboard      → projects_dashboard
"give me project summary"          → projects  + dashboard      → projects_dashboard
"how many employees?"              → employees + quick_answer   → employees_count
"total headcount"                  → employees + quick_answer   → employees_count
"list employees in delivery dept"  → employees + list           → employees_list_delivery
"check my emails"                  → null      + email          → PERSONAL (no cache)
"what is USD to PKR?"              → null      + conversational → SKIP (external)
```

The cache key is built from **domain** (from BigQuery filter) + **intent type** (from classifier). This means different phrasings of the same question hit the same cache entry.

For queries with specific filters (department, account, etc.), the filter value is appended:
```
employees_list                     → all employees
employees_list_delivery            → delivery department employees
projects_dashboard                 → all projects
projects_dashboard_critical        → critical risk projects only
deals_lookup_diamondfabrics        → specific account lookup
```

---

## 6. Database Schema

### 6.1 Table: `query_patterns`

Tracks query frequency, cost, and AI-decided cache settings.

```sql
CREATE TABLE query_patterns (
  id                    SERIAL PRIMARY KEY,
  cache_key             VARCHAR(150) UNIQUE NOT NULL,
  sample_query          TEXT,                          -- example query for this pattern
  domain                VARCHAR(50),                   -- BQ domain (projects, employees, etc.)
  intent_type           VARCHAR(30),                   -- dashboard, quick_answer, list, etc.
  filter_summary        VARCHAR(200),                  -- "department=delivery" or null

  -- Frequency tracking (rolling 24h)
  frequency_24h         INT DEFAULT 0,                 -- requests in last 24 hours
  frequency_7d          INT DEFAULT 0,                 -- requests in last 7 days
  unique_users_24h      INT DEFAULT 0,                 -- distinct users in 24h

  -- Cost tracking
  avg_input_tokens      INT DEFAULT 0,
  avg_output_tokens     INT DEFAULT 0,
  avg_total_tokens      INT DEFAULT 0,
  avg_response_time_ms  INT DEFAULT 0,
  total_tokens_24h      BIGINT DEFAULT 0,              -- total tokens consumed in 24h

  -- Cache configuration (AI-managed)
  is_personal           BOOLEAN DEFAULT FALSE,         -- true = never shared cache
  data_volatility       VARCHAR(20) DEFAULT 'daily',   -- static, hourly, daily, realtime
  recommended_ttl_ms    INT DEFAULT 300000,            -- AI-decided TTL (default 5 min)
  cache_priority        INT DEFAULT 5,                 -- 1-10, higher = more important to cache

  -- AI optimizer metadata
  last_optimized_at     TIMESTAMP,
  optimizer_reasoning   TEXT,                           -- AI's explanation for TTL decision

  -- Timestamps
  first_seen_at         TIMESTAMP DEFAULT NOW(),
  last_seen_at          TIMESTAMP DEFAULT NOW(),
  updated_at            TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_qp_cache_key ON query_patterns(cache_key);
CREATE INDEX idx_qp_frequency ON query_patterns(frequency_24h DESC);
CREATE INDEX idx_qp_priority ON query_patterns(cache_priority DESC);
```

### 6.2 Table: `shared_cache`

Stores actual cached responses, shared across all users for non-personal queries.

```sql
CREATE TABLE shared_cache (
  id              SERIAL PRIMARY KEY,
  cache_key       VARCHAR(150) NOT NULL,
  query_text      TEXT,                       -- the actual query that generated this
  response_text   TEXT NOT NULL,              -- full AI response (streamed chunks joined)
  response_meta   JSONB,                      -- token counts, elapsed time, sources
  input_tokens    INT DEFAULT 0,
  output_tokens   INT DEFAULT 0,

  -- Validity
  data_hash       VARCHAR(64),                -- hash of data timestamp (invalidate on refresh)
  ttl_ms          INT DEFAULT 300000,         -- TTL from query_patterns
  created_at      TIMESTAMP DEFAULT NOW(),
  expires_at      TIMESTAMP,                  -- pre-computed: created_at + ttl_ms

  -- Tracking
  hit_count       INT DEFAULT 0,              -- how many times served from cache
  last_hit_at     TIMESTAMP,
  created_by_user INT,                        -- which user's query created this entry

  UNIQUE(cache_key, data_hash)
);

CREATE INDEX idx_sc_key ON shared_cache(cache_key);
CREATE INDEX idx_sc_expires ON shared_cache(expires_at);
```

### 6.3 Table: `cache_optimization_log`

Audit trail of AI optimizer decisions.

```sql
CREATE TABLE cache_optimization_log (
  id              SERIAL PRIMARY KEY,
  run_at          TIMESTAMP DEFAULT NOW(),
  patterns_analyzed INT,
  changes_made    INT,
  decisions       JSONB,                      -- full AI decision output
  tokens_saved_estimate BIGINT,               -- projected daily token savings
  cost_saved_estimate   DECIMAL(10,4),        -- projected daily cost savings
  reasoning_summary TEXT                       -- AI's overall analysis
);
```

---

## 7. Component Details

### 7.1 Query Normalizer

**Purpose**: Convert diverse query phrasings to a stable cache key.

**Method**: Uses the existing BigQuery domain detection + intent classification:

```typescript
function generateCacheKey(
  domain: string | null,
  intentType: string,
  filters: Filters
): { key: string; isPersonal: boolean } {

  // Personal queries — never shared
  if (!domain && ['conversational', 'email', 'calendar'].includes(intentType)) {
    return { key: '', isPersonal: true };
  }

  // Build key from domain + intent + filters
  let key = (domain || 'general') + '_' + intentType;

  if (filters.department) key += '_dept_' + filters.department.toLowerCase();
  if (filters.account) key += '_acct_' + filters.account.toLowerCase().replace(/\s+/g, '_');
  if (filters.risk_flag) key += '_risk';
  if (filters.geography) key += '_geo_' + filters.geography.toLowerCase();

  return { key, isPersonal: false };
}
```

**Examples**:

| Query | Domain | Intent | Filters | Cache Key |
|-------|--------|--------|---------|-----------|
| "show project dashboard" | projects | dashboard | none | `projects_dashboard` |
| "project status overview" | projects | dashboard | none | `projects_dashboard` |
| "list employees in delivery" | employees | list | dept=delivery | `employees_list_dept_delivery` |
| "show critical risk projects" | projects | list | risk=true | `projects_list_risk` |
| "how many employees?" | employees | quick_answer | none | `employees_quick_answer` |
| "check my emails" | null | email | none | `PERSONAL` (no cache) |

### 7.2 Shared Cache Manager

**Purpose**: Store and retrieve cached AI responses across all users.

**Cache Lookup Logic**:

```typescript
async function getCachedResponse(cacheKey: string, dataHash: string): Promise<CachedResponse | null> {
  const row = await db.query(`
    SELECT response_text, response_meta, created_at, ttl_ms
    FROM shared_cache
    WHERE cache_key = $1
    AND data_hash = $2
    AND expires_at > NOW()
    ORDER BY created_at DESC
    LIMIT 1
  `, [cacheKey, dataHash]);

  if (row) {
    // Update hit count (non-blocking)
    db.query('UPDATE shared_cache SET hit_count = hit_count + 1, last_hit_at = NOW() WHERE id = $1', [row.id]);
    return row;
  }
  return null;
}
```

**Cache Write Logic**:

```typescript
async function saveToCache(
  cacheKey: string,
  queryText: string,
  responseText: string,
  responseMeta: any,
  dataHash: string,
  userId: number
): Promise<void> {
  // Get TTL from query_patterns (or default 5 min)
  const pattern = await db.query(
    'SELECT recommended_ttl_ms FROM query_patterns WHERE cache_key = $1',
    [cacheKey]
  );
  const ttlMs = pattern?.recommended_ttl_ms || 300000;

  await db.query(`
    INSERT INTO shared_cache (cache_key, query_text, response_text, response_meta,
                              input_tokens, output_tokens, data_hash, ttl_ms,
                              expires_at, created_by_user)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW() + ($8 || ' milliseconds')::interval, $9)
    ON CONFLICT (cache_key, data_hash) DO UPDATE SET
      response_text = $3, response_meta = $4, hit_count = 0,
      ttl_ms = $8, expires_at = NOW() + ($8 || ' milliseconds')::interval,
      created_at = NOW()
  `, [cacheKey, queryText, responseText, responseMeta,
      responseMeta.inputTokens, responseMeta.outputTokens,
      dataHash, ttlMs, userId]);
}
```

**Cache Invalidation**:

```typescript
// Called when data refreshes (Apps Script → /api/index/refresh)
async function invalidateAllCache(): Promise<void> {
  await db.query('DELETE FROM shared_cache');
  console.log('[Cache] All cached responses invalidated (data refresh)');
}

// Called when specific domain data changes
async function invalidateDomain(domain: string): Promise<void> {
  await db.query(
    "DELETE FROM shared_cache WHERE cache_key LIKE $1",
    [domain + '_%']
  );
}
```

### 7.3 AI Cache Optimizer

**Purpose**: Analyzes query patterns every hour and decides optimal TTL per cache key.

**Runs as**: Background cron job (node-cron, every hour)

```typescript
async function optimizeCache(): Promise<void> {
  // Step 1: Update rolling frequency counts
  await db.query(`
    UPDATE query_patterns SET
      frequency_24h = (SELECT COUNT(*) FROM token_query_log
                       WHERE created_at > NOW() - INTERVAL '24 hours'
                       AND LOWER(query) LIKE '%' || query_patterns.domain || '%'),
      unique_users_24h = (SELECT COUNT(DISTINCT user_id) FROM token_query_log
                          WHERE created_at > NOW() - INTERVAL '24 hours'
                          AND LOWER(query) LIKE '%' || query_patterns.domain || '%')
  `);

  // Step 2: Get top patterns for AI analysis
  const patterns = await db.query(`
    SELECT cache_key, domain, intent_type, frequency_24h, unique_users_24h,
           avg_total_tokens, avg_response_time_ms, is_personal, data_volatility,
           recommended_ttl_ms as current_ttl
    FROM query_patterns
    WHERE frequency_24h > 0
    ORDER BY frequency_24h DESC
    LIMIT 50
  `);

  // Step 3: Ask AI for optimal TTL decisions
  const prompt = `You are a cache optimization AI. Analyze these query patterns and decide the optimal cache TTL for each.

PATTERNS:
${patterns.map(p => `- ${p.cache_key}: ${p.frequency_24h} requests/day by ${p.unique_users_24h} users, avg ${p.avg_total_tokens} tokens, ${p.avg_response_time_ms}ms, volatility: ${p.data_volatility}, personal: ${p.is_personal}`).join('\n')}

RULES:
- Personal queries (email, calendar, conversational): ttl_ms = 0 (never cache)
- High frequency (>20/day) + expensive (>5000 tokens): ttl_ms = 1800000 (30 min)
- High frequency (>20/day) + cheap (<3000 tokens): ttl_ms = 3600000 (1 hour)
- Medium frequency (5-20/day): ttl_ms = 900000 (15 min)
- Low frequency (<5/day): ttl_ms = 300000 (5 min)
- Static data (CEO name, company info): ttl_ms = 86400000 (24 hours)
- Real-time data (emails, calendar): ttl_ms = 0 (never)
- After data refresh: all caches invalidated automatically

Return JSON array:
[{"cache_key": "...", "ttl_ms": ..., "priority": 1-10, "reasoning": "..."}]`;

  const decisions = await callGemini(prompt);

  // Step 4: Apply decisions
  for (const decision of decisions) {
    await db.query(`
      UPDATE query_patterns SET
        recommended_ttl_ms = $1,
        cache_priority = $2,
        optimizer_reasoning = $3,
        last_optimized_at = NOW()
      WHERE cache_key = $4
    `, [decision.ttl_ms, decision.priority, decision.reasoning, decision.cache_key]);
  }

  // Step 5: Log the optimization run
  const tokensSaved = calculateProjectedSavings(patterns, decisions);
  await db.query(`
    INSERT INTO cache_optimization_log (patterns_analyzed, changes_made, decisions,
                                        tokens_saved_estimate, reasoning_summary)
    VALUES ($1, $2, $3, $4, $5)
  `, [patterns.length, decisions.length, JSON.stringify(decisions),
      tokensSaved.tokens, tokensSaved.reasoning]);
}
```

---

## 8. Cache Decision Logic

### 8.1 Decision Matrix

| Frequency (24h) | Token Cost | Volatility | Users | TTL Decision |
|-----------------|-----------|-----------|-------|-------------|
| >50 requests | >10K tokens | Daily | >10 | 30 min (aggressive cache) |
| >50 requests | <5K tokens | Daily | >10 | 1 hour |
| 20-50 requests | Any | Daily | 5-10 | 15 min |
| 5-20 requests | >10K tokens | Daily | 2-5 | 15 min (cost-driven) |
| 5-20 requests | <5K tokens | Daily | 2-5 | 10 min |
| <5 requests | Any | Any | Any | 5 min (default) |
| Any | Any | Static | Any | 24 hours |
| Any | Any | Realtime | Any | 0 (never cache) |
| Personal query | Any | Any | 1 | 0 (never cache) |

### 8.2 Data Volatility Classification

| Data Type | Volatility | Rationale |
|-----------|-----------|-----------|
| Company identity (CEO, address) | Static | Changes once a year |
| Employee count, org structure | Daily | Changes with hiring/departures |
| Project status, progress | Daily | Updated daily in sheets |
| Sales deals | Daily | New deals added periodically |
| Pipeline opportunities | Daily | Stages change during sales cycle |
| OKRs, decisions | Weekly | Reviewed in leadership meetings |
| Competency matrix | Weekly | Updated after assessments |
| Emails | Realtime | New emails arrive constantly |
| Calendar | Realtime | Events change in real-time |
| System logs | Realtime | New errors happen anytime |
| Token consumption | Realtime | Updates every request |

### 8.3 Cache Priority Scoring

The AI optimizer assigns a priority score (1-10) based on:

```
Priority = (frequency_weight × 0.4) + (cost_weight × 0.3) + (user_weight × 0.3)

Where:
  frequency_weight = min(10, frequency_24h / 5)
  cost_weight = min(10, avg_total_tokens / 2000)
  user_weight = min(10, unique_users_24h / 3)
```

**Example**:
```
projects_dashboard:
  frequency = 47/day → weight = 9.4
  cost = 15,000 tokens → weight = 7.5
  users = 25 → weight = 8.3
  Priority = (9.4 × 0.4) + (7.5 × 0.3) + (8.3 × 0.3) = 8.5 → HIGH PRIORITY

employee_count:
  frequency = 12/day → weight = 2.4
  cost = 2,600 tokens → weight = 1.3
  users = 8 → weight = 2.7
  Priority = (2.4 × 0.4) + (1.3 × 0.3) + (2.7 × 0.3) = 2.2 → LOW PRIORITY
```

High priority items get:
- Longer TTL
- Pre-generation (cache populated before anyone asks)
- Monitored for staleness

---

## 9. Safety & Privacy Rules

### 9.1 What Is NEVER Cached (Hard Rules)

| Category | Examples | Reason |
|----------|---------|--------|
| Email queries | "check my emails", "read email from X" | Personal inbox, real-time |
| Calendar queries | "what's on my calendar", "schedule meeting" | Personal schedule, real-time |
| Memory queries | "show my memory", "what do you know about me" | Per-user AI memory |
| Conversational | "hi", "how are you", "tell me a joke" | Personal interaction, varies |
| Actions | "send email to X", "create event" | Side effects, not idempotent |
| Admin real-time | "show system logs", "token consumption" | Changes every request |
| Contains user name | "what is Basit's role" | Could vary by user context |

### 9.2 What IS Cached (Shared Across Users)

| Category | Examples | Cache Duration |
|----------|---------|---------------|
| Data counts | "how many employees" | 1 hour |
| Dashboards | "project dashboard" | 15-30 min |
| Analysis | "revenue trend", "risk summary" | 15 min |
| Lists | "list employees by grade" | 15 min |
| Lookups | "status of PSO project" | 15 min |
| Static facts | "who is CEO" | 24 hours |

### 9.3 Privacy Safeguards

```
1. Cache key NEVER contains user ID for shared queries
2. Personal queries are detected before cache lookup
3. Cache entries don't store which user asked — only which user CREATED the entry
4. Admin can purge all cache via /api/cache/purge
5. Data refresh automatically invalidates all cache
6. User-specific filters (my department, my team) are cached per-filter, not per-user
```

### 9.4 Cache Isolation for Multi-Tenant

```
Cache key format: {client_number}_{domain}_{intent}_{filters}

TMC-0001_projects_dashboard     → TMC tenant's project dashboard
TMC-0002_projects_dashboard     → Different tenant's project dashboard

Shared only within same client_number. Never cross-tenant.
```

---

## 10. Cost & Performance Projections

### 10.1 Current Cost (300 users, no smart cache)

| Metric | Value |
|--------|-------|
| Queries/day (7 per user avg) | 2,100 |
| Unique queries/day | ~200 |
| Repeated queries/day | ~1,900 (90%) |
| Tokens/day | 19.1M |
| Cost/day | $21.3 |
| **Cost/month** | **$640** |

### 10.2 Projected Cost (with smart cache)

| Metric | Without Cache | With Cache | Savings |
|--------|-------------|-----------|---------|
| AI calls/day | 2,100 | ~250 | **88% fewer** |
| Tokens/day | 19.1M | ~2.3M | **88% reduction** |
| Cost/day | $21.3 | $2.6 | **88% savings** |
| **Cost/month** | **$640** | **$78** | **$562 saved** |
| Avg response time | 10s | 1.2s | **88% faster** |
| Cache hit rate | 0% | ~78% | |

### 10.3 Response Time Improvement

| Query Type | Without Cache | With Cache (hit) | With Cache (miss) |
|-----------|-------------|-----------------|------------------|
| Dashboard | 10-20s | **<200ms** | 10-20s (first time) |
| Quick answer | 4-8s | **<200ms** | 4-8s (first time) |
| Data analysis | 8-15s | **<200ms** | 8-15s (first time) |
| List/table | 10-20s | **<200ms** | 10-20s (first time) |
| Email/calendar | 5-10s | N/A (never cached) | 5-10s |
| Conversational | 2-3s | N/A (never cached) | 2-3s |

### 10.4 Scaling Projections

| Users | Without Cache/month | With Cache/month | Savings |
|-------|-------------------|-----------------|---------|
| 100 | $210 | $30 | $180 (86%) |
| 300 | $640 | $78 | $562 (88%) |
| 500 | $1,070 | $110 | $960 (90%) |
| 1,000 | $2,130 | $160 | $1,970 (92%) |

**The more users, the higher the savings** — because cache hit rate increases with more users asking the same questions.

---

## 11. Implementation Plan

### Phase 1: Foundation (Day 1-2)

| Task | Description | Effort |
|------|------------|--------|
| Create `query_patterns` table | Schema + indexes | 30 min |
| Create `shared_cache` table | Schema + indexes | 30 min |
| Create `cache_optimization_log` table | Schema + indexes | 15 min |
| Build Query Normalizer | Domain + intent → cache key | 2 hours |
| Build Cache Lookup | Check shared_cache before AI call | 2 hours |
| Build Cache Write | Save response after AI generates | 1 hour |

### Phase 2: Integration (Day 2-3)

| Task | Description | Effort |
|------|------------|--------|
| Wire into chat controller | Add cache check before AI pipeline | 2 hours |
| Add personal query detection | Skip cache for email/calendar/conv | 1 hour |
| Add data refresh invalidation | Clear cache when `/api/index/refresh` called | 30 min |
| Add multi-tenant isolation | Cache key includes client_number | 30 min |
| Update token tracking | Log cache hits as 0-token requests | 1 hour |

### Phase 3: AI Optimizer (Day 3-4)

| Task | Description | Effort |
|------|------------|--------|
| Build optimizer cron job | Runs hourly, analyzes patterns | 3 hours |
| Build AI decision prompt | Gemini analyzes and decides TTLs | 2 hours |
| Build pattern frequency tracker | Update counts on every query | 1 hour |
| Build optimization logging | Track all AI cache decisions | 1 hour |

### Phase 4: Monitoring & Admin (Day 4-5)

| Task | Description | Effort |
|------|------------|--------|
| Admin cache dashboard | Show hit rate, top cached queries, savings | 3 hours |
| Cache purge endpoint | Manual invalidation for admin | 30 min |
| Welcome screen cache stats | Show cache savings on admin welcome | 1 hour |
| System log integration | Log cache events | 1 hour |
| Testing with 50-query suite | Verify cache hits and accuracy | 2 hours |

### Total Estimated Effort: 5 working days

---

## 12. Risk Assessment

### 12.1 Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-----------|--------|-----------|
| Stale data served | Medium | High | Auto-invalidate on data refresh + TTL limits |
| Cache grows too large | Low | Medium | Max 500 entries + LRU eviction |
| AI optimizer makes bad TTL decisions | Low | Low | Min/max TTL bounds (5 min to 24 hours) |
| Personal data in shared cache | Low | Critical | Hard-coded personal query detection before cache |
| Cross-tenant data leak | Low | Critical | Cache key includes client_number, enforced at DB level |
| Cache miss storm after invalidation | Medium | Medium | Stagger re-generation, don't invalidate all at once |

### 12.2 Business Risks

| Risk | Probability | Impact | Mitigation |
|------|-----------|--------|-----------|
| Users see slightly outdated data | Medium | Low | TTL limits + "Last updated X min ago" indicator |
| Cost savings don't materialize | Low | Medium | Monitor hit rates, adjust optimizer |
| System complexity increases | High | Low | Clean interfaces, fallback to no-cache if issues |

### 12.3 Operational Risks

| Risk | Probability | Impact | Mitigation |
|------|-----------|--------|-----------|
| Cache DB corruption | Low | Medium | Regular backups, cache can be rebuilt from scratch |
| Optimizer consumes too many tokens | Low | Low | Cap optimizer to 1 AI call per hour |
| Cache table grows indefinitely | Medium | Low | Auto-expire + daily cleanup job |

---

## 13. Monitoring & Metrics

### 13.1 Key Metrics to Track

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| Cache hit rate | >70% | <50% (optimizer not working) |
| Avg response time (cached) | <200ms | >500ms |
| Avg response time (uncached) | <15s | >25s |
| Daily token savings | >80% | <50% |
| Cache entries count | <500 | >500 (need eviction) |
| Stale response complaints | 0 | >3/day |

### 13.2 Admin Dashboard Additions

```
Welcome Screen (admin view):
  [Logs (2)]  [Tokens: 92K↑ 11K↓ · $0.01]  [Cache: 78% hit rate, $18 saved today]
```

Token consumption report additions:
```
Cache Performance (Last 30 Days):
  Total queries:        63,000
  Cache hits:           49,140 (78%)
  Cache misses:         13,860 (22%)
  Tokens saved:         442M
  Cost saved:           $49.20
  Avg cached response:  180ms

Top Cached Queries:
  1. projects_dashboard    - 4,200 hits - saved 63M tokens
  2. employees_count       - 2,100 hits - saved 5.5M tokens
  3. deals_list            - 1,800 hits - saved 12.6M tokens
```

### 13.3 System Logs Integration

```
[info] cache_hit: projects_dashboard served from cache (180ms, 0 tokens)
[info] cache_miss: employees_list_delivery not in cache, generating (12s, 8K tokens)
[info] cache_write: employees_list_delivery cached with TTL 15min
[info] cache_optimize: AI updated 23 TTLs, projected daily savings: 15M tokens ($1.68)
[warning] cache_stale: projects_dashboard served 25-min-old data (TTL 30min)
[info] cache_invalidate: All cache cleared (data refresh triggered)
```

---

## 14. Rollback Strategy

### 14.1 Feature Flag

The entire smart cache can be disabled with one config change:

```
Admin → Settings → Caching → smart_cache_enabled = false
```

When disabled:
- Shared cache lookup skipped
- Pattern tracking still runs (for data collection)
- AI optimizer paused
- System falls back to existing 5-min dedup cache

### 14.2 Gradual Rollout

```
Week 1: Enable for SuperAdmin only (1 user) — validate behavior
Week 2: Enable for Admin users (5 users) — validate multi-user
Week 3: Enable for all Standard users — full deployment
Week 4: Enable AI optimizer — self-learning begins
```

### 14.3 Emergency Purge

```
Admin command: "clear all cache"
  → Purges shared_cache table
  → Resets all query_pattern TTLs to default (5 min)
  → Logs event to system_logs
  → Next queries regenerate from AI
```

---

## Appendix A: Example AI Optimizer Output

```json
{
  "run_timestamp": "2026-04-15T09:00:00Z",
  "patterns_analyzed": 35,
  "decisions": [
    {
      "cache_key": "projects_dashboard",
      "ttl_ms": 1800000,
      "priority": 9,
      "reasoning": "Highest frequency query (47/day) with expensive output (15K tokens). 25 unique users ask this daily. Data refreshes hourly from Apps Script. 30-min cache covers the gap between refreshes while serving most users from cache."
    },
    {
      "cache_key": "employees_count",
      "ttl_ms": 3600000,
      "priority": 6,
      "reasoning": "Asked 23 times/day by 15 users. Very cheap (2.6K tokens) but frequent. Employee count changes rarely (hiring is weekly). 1-hour cache is safe and saves 22 AI calls/day."
    },
    {
      "cache_key": "deals_list",
      "ttl_ms": 900000,
      "priority": 7,
      "reasoning": "Asked 18 times/day, expensive (24K tokens). Deals update daily. 15-min cache balances freshness with cost savings."
    },
    {
      "cache_key": "email_check",
      "ttl_ms": 0,
      "priority": 0,
      "reasoning": "Personal email query — must NEVER be cached. Each user needs their own real-time inbox."
    }
  ],
  "projected_daily_savings": {
    "tokens": 15200000,
    "cost_usd": 1.68,
    "ai_calls_saved": 1850
  }
}
```

---

## Appendix B: Comparison with Industry Approaches

| Approach | Used By | Pros | Cons |
|----------|---------|------|------|
| Fixed TTL cache | Most apps | Simple | Wastes tokens on popular queries, stale data |
| Semantic cache | LangChain | Embedding-based similarity | Expensive (embedding every query), complex |
| **Self-learning cache (ours)** | **TMC AI** | **Adapts to usage, zero maintenance** | **Needs initial data (1 week)** |
| Edge caching (CDN) | ChatGPT | Fast global | Doesn't understand query semantics |
| Pre-generation | Perplexity | Instant for known queries | Expensive for long-tail queries |

Our approach combines the best of semantic caching (understanding query similarity) with self-learning (AI decides strategy) — without the cost of embedding every query (we use domain+intent as the key, which is already computed).

---

**End of Document**

*This document is for design review. Implementation begins after approval.*
