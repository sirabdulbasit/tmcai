# Brain Hardening Audit — 2026-07-14

Scope: reduce inappropriate hard-coding, improve operational self-healing,
keep safety-critical policies deterministic. The Brain does not rewrite or
deploy its own application code — every "repair" in this document is
allowlisted code written by humans.

Baseline before changes: `tsc` clean, 769 tests passing / 21 skipped.
After changes: `tsc` clean, **849 passing / 0 failing / 21 skipped** (80 new).

---

## 1. Audit table

| # | Finding | Severity | Affected files | Treatment | Status |
|---|---------|----------|----------------|-----------|--------|
| 1a | `fetch_calendar` hardcoded `Asia/Karachi` + manual `5*60` offset math for today/tomorrow/week/date | P0 | knowledge/brainTools.ts | All ranges through `calendarRangeBounds()` (Intl, DST-correct) in the user's resolved zone; event times rendered in-zone | **Implemented** |
| 1b | `todayBoundsInZone` offset-fold bug: day bounds a FULL DAY EARLY for every zone west of UTC | P0 (worse than spec assumed) | views/calendar.ts | Delegates to shared `zonedDayBounds` | **Implemented** |
| 1c | Hardcoded PKT anchors in reasoning prompt, day brief, quiet hours, Google Calendar event bodies, chrono fallbacks, instruction dispatcher, tenant log, system crons | P0/P1 | reasoningCompose.ts, views/dayBrief.ts, notifications/brainOutboundService.ts, calendarService.ts, knowledge/dateResolver.ts, instructions/instructionDispatcher.ts, knowledge/tenantLogService.ts, schedulerService.ts, agents/agentScheduler.ts, brainEngineService.ts | Per-user `resolveUserTimezone()` (user → tenant → system → UTC); system surfaces use `systemDefaultTimezone()` (env `NEXEO_DEFAULT_TIMEZONE`, default Asia/Karachi = unchanged behavior) | **Implemented** |
| 1d | Meeting-offset computed "as of now", wrong across a DST boundary | P1 | instructionDispatcher.ts | Offset resolved as of the MEETING date | **Implemented** |
| 2 | Static capability truth-table drifted from dispatch reality twice (2026-07-07 contacts, 2026-07-13 update_contact RECURRED) | P0 | knowledge/brainCapabilityRegistry.ts, brainComposer.ts | NEW `brainCapabilityLive.ts`: CAN list generated from actionDefinition rows ∩ live dispatch paths × connector health; 4 states (available / connector_unavailable / approval_required / unsupported); fail-closed conservative block on discovery failure; registry-parity meta-tests | **Implemented** |
| 3 | ~30 behavioral constants hardcoded per-service | P1 | preactiveEngine, pendingActionService, autoConfirmService, contactPruneService (+ catalog below) | NEW `behaviorConfig.ts`: user → tenant → env → default, validated + clamped; 8 keys wired/catalogued; category-A invariants stay in code | **Implemented** (5 consumers wired; rest catalogued) |
| 4 | ~45 raw `setInterval` jobs: no leader lock, no run ledger, swallowed errors; safe only because PM2 `instances:1` | P1 | server.ts, NEW jobs/jobRunner.ts | `protectedTick()`: pg-advisory leader lock, `job_runs` ledger, bounded retries by class, escalation to system_logs after 3 consecutive failures; 13 critical/important jobs wrapped; silent `.catch(() => {})` removed on 3 jobs | **Implemented** (remaining maintenance timers deferred, see §6) |
| 5 | Self-healing = one hardcoded rule in systemLogService | P1 | NEW services/selfheal/repairService.ts, server.ts | Allowlisted repair framework: detect → capped/cooldown → apply → VERIFY → audit (`self_heal_log`) → escalate on exhaustion. 3 repairs: stale connector metadata, stuck scribe markers, bounded feed-DLQ replay | **Implemented** |
| 6a | No declared confirmation strength per handler | P0/P1 | actions/handlerBase.ts + 10 handler files | `confirmationCapability(): provider_confirmed \| locally_confirmed \| unverifiable` (default locally_confirmed; 9 provider read-back handlers declared; Slack declared unverifiable) | **Implemented** |
| 6b | `unverifiable` confirm could still record `done` | P0 | actions/executeViaRegistry.ts | ok + unverifiable → status **`unconfirmed`**, never `done`; event outcome matches; fail-closed on JS-level gaps | **Implemented** |
| 6c | Stack-A dispatcher results carried no confirmation semantics | P1 | knowledge/genericActionDispatcher.ts | `DispatchResult.confirmation` stamped from `CONFIRMATION_BY_HANDLER`; unmapped pairs fail closed to `unverifiable`; parity test forces a declaration for every allow-listed pair | **Implemented** |
| 7 | Stub embeddings silently written in production; `chunks` table has NO model tag and retrieval does NOT filter by model → stub/real vectors silently cosine-compared | P1 | knowledge/wikiEmbeddingService.ts, knowledge/chunkVectorService.ts, triage/openItemEmbeddingService.ts, NEW knowledge/embeddingGuard.ts | Stubs only when `NODE_ENV !== 'production'` or explicit `EMBEDDINGS_ALLOW_STUB=1`; production failure → no write, degradation event, 30-min escalation, health surface; recovery logged; NULL vectors re-embedded by existing nightly backfill | **Implemented** (chunks model-tag column deferred, see §6) |
| 8 | WhatsApp wire health in-memory only; no unified ops surface | P1 | whatsapp/connectionWatchdog.ts, routes/admin/whatsappHealthRoutes.ts | Up/down/reinit TRANSITIONS persisted to system_logs (`health_transition`, deduped); NEW `GET /admin/system-health` (admin-gated, tenant-scoped): job ledger, self-heal audit, embedding status, connector states, WA stats, DLQ depth, unconfirmed actions, 7-day health events | **Implemented** |
| 9a | `aiConfigService` cache not tenant-keyed → first tenant's config served to ALL tenants for 5 min; default param `'TMC-0001'` | P0 (worse than spec assumed) | aiConfigService.ts | Cache keyed per tenant; missing tenant → code DEFAULTS (fail closed), never another tenant's rows | **Implemented** |
| 9b | `clientNumber \|\| 'TMC-0001'` in chat prompt builder; TMC-0001 fallback on public password-rules endpoint; `'unknown'` tenant feedback writes | P0 | controllers/chat/promptBuilder.ts, routes/userAuthRoutes.ts, routes/chatRoutes.ts | Code defaults / 404 / 400 — all fail closed | **Implemented** |
| 9c | Platform SMTP hardwired to TMC-0001 rows | P2 | emailService.ts | Named `PLATFORM_CONFIG_TENANT` (env-overridable) — documented platform-level config residence, not tenant identity; env SMTP_* still wins | **Implemented** (contained, not removed — see §6) |
| 10 | Preactive timing fixed; no opt-out; no outcome learning | P2 | brain/preactiveEngine.ts | Lead time + due window user/tenant-tunable (behaviorConfig); deterministic per-user mute (`brain_channel.preactive=false`); every send carries `metadata.source` + bracketed reason marker; outcome dataset = brain_prompt_queue statuses | **Partial** (learning loop deferred, see §6) |

