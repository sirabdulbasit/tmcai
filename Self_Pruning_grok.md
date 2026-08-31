# Self-Pruning inventory (Grok) — 2026-08-31 (revisited)

Capability 9 in `BRAIN_VISION.md`: **Self-Pruning**. This file is Grok's evidence
pack for what is stacked, unused, or duplicated in the Nexeo tree, the live
database, and Brain structure — and what can actually be removed.

**Ask:** *analyze all files, DB, and brain structure and identify redundancy or
unnecessary things which can be removed.* Revisit: *update this document and
mention the current size of project and DB and after pruning what it will be.*

**Scope:** `/var/www/tmcai` on branch `release/cmp-2026-08-16`, HEAD `d144edf`.
Measured **2026-08-31**. Disk from `du -sh`. Database `tmcai` via
`pg_database_size` + exact `COUNT(*)` (no payloads, no credentials printed).
Nothing in this document has been deleted.

**Live product path (do not prune):**

```
WhatsApp inbound / BrainChatPanel / email-to-Brain
  → answerAsBrain (brainAskRoutes)
    → planRetrieval → compose()
       → reasoningCompose + brainTools          ← production
       → assembleSystemPrompt + callLLM         ← only if BRAIN_USE_REASONING=never
    → answerSanitizer → channelRenderer / chat UI
```

The tree is not one product with leftovers. It is **Drive/BQ chatbot →
MyOS/HaseebOS v15 → Nexeo Brain**, stacked. Live source is **~14 MB**. The
rest of the 3.1 GB is dependencies, WhatsApp sessions, a Python venv nobody
runs, old `dist` snapshots, and orchestrator logs.

**Uncommitted work left alone:** DEF-256 voice-reply edits already in the
working tree. Do not mix a prune with that fix.

---

## 0. Size — now vs after pruning

### 0.1 Project disk (`/var/www/tmcai`)

| | Size | Share of 3.1 GB |
|---|---|---|
| **Now** | **3.1 GB** | 100% |
| After slice 1 (safe disk leftovers) | **~2.24 GB** | −866 MB (−28%) |
| After slices 1–4 (disk + dead chat/code) | **~2.24 GB** | code is ~400 KB; rounding noise |
| After also clearing `.wwebjs_cache` (optional, regenerable) | **~2.17 GB** | extra −68 MB; do **not** while a WA session is live |

**Where the 3.1 GB actually is:**

| Path | Size | Keep? |
|---|---|---|
| `server/node_modules` | 1008 MB | **Keep** — runtime |
| `server/whatsapp-sessions/` | 967 MB | **Keep** — live webjs session. AGENTS.md forbids touching it. |
| `agents/.venv` | 728 MB | **Prune** — Python ADK unused (`feature_adk_agents` defaults false) |
| `.git` | 117 MB | Keep |
| `server/docs/` (almost all orch logs) | 65 MB | **Prune logs/retired** (~61 MB of it) |
| `client/node_modules` | 68 MB | **Keep** |
| `server/.wwebjs_cache` | 68 MB | Operational Chromium/WA HTML cache. Regenerable. Not in slice 1. |
| `server/dist.pre-*` (4 snapshots) | 77 MB | **Prune** |
| `server/dist` | 20 MB | **Keep** — locked deploy artifact (`chattr +i`) |
| `server/whatsapp-user-sessions/` | 9.2 MB | **Keep** |
| `server/src` | 7.9 MB | Keep (662 `.ts` files) |
| `server/tests` | 2.2 MB | Keep (245 `.ts` files) |
| `client/src` | 1.9 MB | Keep (100 files) |
| `server/prisma` | 1.2 MB | Keep (107 models) |
| `agents/` source without venv | 372 KB | Keep as history; do not stop pm2 `tmcai-agents` |
| `client/dist` | 1.7 MB | Keep |

**Live application source** (src + tests + prisma + client src + scripts + infra):
**~14 MB**. Everything else is install artifacts, sessions, or leftovers.

### 0.2 Database (`tmcai`)

| | Size | Notes |
|---|---|---|
| **Now** | **810 MB** | `pg_database_size`. 140 public tables, 407 indexes. |
| After dropping empty + May-2026 wipe tables | **~807 MB** | −2.5 MB. Schema cleanup, not a size win. |
| After 90-day `llm_spend` retention | **~480 MB** | Keep ~1.10M of 2.61M spend rows. |
| After 30-day `llm_spend` retention | **~300 MB** | Keep ~235k of 2.61M spend rows (−510 MB). |
| After also pruning old `notification_queue` TOAST + `gate_rule_firings` | **~265–280 MB** | See §0.3. Optional retention, not “unused.” |

