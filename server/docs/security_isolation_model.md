# Security & Data Isolation Model

> Single source of truth for the user/tenant boundary in MyOS. Every
> route and service that touches DB queries must respect these layers.
> Violations are caught by `tests/tenantIsolation.test.ts` (run via
> `npx vitest run tests/tenantIsolation.test.ts`).

---

## The three boundaries

| Boundary | Definition | Examples |
|---|---|---|
| **Cross-tenant** | Tenant A user sees Tenant B data | Customer-A admin sees Customer-B's emails / wiki / users |
| **Cross-user (same tenant)** | User X sees User Y's PRIVATE data even though they share a tenant | Basit sees Asad's inbox / sender histories / personal overlay rules |
| **Privilege escalation** | Non-admin sees admin-only data | Regular user sees other users' OAuth tokens via Health Check |

A breach of any of these is a security bug. Cross-tenant > cross-user
> privilege escalation in severity.

---

## Tenant scoping rule

**Every DB query that touches a tenant-scoped table MUST include a
`clientNumber` filter** unless the query is explicitly cross-tenant
(background sweeps, system-wide cron jobs that iterate per-tenant).

Tenant-scoped tables (non-exhaustive — see `prisma/schema.prisma` for
authoritative list):

```
open_items, wiki_pages, feed_events, brain_prompt_queue,
user_prompt_overlay, retrieval_feedback, agent_actions,
brain_user_messages, decision_logs, delegation_logs,
shadow_rules, system_config, criticality_calibration,
notification_queue, system_logs (when client_number IS NOT NULL)
```

User table is **globally unique by `id`** so `findUnique({where:{id}})`
is PK-safe — won't cross tenants. `findFirst` / `findMany` on User
without `clientNumber` IS a cross-tenant risk.

---

## User scoping rule (within a tenant)

Some tables are **user-private** even within a tenant. Retrieval and
visibility filters MUST honour this:

```sql
WHERE client_number = $caller_tenant
  AND (scope = 'tenant' OR (scope = 'user' AND user_id = $caller_user))
```

User-private types in `wiki_pages`:
- `mind_state`, `sender_history`, `sender_topic`, `gap`, `answer`,
  `observation`, `feedback`, `feedback_diagnosis`

Tenant-shared types in `wiki_pages`:
- `org_doc`, `policy`, `project`, `decision`, `pattern`,
  `entity_person`, `topic`, `attachment_doc`, `concept`, `meeting_minutes`

Other strictly-user-private tables (no `scope` column; always
caller-only):
- `user_prompt_overlay` (your learned directives)
- `retrieval_feedback` (your page boosts)
- `brain_prompt_queue` (your conversation queue)
- `criticality_calibration` (your tuned thresholds)

---

## Status-board / health-page rule

**Health pages must NEVER surface another user's identity.** A status
board is per-caller. The Connectors page (where each user manages
their own connectors) is the authoritative place for multi-user OAuth
status. Don't reproduce that data on Health.

Specifically:
- `checkTokenRefresh` queries the caller's own user row only
- `checkWikiHealth` applies the same scope filter as retrieval
- `checkDlqDepth` scopes to caller's tenant
- Infrastructure checks (postgres, redis, pubsub, agent_worker,
  scheduler, gemini, handler_registry) are global because they
  describe the host — but their detail strings carry NO user
  identifiers.

---

## Admin role definition

`user.isAdmin` (set on `users.user_type IN ('SA','AD')`) means **tenant
admin**, not platform admin. A tenant admin manages users, connectors,
and config WITHIN their tenant only. They have NO cross-tenant view by
default.

If a future "platform admin" role is needed (e.g. for support staff who
can view any tenant), it must be a separate flag (`isPlatformAdmin`)
and gated separately. **Do not promote `isAdmin` to mean cross-tenant
visibility implicitly.**

---

## Background jobs / cron sweeps

Cron jobs that iterate per-tenant intentionally (followup worker,
producer sweep, expiry sweep, delegatee email producer, wiki linter,
rule miner, etc.) are exempt from the per-call tenant filter rule, but
must:

1. Iterate or query, then process per-tenant (extract `clientNumber`
   per row and pass it down).
2. Never write to tenant A's data while processing tenant B's.
3. Never publish telemetry that mixes tenants.

The hygiene check `tests/tenantIsolation.test.ts` may flag these as
violations; they're intentionally exempt and should be marked with a
comment explaining why.

---

## Current state (audit, 2026-05-05)

### Fixed in commits 837485e + (this one)
- `/health/deep` `checkTokenRefresh` — was leaking other users' email
  addresses + token state across users AND tenants. Now scoped to
  caller's own user row.
- `/health/deep` `checkWikiHealth` — was counting cross-tenant wiki
  rows. Now scoped to caller's tenant + own user (with shared
  visibility for tenant pages).
- `/health/deep` `checkDlqDepth` — was counting cross-tenant
  feed_events. Now scoped to caller's tenant.
- `systemLogService.runAutoFix(clientNumber)` — accepted clientNumber
  arg but never applied it in the SQL. A tenant admin sweeping
  auto-fixes was operating on every tenant's matching logs. Now
  filters on `(client_number = $caller OR client_number IS NULL)`.

### Known remaining items (hygiene, not real leaks)
~28 `prisma.user.findUnique({ where: { id: userId } })` callsites are
flagged by `tenantIsolation.test.ts`. All of them query by primary key
with a trusted `userId` from `req.user.id` or already-validated
context. They're **PK-safe** — `User.id` is globally unique. Adding
`clientNumber` to these is defence-in-depth but not a security fix.

### Known cross-tenant operator surfaces
- `systemLogService.cleanupOldLogs` (admin maintenance cron) — wipes
  resolved logs across all tenants. Acceptable for a maintenance task;
  callers must be platform-admin gated, not tenant-admin.
- `systemLogService.getLogTrends(days)` — returns global trend data.
  Currently exposed at `/logs/trends` behind `requireAdmin`. **TODO:
  scope to caller's tenant or move behind a `requireSuperAdmin` check.**

---

## How to add a new route or service safely

1. Read `req.user.id` and `req.user.clientNumber` at the top of the
   handler.
2. Pass both into every service call that touches tenant data.
3. Use `Prisma`'s `where: { clientNumber, ... }` on tenant-scoped
   tables.
4. For wiki: also apply the scope filter
   `OR: [{scope:'tenant'}, {scope:'user', userId}]`.
5. Run `npx vitest run tests/tenantIsolation.test.ts` before committing
   — if you add a new violation, justify with a comment or fix it.

---

_This document is the security boundary contract. Any change that
crosses a line here needs explicit review._