Verified-safe during audit (no change needed): auth middleware fails closed;
WhatsApp/Gmail webhooks derive tenant from verified URL+secret;
`tenantScopeGuard` hard-throws on unscoped queries; wiki + open-item
embeddings already model-filter at retrieval.

---

## 2. Configuration documentation

### Timezone resolution (item 1)
Order: `User.timezone` (IANA, per-user) → tenant `system_config` key
`tenant_timezone` → env `NEXEO_DEFAULT_TIMEZONE` → code default
`Asia/Karachi` → `UTC` if everything configured is invalid. Invalid values
at any level are skipped with a warning, never used. All boundary math is
`Intl`-based and DST-correct (`zonedDayBounds`, `calendarRangeBounds`,
`utcInstantForLocal` in `userTimezoneService.ts`).

### Behavioral thresholds (item 3) — `behaviorConfig.ts`
Resolution: user (`users.notification_preferences → behavior.<key>`) →
tenant (`system_config` key `behavior.<key>`) → env
(`BEHAVIOR_<KEY_UPPERCASED>`) → code default. Every level validated
numeric and clamped to [min, max].

| Key | Default | Clamp | Unit | Scope | Wired |
|-----|---------|-------|------|-------|-------|
| preactive.meeting_prep_window_min | 90 | 10–480 | minutes | user | yes |
| preactive.due_soon_hours | 24 | 1–168 | hours | user | yes |
| pending_action.ttl_hours | 4 | 1–24 | hours | user | yes |
| auto_confirm.streak_threshold | 10 | **5**–100 | count | user | yes |
| contact_prune.max_merges_per_run | 25 | 1–100 | count | tenant | yes |
| followup.subsequent_ping_hours | 24 | 4–168 | hours | user | catalogued |
| followup.escalate_after_hours | 120 | 24–720 | hours | user | catalogued |
| connector.stale_realert_hours | 24 | 1–168 | hours | user | catalogued |