**Where the 810 MB actually is:**

| Relation | Size | Rows | Keep? |
|---|---|---|---|
| `llm_spend` (heap 303 + indexes 258) | **561 MB** | 2,614,296 | **Keep the table.** 91% of rows are older than 30 days. Oldest 2026-05-03. |
| `wiki_pages` | 124 MB | 12,909 | **Keep** — live Memex |
| `gate_rule_firings` | 19 MB | 107,267 | Keep recent; retention candidate (May→today) |
| `notification_queue` | 17 MB | 180 | Heap is 24 KB. **17 MB is TOAST** of old payloads. 151/180 older than 30 days. |
| `feed_events` | 16 MB | 5,775 | **Keep** — canonical inbox |
| `brain_user_messages` | 14 MB | 25,070 | **Keep** |
| `criticality_fusion_cache` | 9 MB | 5,231 | Keep — cost-control cache |
| All other tables combined | ~50 MB | | mixed |
| 19 May-2026 wipe/backup tables | **1.3 MB** | | **Prune** via migration |
| Empty leftover product tables (§5.1) | **1.2 MB** | 0 rows each | **Prune** via migration |

`llm_spend` is **69% of the database**. It is the live cost ledger (OPT-001 / spend
page), not junk. The size problem is **retention**, not a second product.

`llm_spend` age (exact counts, 2026-08-31):

| Window | Rows | Share |
|---|---|---|
| Last 7 days | 15,963 | 0.6% |
| Last 30 days | 234,738 | 9% |
| Last 90 days | 1,095,461 | 42% |
| Older than 30 days | 2,379,558 | 91% |
| Older than 90 days | 1,518,835 | 58% |

### 0.3 After-pruning picture (what you actually get)

```
NOW
  disk  3.1 GB     db  810 MB
         │                  │
         │  slice 1         │  empty+wipe tables
         ▼                  ▼
  disk  2.24 GB    db  807 MB     ← safe, no Brain behavior change
         │                  │
         │  slices 2–4      │  30-day llm_spend archive
         ▼                  ▼
  disk  2.24 GB    db  ~300 MB    ← recommended if you want the DB to shrink
```

**Will not move** no matter how hard we prune application leftovers:

- `server/node_modules` 1008 MB
- `whatsapp-sessions` 967 MB
- `.git` 117 MB
- `client/node_modules` 68 MB
- `wiki_pages` 124 MB in Postgres

Those five are why a fully pruned tree is still ~2.2 GB on disk and a fully
pruned-and-retained database is still ~300 MB.

---

## 1. Verdict

| Bucket | What it is | Disk / DB effect | Safe to act? |
|---|---|---|---|
| **A. Disk leftovers** | venv + `dist.pre-*` + orch logs | **−866 MB disk** | Yes, after a rollback check |
| **B. Unimported client files** | Pages/components with zero imports | ~50 KB | Yes |
| **C. Dead product still mounted** | `/chat-legacy`, extra LLM vendors, empty jobs | ~400 KB source; stops wasted CPU/LLM | After a kill switch |
| **D. Parallel live systems** | Two composers, three wiki linters, dual contacts | Almost no bytes; simpler Brain | Collapse one owner per concern |
| **E. Empty tables** | 0-row leftovers + 19 wipe tables | **−2.5 MB db** | Migration, after a second count |
| **F. Spend retention** | Archive `llm_spend` older than 30 days | **−~510 MB db** | Yes, if the spend page can read an archive |

Every file under `server/src/services/knowledge/` is imported. There is no
“delete this unused Brain file.”

---

## 2. Can remove now — disk (−866 MB → project 3.1 GB → 2.24 GB)

Not in the runtime import graph. Confirm they are not a rollback plan, then they
can go. All of these except orch `state/` are gitignored.

