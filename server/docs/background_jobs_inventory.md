# Background-Job Inventory — 2026-07-14 (staging-readiness pass)

Every recurring execution in the server, with classification, protection,
and catch-up policy. "Protected" = wrapped in `jobRunner.protectedTick`:
durable lease (job_leases — cross-replica mutual exclusion, fenced,
expiry-reclaimable), persisted run ledger (job_runs — restart-proof
atomic counters), bounded retries (total attempts: maintenance 1,
important 3, critical 4), overlap-skip, failure escalation to
system_logs at 3 consecutive failures, visible in
`GET /admin/system-health`.

Catch-up policies (#6): `first_tick` = the job fires within minutes of
boot and its own durable dedup keys / current-relevance checks make the
normal tick the safe bounded catch-up (historical outbound is never
replayed — dedup keys + opt-in + quiet hours + caps apply at send time).
`cursor` = the job reads from a durable provider cursor and naturally
resumes. `none` = missed runs need no compensation. The boot missed-run
scan (`evaluateMissedRuns`, server.ts) logs any priority job whose last
completion exceeds 2× cadence.

## Protected jobs (jobRunner)

| Job (ledger name) | Source | Cadence | Class | Tenant scope | Idempotency | Catch-up | Timeout/Lease |
|---|---|---|---|---|---|---|---|
| notification_drain | server.ts | 60s | critical | queue rows | NotificationQueue retries + dedup | first_tick | 10m default |
| day_brief_dispatch | server.ts | 60s | critical | per user | once-per-local-day stamp | first_tick | 10m |
| critical_bundle_sweep | server.ts | 90s | critical | per user | fingerprint + in-flight set | first_tick | 10m |
| preactive_engine | server.ts | 15m | critical | per user | per-event / per-item-per-day dedup keys | first_tick | 10m |
| followup_sweep | server.ts | 1h | critical | per user | per-item follow-up stamps | first_tick | 10m |
| brain_prompt_producer | server.ts | 30m | critical | per user | queue dedup keys | first_tick | 10m |
| delegatee_email_sweep | server.ts | 30m | critical | per user | per-item emailed stamp | first_tick | 10m |
| delegation_follow_up | server.ts | 30m | critical | — | verdict-gated, per-item stamps | first_tick | 10m |
| agent_action_reaper | server.ts | 5m | critical | — | row-state machine | first_tick | 10m |
| open_item_draft_ask | server.ts | 1h | critical | — | per-item ask stamp | first_tick | 10m |
| open_item_follow_up | server.ts | 24h | critical | — | one verdict/item/day | first_tick | 10m |
| kpi_snapshot_morning_brief | server.ts | 5m tick / daily window | critical | per tenant×user | daily window check | first_tick | 10m |
| brain_prompt_expiry | server.ts | 30m | important | queue rows | TTL state machine | none | 10m |
| system_log_maintenance | server.ts | 1h | important | GLOBAL | dedup by recurrence | none | 10m |
| self_heal_pass | server.ts | 1h | important | global+per tenant | audit-first ledger, caps | none | 10m |
| demo_expiry_sweep | server.ts | 1h | important | users | idempotent flag flip | first_tick | 10m |
| personal_drive_sync | server.ts | 30m | important | users | provider cursor | cursor | 10m |
| proactive_intelligence | server.ts | 1h | important | — | dedup keys | first_tick | 10m |
| snooze_unblocker | server.ts | 60s | important | rows | status transition | first_tick | 10m |
| connector_health_sweep | server.ts | 5m | important | — | status-transition writes | first_tick | 10m |
| wa_outbound_reconciliation | server.ts | 10m | important | users | row reconciliation | first_tick | 10m |
| feed_publish_retry | server.ts | 2m | important | rows | integrity checks + DLQ | first_tick | 10m |
| generic_feed_poller | server.ts | 2m | important | tenants | ingest dedup (source ids) | cursor | 10m |
| notion_mirror_sync | server.ts | 10m | important | tenants | page-hash skip | cursor | 10m |
| notion_reverse_sync | server.ts | 5m | important | tenants | conflict detection | cursor | 10m |
| obsidian_vault_export | server.ts | 1h | important | users | appProperties hash-skip | first_tick | 10m |
| central_cleanup_governor | server.ts / centralCleanupGovernor.ts | 5m governor tick; per-task 1h/24h cadence | maintenance | global + tenants + users | one replica lock; sequential tasks; successful-task cadence; failed-task retry | first_tick | 10m |

`central_cleanup_governor` is the only autonomous cleanup scheduler. Its
manifest centrally governs context-memory expiry, open-item backlog/zombie
pruning, system-log retention, action-idempotency expiry, approval-token expiry,
contact prune, smart contact cleanup, inferred memory decay, reset-archive TTL,
wiki-memory consolidation, and feed-event pruning. Domain modules contain
implementation only and own no timers.

## node-cron jobs (schedulerService/agentScheduler — pg-advisory
## `leaderOnly` per tick; short DB-bound bodies, transaction-held lock
## documented safe for these)

scheduled_task executor (per task, sends result email — CRITICAL,
leader-locked `scheduled_task:${id}`); decision_outcomes 2am; pattern_analysis
Sun 6am; thought_weekly_review Fri 7am; shadow_scoring monthly;
sentiment_backfill hourly; entity_sweep 4:30am; odoo_wiki_mirror 5am;
chunk_vector_backfill + unknown-model re-embed 4am; per-user engine
crons (`engine:${cn}:${uid}`); per-user risk-radar crons. All wrapped in
`leaderOnly` (advisory xact lock). Justification for keeping the
advisory-lock design here: these bodies are DB-bound and short (<60s
typical); the 10-min transaction timeout bounds the worst case. The
long-provider-call jobs are the server.ts timers, which now use the
durable lease instead.

## Unprotected recurring work — documented justification

| Job | Source | Cadence | Class | Why unprotected is acceptable |
|---|---|---|---|---|
| gap detection | server.ts 24h | maintenance | analysis only |
| wiki-lint nightly + worker | server.ts / wikiLintWorker | nightly/interval | maintenance | proposals only |
| scribe backfill | server.ts 6h | maintenance | recovery/copy operation; idempotent per-row checks; feed pruning is centrally governed |
| gcal/gmailReadState/gtasks/gchat pollers | server.ts 2–5m | important | READ-ONLY ingest with per-source-id dedup — a duplicate concurrent poll re-ingests nothing (unique keys); failures logged; single-instance PM2 today. Migration to protectedTick is mechanical follow-up. |
| rule miner | server.ts 15m | important | proposes rules only (shadow mode) |
| WA ingest health audit | server.ts 24h | important | audit only, no sends |
| trust promotion / reflection / brainCognitiveWorker / attachment backfill / folder scribe | server.ts + module starters | daily/6h | maintenance | propose-only or idempotent archival |
| WA heartbeats (connectionWatchdog, UserWebjsProvider) | 60s/2m | important | inherently per-process (probes THIS process's WA session; a lease would break the semantics). Transitions persisted to system_logs. |
| index event processor | 10s poll | important | single consumer of index_events queue; row claims are transactional |

Residual risk: the read-only pollers and module-internal workers would
double-poll (not double-write) if PM2 ever moves to cluster mode. The
`ecosystem.config.js` comment pins `instances: 1` for this reason;
migrating the remaining pollers to protectedTick is listed in the audit
doc's deferred work.