Category-A safety invariants that deliberately CANNOT be configured:
`AUTO_CONFIRM_ELIGIBLE` allowlist, the 200/day outbound hard cap
(brainOutboundService), rule-promotion `HIGH = never auto-promote`
(ruleLifecycleService), the generic dispatcher's closed
`HANDLER_REGISTRY`, the repair allowlist, and the auto-confirm floor of 5.

### Embeddings (item 7)
`EMBEDDINGS_ALLOW_STUB=1` — explicit operator opt-in to stub vectors in
production (offline demo boxes only). Otherwise production never writes a
stub vector.

### Platform config (item 9c)
`PLATFORM_CONFIG_TENANT` — which tenant's `system_config` rows hold
platform-level SMTP settings (default `TMC-0001`); env `SMTP_*` always
takes precedence.

### New unmanaged ops tables (created idempotently at first use, same
pattern as `system_logs`; no Prisma migration needed)
- `job_runs` — one row per background job: last started/completed,
  status, duration, consecutive failures, total runs.
- `self_heal_log` — one row per repair attempt: rule, tenant, outcome,
  before/after JSON snapshots.

---

## 3. Operational runbook

### Automatic recovery (what heals itself)
- **Job failures**: `protectedTick` retries important jobs ×2, critical ×3
  with backoff. Watch: `GET /admin/system-health → jobs[]`.
- **Self-heal pass** (hourly): stale connector error-metadata cleared;
  stuck scribe markers reset; DLQ'd feed events requeued in batches of 25
  (max 4 tenant-attempts/day). Watch: `→ selfHeal[]` or
  `SELECT * FROM self_heal_log ORDER BY created_at DESC LIMIT 20;`
- **WhatsApp wire**: connectionWatchdog probes every 60s and re-inits a
  drifted session automatically; transitions land in system_logs.

### Exhausted recovery — human required
Signal: `system_logs` rows with `category='self_heal'` level=error
("Human action required"), or `job_failure` rows, or
`/admin/system-health → jobs[].consecutive_failures ≥ 3`.
1. Read the message — it names the rule/job and the tenant.
2. Fix the underlying cause (usually a connector, credential, or provider
   outage — see below).
3. The next hourly pass / tick resumes automatically; no counters need
   manual reset (attempt windows are rolling 24h).

### DLQ replay (manual, beyond the bounded auto-replay)
```sql
-- inspect
SELECT id, source_type, created_at FROM feed_events
 WHERE client_number='TMC-0001' AND status='dlq' ORDER BY created_at;
-- requeue (feedPublishRetry picks them up within 2 min)
UPDATE feed_events SET status='new' WHERE client_number='TMC-0001' AND status='dlq' AND id IN (...);
```

### WhatsApp re-pair (when auto-reinit fails)
Signal: system_logs `whatsapp:<tenant>` "reinit did not recover" +
disconnect alert email. Action: Admin → WhatsApp → re-pair via QR scan.
Check `pm2 logs tmcai-server | grep waitForChatLoading` first — if
present, it's the upstream whatsapp-web.js breakage class, not a session
problem (see memory project_wa_webjs_broken_lid).