| Path | Size | Why it is waste |
|---|---|---|
| `agents/.venv` | **728 MB** | Python ADK fleet leftover. `feature_adk_agents` defaults **false**. Node reimplemented wiki scribe, brief, reflection, triage. **Do not stop pm2 `tmcai-agents`** — that is a different app on this box. The Python *source* is 372 KB and can stay. |
| `server/dist.pre-32c07b8.20260824T0949` | 19 MB | Pre-deploy snapshot, not imported |
| `server/dist.pre-b520a74.20260824T0732` | 19 MB | same |
| `server/dist.pre-56f6f70.20260825T0753` | 19 MB | same |
| `server/dist.pre-4beb7ca.20260827T1439` | 20 MB | same |
| `server/docs/orchestrator/logs/` | 46 MB | 453 old build-loop files |
| `server/docs/orchestrator/pre-reset-001/` | 11 MB | 138 retired iter files |
| `server/docs/orchestrator/retired-2026-08-17/` | 944 KB | Named retired |
| `server/docs/orchestrator/retired-2026-08-17-reset2/` | 596 KB | Named retired |
| `server/docs/orchestrator/retired-2026-08-17-reset3/` | 48 KB | Named retired |
| `server/docs/orchestrator/retired-2026-08-18-reset/` | 2.1 MB | Named retired |
| `orchestrator/phase1/__pycache__/` | tiny | **No `.py` sources left** — bytecode only |
| `orchestrator/phase1b/__pycache__/` | tiny | same |
| `agents/src/**/__pycache__/` | tiny | Regenerable |
| `scripts/orchestrator/__pycache__/` | tiny | Regenerable. Keep `pulse.py` — Health Check still execs it. |
| `server/package.json.prod-backup-20260717` | 4 KB | Dated backup |
| `server/package-lock.json.prod-backup-20260717` | 408 KB | Dated backup |

**Slice 1 total: ~866 MB.**

**Never delete `server/dist`.** It is the deployed artifact (`chattr +i`). A
build in this tree silently replaces what production will execute on the next
restart.

Keep current orch `state/`, `build_log.md`, `capability_contract.md` until pulse
and the scorecard no longer read them.

**Not in slice 1:**

| Path | Size | Why it stays |
|---|---|---|
| `server/whatsapp-sessions/` | 967 MB | Live session. Deleting it makes WhatsApp go deaf. |
| `server/.wwebjs_cache` | 68 MB | whatsapp-web.js HTML cache. Regenerable, but clearing it during a live session is how WA “randomly” breaks. |
| `server/.env.bak-20260722` and `.env.bak-20260731-133216` | 3 KB each | Secrets. Do not commit. Do not `rm` from a chat without the owner. |
| `client/dist` | 1.7 MB | Built frontend |

---

## 3. Can remove now — unimported client files (~50 KB)

Not in `App.jsx`. Not in `SteeringWheelPage` tabs. Zero importers.

| File | Note |
|---|---|
| `client/src/pages/ClientConfigPage.jsx` | Unmounted |
| `client/src/pages/SystemConfigPage.jsx` | Data-management section was copied into `admin/ConfigTab.jsx` |
| `client/src/pages/TenantPage.jsx` | Unmounted |
| `client/src/pages/KnowledgePage.jsx` | Steering Wheel uses `WikiPage.jsx` |
| `client/src/components/BrainAvatar.jsx` | Owner, 2026-08-24: “remove it from all pages”. File kept. `App.jsx` comment records the ruling. |
| `client/src/components/steering/CustomActionTab.jsx` | Removed from rail |
| `client/src/components/steering/ActionForms.jsx` | Removed from rail |
| `client/src/components/steering/ActionExecutionTab.jsx` | Removed from rail |
| `client/src/components/steering/WikiTab.jsx` | Replaced by `pages/WikiPage.jsx` |

Dead control, not a file: `IconRail` Search button has **no `onClick`**.

Routed but not the same as unimported — unmount the route before deleting
the page:

| Route | Page | In IconRail? | Rows behind it |
|---|---|---|---|
| `/chat-legacy` | `ChatPage.jsx` | No | legacy `conversations` = 2, `messages` = 1,703 |
| `/brain/memory` | `BrainMemoryPage.jsx` | No (`/brain` is in the rail) | |
| `/thoughts` | `ThoughtPipelinePage.jsx` | No | `thought_entries` = 30 |
| `/welcome` | `WelcomePage.jsx` | No | |
| `/agents` | `AgentsPage.jsx` | **Yes** | `agents` = **0** |
| `/schedules` | `SchedulerPage.jsx` | **Yes** | `scheduled_tasks` = **0** |
| `/how-it-works` | `HowBrainWorksPage.jsx` | Yes | |

---

## 4. Can unplug after a kill switch — dead product still running

These compile, mount, and in some cases still tick. Nexeo Brain does not use
them. Unmount / stop the timer first; delete files second. Source size of the
whole dead chat/RAG/agent stack is **~400 KB** — this slice saves **CPU and LLM
calls**, not disk.

### 4.1 Legacy TMC chat (highest dead-product surface)

| Piece | Path | Size |
|---|---|---|
| UI | `client/src/pages/ChatPage.jsx`, `hooks/useChat.js`, `services/chatApi.js` | ~8 KB + |
| HTTP | `server/src/routes/chatRoutes.ts`, `conversationRoutes.ts` | 12 KB |
| Controller | `server/src/controllers/` (almost all of 148 KB is this stack) | 148 KB |
| RAG | `server/src/pipeline/` | 104 KB |
| Prompt | `server/src/services/promptService.ts` | |
| Brief shortcut | `dayBriefingService.ts`, `briefingService.ts` | |
| Memory | `memoryService.ts` (also `welcomeService`) | 12 KB |
| News | `newsService.ts` (legacy chat + welcome) | |
| KB | `knowledgeBaseService.ts` + `knowledgeBaseRoutes.ts` | |

Product chat is `FloatingChat` → `BrainChatPanel` → `/api/v1/brain/ask-stream`.
`/chat-legacy` is still a live route. Nobody links it. There is **no feature
flag** that disables `/v1/chat`.

Also still mounted from the same generation: `apiGatewayRoutes` /
`marketplaceService` / `whiteLabelService` (v15 marketplace). Not on the rail.

### 4.2 Extra LLM vendors — only the legacy chat router imports them

| File | Callers outside `/chat` |
|---|---|
| `server/src/services/groqService.ts` | **none** |
| `server/src/services/openaiService.ts` | **none** |
| `server/src/services/openrouterService.ts` | **none** |
| `server/src/services/domainLLMService.ts` | **none** (`ff_domain_llm_traffic_pct` defaults 0) |

Live Brain: `geminiService` / `llmRouter.callLLM` (Gemini → Flash → Claude).
Two different files named `llmRouter.ts` exist:

- `server/src/services/llmRouter.ts` — Brain + jobs
- `server/src/controllers/chat/llmRouter.ts` — legacy `/chat/stream` only

### 4.3 Old RAG / Phase-5 knowledge

| Piece | Used by | Brain Ask uses it? | DB rows |
|---|---|---|---|
| `server/src/pipeline/*` | `/chat` + `proactiveIntelligenceService` | **No** | |
| `knowledgeBaseService.ts` + `/knowledge` | Phase-5 cosine KB | **No** | `knowledge_items` = 0 |
| `documents` + `chunks` | scheduler 4am vector backfill | **No** | **0**; `searchChunksByVector` has **no callers** |
| `personal_documents` + `personal_chunks` | GDrive RAG | | **0** |
| `domain_knowledge` | injected into legacy `/chat` | | **0** |

Brain retrieval is `brainRetrievalPlanner` + `wikiEmbeddingService` on
`wiki_pages` (12,909 rows / 124 MB).

### 4.4 Empty work still on a timer (wasted CPU, not disk)

| Job / processor | Cadence | Table it feeds | Rows |
|---|---|---|---|
| `startIndexEventProcessor` (`server.ts`) | every **10s** | `index_events` | **0** (`enqueueIndexEvent` has no callers) |
| `runProactiveIntelligence` | hourly | `proactive_alerts` | **0** |
| `chunkVectorService` / scheduler 4am | daily | `chunks` | **0** |
| `initializeAgentScheduler` | boot | `agents` / `agent_runs` | **0** (`feature_agents` defaults false) |
| Node `server/src/agents/` | 84 KB source | personal-agent product | 0 rows |

### 4.5 Jobs with no production timer

Inventory (`server/docs/background_jobs_inventory.md`) already says retired
follow-up workers “own no production timers.” Confirmed against `server.ts`
and the governors:

| File | Evidence |
|---|---|
| `jobs/openItemFollowUpJob.ts` | Not in `server.ts` / governors. Tests only. |
| `jobs/delegationFollowUpJob.ts` | Same. Tests (`def191`, `def225`) still treat it as chase-email. **Product merge, not a file delete.** |
| `jobs/junkContactCleanupJob.ts` | Header claims `server.ts`; zero production imports. Cleanup governor uses `smartCleanupService` / `contactPruneService`. |
| `jobs/gmailFeedPoller.ts` `pollAllActiveUsers` | Generic poller superseded it (`server.ts` ~724). Only `scripts/kickGmailPoll.ts` still calls it. |
| `jobs/embeddingBackfill.ts` | Comment says “nightly 2 AM”; no cron, no admin route. |
| `services/openItems/followupWorker.ts` | Smoke script only. |
| `services/openItems/delegateeFollowupWorker.ts` | `@deprecated`; tests pin it stays unwired. |