### Embedding-provider recovery
Signal: `/admin/system-health → embeddings[].status='degraded'` or
system_logs `embedding_degraded` (escalates to error after 30 min).
1. Check `GEMINI_API_KEY` validity / Gemini status.
2. On recovery the guard logs it; pages/chunks written during the outage
   have NULL vectors and are re-embedded by the existing nightly backfill
   (`cron:chunk_vector_backfill` 04:00 + wiki embed-on-write hash check).
   No duplication is possible — embedding writes are per-row UPDATEs.

---

## 4. Remaining risks and deliberately deferred work

1. **`chunks` has no per-vector model column** (schema change → migration;
   out of scope for a working-tree patch). Production mixing is now
   prevented at the WRITE side (no stub writes) — but any stub vectors
   already written to prod before today remain unmarked. One-time check:
   `SELECT COUNT(*) FROM chunks WHERE vector_embedding IS NOT NULL` vs
   embeddings recomputed after key rotation. Proper fix: add
   `embedding_model` column + retrieval filter, mirroring wiki_pages.
2. **~30 maintenance timers not yet routed through protectedTick** (feed
   pollers, lint workers, consolidation, …). They log-and-continue today;
   single-instance PM2 makes double-fire impossible. Migrate opportunistically.
3. **Missed-run catch-up** is intentionally minimal: every interval job
   re-runs within one interval of boot (first-delay ≤ 10 min), so catch-up
   only matters for 24h jobs killed mid-window — visible in `job_runs`
   (`last_completed_at` stale) rather than auto-compensated.
4. **`getNextRun()` placeholder** in schedulerService still reports now+1h
   for `nextRunAt` display (pre-existing; cosmetic).
5. **Preactive learning loop** (item 10 full scope): outcome signals exist
   (brain_prompt_queue statuses + metadata.source per send) but no
   learner adjusts lead times from them yet. Design intent: ≥N dismissals
   of meeting-prep at 90 min → propose (never silently apply) a shorter
   window via the existing proposeMemory/approval path.
6. **Divergent wiki staleness thresholds** (60d vs 90d in the two linter
   services) — catalogued, not unified; unification belongs with a wiki
   maintenance pass.
7. **BrainConfig.engineTimezone / brain_channel.timezone** remain separate
   per-feature timezone settings that OVERRIDE the resolver chain where
   they apply (engine crons, day-brief time). Consolidating them onto
   User.timezone is a product decision (they exist so the brief can fire
   in a different zone than the user's).
8. **`unconfirmed` action rows** (new status) are terminal-honest but not
   yet surfaced in any user-facing list; today only /admin/system-health
   counts them. Slack is the only handler that can produce them.
9. **system_config `key` column is VARCHAR(50)** — long behavior keys fit
   (`behavior.` + longest key = 44 chars) but future keys must stay ≤ 41
   chars after the prefix.

---

## 5. Verification (exact commands)

```
cd /Users/tmc_ai_node_02/TMCAI/tmcai/server
npx tsc --noEmit                 # exit 0 (before AND after)
npx vitest run                   # BEFORE: 769 passed | 21 skipped
                                 # AFTER:  849 passed | 21 skipped | 0 failed
# focused suites (all green):
npx vitest run tests/timezoneResolver.test.ts        # 23
npx vitest run tests/capabilityDiscovery.test.ts     # 14
npx vitest run tests/actionConfirmation.test.ts      # 6
npx vitest run tests/behaviorConfig.test.ts          # 8
npx vitest run tests/jobRunner.test.ts               # 8
npx vitest run tests/repairService.test.ts           # 11
npx vitest run tests/embeddingGuard.test.ts          # 7
```

Pre-existing failures before the changes: none (baseline fully green).
Two transient failures introduced mid-work (a test mock missing the new
timezone exports; preactive tests without behaviorConfig's prisma mock)
were fixed before completion — final suite is fully green.

Note: unit tests mock providers/DB — this patch is verified for logic and
regressions, not yet exercised against live Google/WhatsApp providers.
Deploy through the normal staging flow before calling it production-ready.