Canonical live follow-up: `centralActionGovernor` → `actionLifecycleWorker`.

### 4.6 Python ADK as Nexeo Brain

`/var/www/tmcai/agents/` is the HaseebOS v15 ADK fleet (brain_orchestrator,
wiki_scribe, reflection, morning_brief, triage). Node reimplemented all of
that. `feature_adk_agents` defaults false; ADK publish falls back to the
in-process registry (`actionExecutionService.ts`).

Repo `ecosystem.config.js` only runs `tmcai-server`. **Do not stop
`tmcai-agents` on the box.**

### 4.7 Feature-flag constants that gate nothing

`server/src/config/featureFlags.ts` `V15_FLAGS`: only **`ADK_AGENTS`** is read.
These keys appear only in the export:

`feature_kill_switch`, `feature_shadow_scoring`, `feature_steering_wheel`,
`feature_pubsub`, `feature_bq_archive`, `feature_risk_gating`,
`feature_redis_idempotency`, `feature_cascading_undo`.

The **systems still exist** (kill-switch middleware, shadow scoring, steering
routes, Pub/Sub publisher, cascading undo). Deleting the unused constants is
cleanup; deleting the systems is not.

---

## 5. Parallel live systems — collapse, do not delete blindly

Same job, two or more implementations, **both still load-bearing**. Collapsing
them barely moves disk or DB. It is what actually makes Brain simpler.

### 5.1 Brain compose (the real leftover)

| Path | Role |
|---|---|
| `reasoningCompose` + `applyDispatch` | **Production** chat composer |
| `brainComposer.assembleSystemPrompt` + `callLLM` | Emergency rollback (`BRAIN_USE_REASONING=never`). Thousands of lines still in the same file. Dispatch, pending confirm, plan steps, and receipt policy live here — **the file is not disposable.** |
| `agenticReader` | **Second live composer.** Regex heuristic; Gemini function-calling; **skips** `compose` / preview / dispatch. Deleting it changes “research/check X and Y” turns. |
| `brainCapabilityLive` | Generated from `action_definitions` — live CAN list |
| `brainCapabilityRegistry.ts` | Static CAN/CANNOT list still injected |

Highest-value Brain prune: make `agenticReader` and `brainTools` one loop, and
stop maintaining a second prompt under the reasoning gate.

### 5.2 Thinking engines (all still scheduled)

| Engine | Cadence | Job |
|---|---|---|
| `preactiveEngine` | 15 min | meeting prep + due nudges |
| `brainCognitiveEngine` | 30 min | observations / mind_state |
| `proactiveIntelligenceService` | hourly | Phase-5 `proactive_alerts` (GCP retrieval; 0 rows) |
| `brainEngineService` | per-user cron via `schedulerService` | old 9-step ingest/score/suggest |
| Python `brain_orchestrator` | ADK | leftover |

### 5.3 Wiki lint ×3 — all started from `server.ts`

| Module | When | Output |
|---|---|---|
| `jobs/wikiLintWorker.ts` | hourly | writes a “Wiki Lint Report” wiki page |
| `knowledge/wikiLinterService.ts` | hourly | mutates `wiki_pages.status` + link counts |
| `wiki/wikiLintService.ts` | nightly 03:00 PKT | in-app notification |

`wikiStaleness.ts` exists because these used to disagree on **60 vs 90 days**.
Wiki **writers** are also dual: `wikiScribeService` (feed ingest) vs
`wikiStorageService` (REST + Notion/Postgres). Compose reads `wiki_pages`
from both.

### 5.4 Morning brief ×4

| Module | Used by |
|---|---|
| **`views/dayBrief.ts`** | **Canonical** — Day Brief page, WA dispatch, composer block |
| `steering/morningBriefService.ts` | 06:00 PKT KPI snapshot + `/steering` |
| `dayBriefingService.ts` | legacy `chatController` briefing shortcut |
| `briefingService.ts` | legacy `chatRoutes` `sendMorningBriefing` |

### 5.5 Reflection ×2 Node + 1 Python, two Node jobs on the **same 6h interval**

| Module | Writes |
|---|---|
| `jobs/reflectionJob.ts` | inferred `user_memories` (needs confirm) |
| `reflection/reflectionService.ts` | `pattern_insights` for Day Brief |
| `agents/.../reflection_agent.py` | leftover ADK |

Different tables. Deleting one is not a no-op.

### 5.6 WhatsApp senders

Canonical Brain↔user send: `services/notifications/tenantWhatsappSender.ts`
(Meta notifier → webjs fallback). Documented in `APP_MENTAL_MODEL.md`.

Still live in parallel:

| Path | Role |
|---|---|
| `whatsapp/WhatsAppManager.ts` `sendWhatsAppMessage` | Tenant webjs transport |
| `whatsappService.ts` | **Different** Meta Cloud API, `ff_whatsapp_enabled` |
| `adapters/whatsappAdapter.ts` | Circuit-breaker wrap of `whatsappService` — **notification drain** uses this, not `tenantWhatsappSender` |
| `whatsapp/UserWebjsProvider.ts` | Personal paired WhatsApp (user’s own number, ingest) |

Notification queue drain (`server.ts` `notification_drain`) does **not** go
through `tenantWhatsappSender`. That is a real dual path.

### 5.7 Follow-up / self-follow-up

Canonical: `centralActionGovernor` → `actionLifecycleWorker`.

Still present beside it (see §4.5): `openItemFollowUpJob`, `followupWorker`,
`delegationFollowUpJob` (chase email in the owner’s Gmail),
`delegateeFollowupWorker` (retired). Two of those send outbound. Dropping
them without checking `agent_action` / Gmail sent items would change Self
Follow-Up.

---

## 6. Database — measured on this box (810 MB now)

107 Prisma models. **140 public tables** (the extra 33 are wipe copies, raw
SQL tables not in Prisma, and leftovers). Exact `COUNT(*)` unless noted.
Unused in `server/src` is **not** permission to `DROP TABLE`.

### 6.1 Empty (0 rows) — previous product, still in schema / still polled

Together these occupy **~1.2 MB** (empty tables still have toast/indexes).

| Table | What it was | Still doing |
|---|---|---|
| `documents` + `chunks` | Org RAG in Postgres | Scheduler still backfills vectors on an empty table. |
| `personal_documents` + `personal_chunks` | GDrive RAG | |
| `domain_knowledge` | Phase 6 corpus | Still injected into **legacy** `/chat` |
| `knowledge_items` | Phase 5 KB | |
| `okrs` | OKR product | **Zero reads/writes** in `server/src` |
| `agents` + `agent_memory` + `agent_runs` | Phase 8 personal agents | `/agents` UI + scheduler still boot |
| `proactive_alerts` | Hourly Phase-5 alerts | Job still runs |
| `index_events` | Index queue | Processor still ticks every 10s |
| `golden_dataset` + `shadow_scores` | Shadow scoring | |
| `capability_registry` | Old capability table | Live source is `action_definitions` |
| `user_tiers` | User-tier product | |
| `user_prompts` + `user_prompt_overlay` | Prompt overlays | Overlay code still in compose |
| `brain_product_proposals` + `brain_development_requests` | Phase-2 learning pipeline | |
| `token_usage` | Pre-`llm_spend` | Chat path can still write it |
| `scheduled_tasks` | `/schedules` crons | |
| `licenses` | Seat billing | `client_licenses` has 1 row; `licenses` has 0 |
| `push_subscriptions` / `approval_tokens` / `action_undo_log` / `action_dependencies` / `audit_log` / `retrieval_feedback` / `brain_feedback` / `orchestrator_spend` / `self_prune_notice_batches` | unused product surfaces | 0 rows |

`okrs` is the only empty model with **no runtime reader or writer at all**.

### 6.2 Dual stores that both have real data

Collapsing these barely moves DB size. `persons`+`entities` together are
under 2 MB. The expensive dual-write is **correctness**, not gigabytes.

| Concept | Store A (keep until a cutover) | Extra copy still written |
|---|---|---|
| Contacts | `entities` **916** **or** `persons` **974** + `person_facets` — pick one | the other + wiki entity/sender pages |
| Chat history | `brain_user_messages` **25,070 / 14 MB** | `messages` **1,703** + `conversations` **2** + `whatsapp_messages` **1,442** + session JSON |
| Knowledge | `wiki_pages` **12,909 / 124 MB** | `brain_docs` **2**; empty `knowledge_items` / `chunks` |
| Memory | `user_memories` **13** | `user_profile_memory` + `governed_brain_memories` **2** + `user_learning` |
| Work | `open_items` **272** + `delegation_threads` | empty `okrs` / `scheduled_tasks` / `agents`; leftover `open_items.delegation_*` columns |
| Google identity | `user_connectors` | `users.integration_*` columns — Gmail pollers still key off these |
| Spend | `llm_spend` **2.61M / 561 MB** | empty `token_usage`; RAG `audit_log` token fields |
| Actions | `brain_action_artifacts` + `brain_pending_actions` | `agent_actions` **2,446** (Brief drafts + reaper) |
| Rules | `shadow_rules` (triage hot path) | `rule_lifecycle` + `user_action_rules` + `gate_rules` |
| Feedback | `brain_response_evaluations` | `feedback` (web chat thumbs) + `retrieval_feedback` |
| Prompts to owner | `brain_prompt_queue` | `notification_queue` (180 rows, **17 MB TOAST**) |

Schema comment at `UserMemory` is stale: it says UserMemory was removed and
replaced by `user_profile_memory` — then `user_memories` was **re-added**.
Both exist.

Google identity is the highest operational duplication: Connectors UI writes
`user_connectors`; Gmail/Calendar pollers still key off `users.integration_*`.

Contacts: resolver uses `persons`; Contacts UI uses `entities`; wiki has a
third copy. Pick one before dropping the other.

Inbound WhatsApp still dual-writes **session JSON + `whatsapp_messages` +
`conversations`/`messages` + `feed_events`**. Canonical product inbox is
`feed_events`.

### 6.3 May-2026 wipe / backup tables (not in Prisma) — 1.3 MB

19 tables named `*_wipe_*`, `*_overpromoted_*`, `wiki_pages_repointed_*`,
`wiki_pages_forced_private_*`, `wiki_pages_definitive_rebuild_*`.

Largest: `wiki_pages_forced_private_2026_05_25` (60 rows, 0.41 MB),
`entities_overpromoted_2026_05_23` (628 rows, 0.13 MB).

Drop only with a hand-written idempotent migration and a restore story.

### 6.4 Retention (this is how the DB actually shrinks)

| Action | From | To | Saves |
|---|---|---|---|
| Archive `llm_spend` older than 30 days | 561 MB | ~50 MB | **~510 MB** |
| Archive `llm_spend` older than 90 days | 561 MB | ~235 MB | **~325 MB** |
| Delete delivered `notification_queue` older than 30 days | 17 MB TOAST | ~few hundred KB | **~16 MB** |
| Retain `gate_rule_firings` 30 days | 19 MB / 107k | small | **~15 MB** |
| Drop empty leftover tables + wipe copies | 2.5 MB | 0 | 2.5 MB |

Recommended DB target if you want a number: **keep 30 days of `llm_spend`
in the hot table, archive the rest, drop wipe/empty tables → ~300 MB.**

The spend page (`llmSpendRoutes`) reads `llm_spend` directly. An archive
must keep Day/Week/Month/Range working, or the UI will under-report the way
the old `system_config` blob did (OPT-001).

### 6.5 Raw tables not in Prisma (still have writers)

`user_profile_memory`, `user_learning`, `feedback`, `general_artifacts`,
`user_artifacts`, `system_logs`, `token_usage`, `token_query_log`,
`user_tiers`, `agent_runs`, `whatsapp_config`, `user_action_rules`,
`audit_logs`.

Do not treat “not in `schema.prisma`” as “unused.”

### 6.6 What not to drop from the database

Keep: `tenants`, `users`, `sessions`, `system_config`, `feed_events`,
`open_items`, `item_status_history` (DEF-127: dropping it rolled back status
updates), `wiki_pages` + sources + links, `entities` (until Person is actually
the Contacts source of truth), `user_connectors` + connector tables,
`brain_pending_actions`, `brain_action_artifacts`, `action_idempotency_logs`,
`brain_prompt_queue`, `brain_user_messages`, `tenant_whatsapp_notifier`,
`wa_sender_policy`, `whatsapp_outbound_messages`, `delegation_threads` +
events + grants, `job_runs`, `job_leases`, `self_heal_log`,
`ops_health_state`, `brain_health_findings`, `llm_spend` (the table — archive
old rows, do not drop), `orchestrator_spend` (separate bill),
`action_definitions`, `muted_senders` (31 rows), `triage_decision_cache`,
`criticality_fusion_cache`.

WhatsApp **audit** rows stay until a proven single ledger exists. Today that
is a mix of `feed_events`, `whatsapp_outbound_messages`,
`brain_user_messages`, and `whatsapp_messages`.

---

## 7. Do not touch

Per `AGENTS.md` / `CLAUDE.md` / environment facts:

- `server/dist/` — immutable deployed artifact (`chattr +i`)
- `server/.env`, tokens, `tmcai-key.json`, `.env.bak-*`
- `server/whatsapp-sessions/` (967 MB), `whatsapp-user-sessions/`
- `server/docs/nexeo_self_learning&development.md`
- `server/tenant-scope-audit-2026-05-22.md`
- Production-local `server/package.json` and `server/package-lock.json`
- Other pm2 apps: `tmcai-agents`, `tokr-server`, `vm-server`
- `scripts/orchestrator/pulse.py` while Health Check / Brain Evolution exists
- In-progress DEF-256 working-tree edits
- `centralActionGovernor`, `actionLifecycleWorker`, `tenantWhatsappSender`,
  wiki retrieval — live Brain

---

## 8. Recommended prune order

One slice at a time. WhatsApp and composer layers have a history of “cleanup”
reopening production incidents.

| # | Slice | Disk | DB | Risk |
|---|---|---|---|---|
| 1 | Delete `agents/.venv` + four `dist.pre-*` + orch logs/retired | **3.1 GB → 2.24 GB** | — | None if `server/dist` stays locked |
| 2 | Unimported client pages/components in §3 | ~50 KB | — | None — zero importers |
| 3 | Stop empty work: `index_events` processor, `proactive_alerts` job, `chunks` backfill | — | — | Low — tables empty; saves CPU |
| 4 | Unmount `/chat-legacy` and Groq/OpenAI/OpenRouter | ~400 KB source | — | Medium — confirm no bookmark hits `/api/chat/stream` |
| 5 | One wiki linter, one brief (`views/dayBrief.ts`), one reflection job | — | — | Medium — each copy writes a different table |
| 6 | Pick `entities` **or** `persons` as contact source of truth | — | <2 MB | High — UI vs resolver vs wiki |
| 7 | Drop empty + wipe tables (migration) | — | 810 → 807 MB | Low bytes, high if a purge path still names them |
| 8 | Archive `llm_spend` older than 30 days | — | **810 → ~300 MB** | Medium — spend page must still range-query |

Do **not** batch 4–8 with a Brain messaging-path change.

**If you do 1 + 8 only** (the two that move the numbers):

- project disk **3.1 GB → 2.24 GB**
- database **810 MB → ~300 MB**

---

## 9. How this was measured (revisited 2026-08-31)

- Disk: `du -sh` on `/var/www/tmcai` and every top-level / leftover tree
- Live mounts: `server/src/app.ts`, `server/src/server.ts`
- Job inventory: `server/docs/background_jobs_inventory.md` vs actual timers
- Knowledge folder: every `services/knowledge/*.ts` importer
- Client: `App.jsx` routes vs `IconRail.jsx` vs importers of each page
- Database: `pg_database_size('tmcai')` = 849,484,823 bytes (**810 MB**);
  `pg_total_relation_size` per table; exact `COUNT(*)` on named tables
- `llm_spend` age split: 7 / 30 / 90 day windows
- `notification_queue`: heap 24 KB vs total 17 MB (TOAST)
- Flags: `server/src/config/featureFlags.ts` vs `isFeatureEnabled` call sites

This document does not claim a capability-score movement. Removing dead
weight is Self-Pruning of the **system**. Slice 1 and slice 8 are the only
slices that change the size numbers a human will notice. Slices 5–6 are the
ones that make Brain simpler.

---

## 10. One-line source of truth per concern

When a prune happens, keep this side and stop writing the other:

| Concern | Keep |
|---|---|
| Reply compose | `reasoningCompose` + `brainTools` |
| Day brief | `views/dayBrief.ts` |
| Wiki store | `wiki_pages` |
| Work queue | `open_items` + `delegation_threads` |
| Inbox | `feed_events` |
| Contacts | pick `entities` **or** `persons` (not both) |
| Connectors | `user_connectors` |
| Outbound WA (Brain→user) | `tenantWhatsappSender` |
| Brain→user questions | `brain_prompt_queue` |
| LLM cost | `llm_spend` (hot 30 days; archive the rest) |
| Capability list | `action_definitions` → `brainCapabilityLive` |
| Follow-up | `centralActionGovernor` → `actionLifecycleWorker` |
| Retrieval | `brainRetrievalPlanner` + wiki embeddings |
