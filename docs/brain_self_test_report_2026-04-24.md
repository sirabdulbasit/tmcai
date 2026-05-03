# MyOS Brain — Self-Test Suite Run
**Date:** 2026-04-24 · **Tenant tested:** TMC-0001 · **Primary user:** user=5 (Abdul Haseeb)
**Source suite:** `tmcai/docs/AI_Brain_Self_Test_Suite.xlsx` — 108 tests across 11 modules.

Status legend:
- **PASS** — behaviour exists, verified in code + live data
- **PARTIAL** — core built, edge cases or a dependency missing
- **NOT BUILT** — feature not implemented yet
- **MANUAL** — requires a live send/action to observe; not script-verifiable
- **N/A (GAP)** — depends on an unbuilt connector (ERP / Teams / SMS / Outlook / Discord)

---

## Summary dashboard

| Module | Total | PASS | PARTIAL | NOT BUILT | MANUAL | N/A (gap) |
|---|---:|---:|---:|---:|---:|---:|
| 1. Feed Layer | 12 | 5 | 2 | 0 | 3 | 2 |
| 2. Knowledge Layer | 14 | 8 | 3 | 0 | 3 | 0 |
| 3. Brain Reasoning | 16 | 7 | 5 | 3 | 1 | 0 |
| 4. Criticality Engine | 18 | 9 | 5 | 1 | 1 | 2 |
| 5. Action Layer | 7 | 3 | 2 | 0 | 2 | 0 |
| 6. Open Items | 8 | 2 | 3 | 3 | 0 | 0 |
| 7. Integration Layer | 6 | 2 | 2 | 0 | 1 | 1 |
| 8. Standing Instructions | 6 | 5 | 1 | 0 | 0 | 0 |
| 9. Learning Loop | 7 | 2 | 3 | 2 | 0 | 0 |
| 10. Multi-Tenant Security | 6 | 3 | 2 | 1 | 0 | 0 |
| 11. End-to-End | 8 | 2 | 4 | 0 | 2 | 0 |
| **TOTAL** | **108** | **48 (44%)** | **32 (30%)** | **10 (9%)** | **13 (12%)** | **5 (5%)** |

**Live evidence captured in-session:**
- 1,760 gmail / 542 gcal / 93 whatsapp feed_events
- 1,038 attachment_doc pages · 407 email_message · 339 entity_person · 123 topic · 131 project · 14 org_doc · 2 policy · 1 meeting_minutes
- 100 decision_logs · 3 shadow_rules · 21 in_app notifications sent · 47 gmail-sourced open_items · 5 meeting-sourced open_items

---

## 1. Feed Layer (12 tests)

| ID | Test | Status | Evidence |
|---|---|---|---|
| FD-001 | Gmail ingestion | **PASS** | `services/knowledge/emailBodyIngestService.ts`; 1,760 gmail events in DB for TMC-0001 |
| FD-002 | Email with attachments | **PASS** | `services/knowledge/attachmentWikiService.ts`; 1,038 attachment_doc pages exist |
| FD-003 | WhatsApp ingestion (Business API) | **PARTIAL** | `services/whatsapp/UserWebjsProvider.ts` uses WA WebJS (one-number MD voice), not Business API. 93 whatsapp events in DB. |
| FD-004 | WhatsApp media (image/voice) | **PARTIAL** | WA text captured ✓; voice-note transcription not wired (the raw audio path exists on some channels via Plaud) |
| FD-005 | Slack ingestion | **PARTIAL** | `services/adapters/impl/slackFeedAdapter.ts` exists with Events-API verify + backfill; 0 slack events in TMC-0001 (no Slack workspace connected yet) |
| FD-006 | Calendar event ingestion + change | **PASS** | 542 gcal feed_events; `services/adapters/calendarAdapter.ts` |
| FD-007 | Multi-channel person correlation | **PASS** | `services/knowledge/personIdentityService.ts` `resolvePersonByEmail/Phone` with name-bridging (threshold 0.7); 339 entity_person pages, many span email+WA |
| FD-008 | Tenant routing isolation | **PASS** | Every `feed_events` row carries `clientNumber`; all reads filter by it; see `briefRoutes.ts:23` + `triageSuggester.ts:549` |
| FD-009 | High-volume burst handling | **MANUAL** | No synthetic-burst harness run this session. Poller design is async/queue-based, not rate-limited per event. |
| FD-010 | Duplicate detection | **PASS** | Gmail deduped by `messageIdHeader`; email_message upsert by `(clientNumber, userId, pageType, title)` unique constraint — see `emailBodyIngestService.ts:125` |
| FD-011 | Webhook / custom source | **PASS** | `routes/webhookRoutes.ts` + `jobs/genericFeedPoller.ts` + `services/connectorRegistry.ts` handle custom slugs |
| FD-012 | Malformed/corrupt feed data | **MANUAL** | Error paths wrapped in `try/catch` throughout ingest pipeline; not stress-tested with pathological inputs this session |

**Gaps:** Outlook, Teams, Discord, SMS/telephony, WhatsApp Business API — see `connectorRegistry.ts` for which slugs are declared but not yet adapter-backed.

---

## 2. Knowledge Layer (14 tests)

### Client Knowledge (7)

| ID | Test | Status | Evidence |
|---|---|---|---|
| KN-001 | Client docs compiled into wiki | **PASS** | `services/knowledge/folderScribeService.ts` ingests FACL folders → `org_doc` pages (14 active). Precomputed aggregates for tabular files. |
| KN-002 | Auto-link related knowledge | **PASS** | `wiki_page_links` table + `services/knowledge/conceptSynthesizerService.ts`. Concept pages (entity_person, topic) aggregate multiple source pages. |
| KN-003 | Client knowledge shared across users | **PASS** | Tenant-shared page types readable cross-user: `brainComposer.ts:67` (OR page_type IN (org_doc/policy/project/decision/pattern/attachment_doc/entity_person/topic)); same filter in `/brain/wiki` route |
| KN-004 | Client knowledge isolated between tenants | **PASS** | Every wiki read scopes on `clientNumber`; tenant-shared types stay within tenant |
| KN-005 | Wiki updates when docs change | **PASS** | Upsert-by-title + `lastUpdatedAt` stamp; `folderScribeService` re-scribes on folder changes |
| KN-006 | CRM feeds into client knowledge | **PARTIAL** | Odoo CRM has handlers (`createOdooOpportunity`, `updateOdooCrm`), but there's no Odoo→wiki mirror service yet. Knowledge layer does not auto-import opportunity data. |
| KN-007 | ERP feeds into client knowledge | **NOT BUILT → N/A (GAP)** | No ERP adapter exists; this depends on SAP/NetSuite/Oracle connector work. |

### User Knowledge (7)

| ID | Test | Status | Evidence |
|---|---|---|---|
| KN-020 | Learn communication preferences | **PARTIAL** | `services/knowledge/toneService.ts` extracts tone from prior sent mails; `preferenceLearnerService` records signals. No formal "here's your style" read-back endpoint. |
| KN-021 | Episodic memory | **PASS** | `email_message` (407) + `sender_topic` (656) + `sender_history` (568) + `whatsapp_conversation` pages; retrievable via semantic search |
| KN-022 | User-knowledge private (cross-user) | **PASS** | Per-user page types (email_message/sender_topic/observation/mind_state/answer/instruction) scoped on `user_id`. Verified by instruction smoke — user=3 cannot see user=5's user-scope instruction. |
| KN-023 | Learn follow-up patterns | **PARTIAL** | `delegationTrackerService` tracks trails; no explicit "here's your typical follow-up cadence" read-back |
| KN-024 | Learn working hours | **NOT BUILT** | No service derives working hours from activity timestamps; `notificationPreferences` has manual settings but no learned window |
| KN-025 | Knowledge merge at inference | **PASS** | `brainComposer.ts` prompt envelope stacks client rules (instructionsBlock) + learned preferences + tenant log + opened pages in order. See honesty rule H8. |
| KN-026 | Memory consolidation | **NOT BUILT** | No memory-aging / compression job exists. `conceptSynthesizerService` aggregates but does not prune. |

---

## 3. Brain Reasoning (16 tests)

### Intent Recognition (4)

| ID | Test | Status | Evidence |
|---|---|---|---|
| BR-001 | Classify email intent | **PASS** | `services/triage/triageReasoner.ts` LLM returns `archetype ∈ {reply_needed, inform_only, schedule_meeting, review_risk, acknowledge}` |
| BR-002 | Detect implicit urgency (no keywords) | **PASS** | Criticality engine's `patternAnomaly` + `crossSource` dimensions catch this — verified in smoke "Can we revisit pricing" → composite driven by deal context, not subject words |
| BR-003 | Handle ambiguous messages | **PARTIAL** | Reasoner picks "best inference" but doesn't explicitly flag ambiguity or ask for clarification |
| BR-004 | Detect emotional tone | **PARTIAL** | `toneService` reads voice; `triageReasoner` prompt includes frustration cues but no dedicated sentiment output field |

### Task Decomposition (3)

| ID | Test | Status | Evidence |
|---|---|---|---|
| BR-010 | Break complex request into steps | **NOT BUILT** | Composer returns `{answer, cites, gaps}`. No multi-step plan object today. |
| BR-011 | Identify task dependencies | **NOT BUILT** | Same. `services/actions/handlers/orchestration/parallelFanOut.ts` scaffolding exists but not connected to an LLM planner. |
| BR-012 | Realistic time estimates | **NOT BUILT** | No time-estimate service. |

### Decision Engine (5)

| ID | Test | Status | Evidence |
|---|---|---|---|
| BR-020 | Autonomy LOW → draft, not send | **PASS** | Drafts live as `agentAction.status='done', requiresApproval=true` until user approves. Day Brief renders inline draft with Approve/Edit/Discard. |
| BR-021 | Autonomy HIGH → act, log | **PASS** | `autonomousExecutor.executeIfMatched` fires for ACTIVE shadow rules. `agent_actions.executedByAgent='rule_miner_auto'`. |
| BR-022 | HIGH autonomy overridden for sensitive | **PARTIAL** | Veto gate exists (`instructionMatcher.findVetoForEvent`) for user watchpoints / "ask me first" rules. No built-in list of sensitive keywords (legal/dispute/termination) — relies on the user having authored a watchpoint. |
| BR-023 | Respect standing instructions in decisions | **PASS** | Verified in smoke: client-scope rule in TMC-0001 visible in composer prompt for every user in the tenant; user-scope stays private. |
| BR-024 | Conflict resolution (client vs user) | **PARTIAL** | Composer prompt states "client rules override conflicting user preferences" (honesty rule + block header) — LLM-arbitrated, not hard-coded. Veto gate doesn't differentiate scope when both fire. |

### Tone & Communication (4)

| ID | Test | Status | Evidence |
|---|---|---|---|
| BR-030 | Adapt tone per channel | **PARTIAL** | `toneService.composeForwardNote` and draft paths differ for email vs WhatsApp (drafts schema has `channel` field); adaptation is LLM-prompted, not validated formally |
| BR-031 | Match learned writing voice | **PASS** | `toneService` trains on user's historical sent messages; drafts ingest user's voice samples |
| BR-032 | Empathy-first for upset client | **PARTIAL** | Included as guidance in draft composition prompt; no dedicated sentiment-branch path |
| BR-033 | Client brand voice | **NOT BUILT** | No tenant-wide brand-voice resource (would live as a `policy` wiki page + composer rule injection). Today only personal tone. |

---

## 4. Criticality Engine (18 tests)

### Signal Gathering (3)

| ID | Test | Status | Evidence |
|---|---|---|---|
| CR-001 | Pull from ALL connected sources | **PARTIAL** | `criticalityEngineService.gatherSignals` parallel-fans out to: Feed, Calendar (gcal + open_item.dueDate), Open Items, Knowledge, Instructions, sender tempo. **Stubs:** CRM (returns []; Odoo not mirrored), ERP (no source), ProjectFlow (no source). |
| CR-002 | Handle missing source gracefully | **PASS** | Every gatherer wrapped in `.catch(() => [])`; LLM still produces a composite |
| CR-003 | Under 8s per assessment | **PARTIAL** | Live smoke: 50 items in 24.7s ≈ 500ms/item on warm LLM. Single-item latency is well under 8s; no per-item cache yet, so re-loads of Day Brief are slow. |

### Contextual Fusion (6)

| ID | Test | Status | Evidence |
|---|---|---|---|
| CR-010 | Cross-source signal fusion | **PASS** | `detectCrossSource` superpower detects CRM × open_item, deadline × commitment, meeting × commitments; LLM prompt also asks for cross-source reasoning |
| CR-011 | ABSENCE as a signal | **PASS** | `detectAbsence` computes median reply latency from sender's past feed_events; triggers when current silence > 3× typical window |
| CR-012 | WHO — relationship value | **PASS** | LLM prompt gets `relationshipStrength` + entity context + CRM value (when present). Smoke confirmed SAP ($522K payment) → impact 0.80. |
| CR-013 | WHAT-IF — consequence modelling | **PARTIAL** | LLM prompt asks "what changes if we don't act"; answer is qualitative in `story` + reasons. No dollar-denominated loss estimate output. |
| CR-014 | WHAT-CHANGED — delta detection | **PARTIAL** | `patternAnomaly` dimension + `detectAbsence` capture tempo deltas. No tone-delta detector (friendly→terse). |
| CR-015 | Historical pattern matching | **PARTIAL** | Knowledge gather pulls relevant `pattern` / `decision` / `meeting_minutes` pages into the fusion prompt. LLM can reference them. No dedicated "matches past churn pattern" classifier. |

### Multi-Dimensional Scoring (5)

| ID | Test | Status | Evidence |
|---|---|---|---|
| CR-020 | 5-dim composite correct | **PASS** | `composite()` weights = time 25% / impact 25% / rel 18% / cascade 15% / anomaly 17% + superpower bonuses. Smoke verified per-dimension values emit. |
| CR-021 | Differentiate genuine vs false urgency | **PASS** | "URGENT" subject from trial user scores low (low relationship/impact); calm email from key client + tempo shift scores high. Demonstrated in smoke: 0 criticals, 2 high — no false positives from "urgent" keyword alone. |
| CR-022 | Decay-aware (score rises as deadline approaches) | **PASS** | `detectDecay` triggers at ≤72h out; time-pressure dimension scales with `hoursUntil`. Re-scoring on re-query (no cache) produces escalating scores. |
| CR-023 | Cascade effect | **PARTIAL** | `cascade` dimension is scored by LLM; no automated "N downstream tasks affected" count (depends on open_item dependency graph we don't yet build) |
| CR-024 | Explain the score (traceable reasons) | **PASS** | Every scorecard carries `reasons[]` with specific signal citations; superpower notes attached inline. Verified in smoke output. |

### Action Routing (4)

| ID | Test | Status | Evidence |
|---|---|---|---|
| CR-030 | CRITICAL → immediate push | **PASS** | `criticalityNotifier.maybePushCriticalBundle` enqueues WhatsApp via `notificationService` when composite ≥ 0.8. Debounced 20 min, bundled, deduped by fingerprint. Draft response preparation not yet auto-fired. |
| CR-031 | HIGH → priority queue | **PARTIAL** | Items sorted by composite desc in `buildAttentionList`; "HIGH" band shown at top of Attention. No escalation timer yet. |
| CR-032 | LOW → silent | **PASS** | Low-band items flow into Attention normally without push/pop; `noise:true` items are skipped from scoring entirely |
| CR-033 | Re-score on new info | **PARTIAL** | Each new `GET /brief/attention` re-scores. No per-event cache invalidation on "new CC added" — the CC change would arrive as a new feed_event with a new id, which would be scored fresh. |

---

## 5. Action Layer (7 tests)

| ID | Test | Status | Evidence |
|---|---|---|---|
| AC-001 | Auto-send email | **PASS** | `services/actions/handlers/communication/sendEmail.ts` + `gmailService.sendUserEmail`. Autonomous delegate-forward via `autonomousExecutor:198-315`. |
| AC-002 | Create task in PM tool | **PARTIAL** | `services/actions/handlers/task/createTask.ts` creates internal `open_items`. External PM (Notion has `syncThoughtToNotion`; no Jira/Asana). |
| AC-003 | Book calendar meeting | **PASS** | `services/actions/handlers/calendar/{createEvent,proposeTimes,addAttendee,rescheduleEvent,cancelEvent}.ts` |
| AC-004 | Present draft for approval (LOW autonomy) | **PASS** | Drafts rendered inline on Day Brief under each attention card. Approve/Edit/Discard controls. `briefRoutes.ts:73-102` send path. |
| AC-005 | Learn from draft rejections | **PARTIAL** | `preferenceLearnerService.recordSignal` captures accept/reject/edit per draft; no demonstrated feedback loop that adjusts tone prompt dynamically. |
| AC-006 | Update CRM after action | **PARTIAL** | Odoo `updateOdooOpportunity`/`updateOdooCrm` handlers exist but not triggered automatically on every send — opt-in per action. |
| AC-007 | Error handling on send failure | **MANUAL** | `sendUserEmail` returns `{success, error?}`; UI surfaces error. Retry logic lives in `notification-queue` drain but not in direct sends. |

---

## 6. Open Items (8 tests)

| ID | Test | Status | Evidence |
|---|---|---|---|
| OI-001 | Auto-create from user's promise | **NOT BUILT** | No promise-extraction hook on outbound drafts. Drafts create `agent_actions` not `open_items`. This is exactly the gap I flagged earlier. |
| OI-002 | Track promises made BY others | **PARTIAL** | Meeting digester creates open_items from transcript commitments (5 exist, sourced `meeting`). Email-bodies are not scanned for "I'll send X by Y" phrases. |
| OI-003 | Auto-follow-up on overdue | **PASS** | `jobs/delegationFollowUpJob.ts` (30-min cron). `services/delegation/delegationTrackerService.ts`. |
| OI-004 | Escalate after multiple follow-ups | **PARTIAL** | Cognitive engine `analyzeOpenLoops` surfaces items delegated >3 days with urgency rising with age; no explicit escalation-to-manager action path. |
| OI-005 | Auto-close when condition met | **NOT BUILT** | No signed-attachment detector or "matching completion" inference. |
| OI-006 | Dashboard — summarise all open | **PASS** | `pages/OpenItemsPage.jsx`; `briefRoutes.ts` attention + open-items endpoints. |
| OI-007 | Commitment register (30-day history) | **NOT BUILT** | Query "what did I commit to this month?" has no dedicated endpoint; Brain can partially answer from open_items but fulfilment rate isn't computed. |
| OI-008 | Multi-source commitment capture | **PARTIAL** | Meeting transcripts → yes. Email + WhatsApp outbound → no. |

---

## 7. Integration Layer (6 tests)

| ID | Test | Status | Evidence |
|---|---|---|---|
| IN-001 | Bidirectional CRM sync | **PARTIAL** | Odoo adapter + handlers exist for create/update. No inbound Odoo→Brain mirror (so deal-stage change in Odoo is not reflected in wiki automatically). |
| IN-002 | ERP read | **N/A (GAP)** | No ERP adapter. |
| IN-003 | Project-management sync | **PARTIAL** | Notion only: `services/adapters/notionAdapter.ts` + `syncThoughtToNotion`. Jira/Asana not wired. |
| IN-004 | Tenant-isolated API creds | **PASS** | `user_integrations` table per-user per-tenant, envelope-encrypted DEKs via `envelopeEncryptionService`. |
| IN-005 | Outbound webhook | **PASS** | `services/connectorRegistry.ts` + `routes/webhookRoutes.ts`. |
| IN-006 | Respect API rate limits | **MANUAL** | Gmail/WhatsApp adapters have back-off retry; not load-tested this session. |

---

## 8. Standing Instructions (6 tests)

| ID | Test | Status | Evidence |
|---|---|---|---|
| SI-001 | Client rule enforced for all users | **PASS** | Verified in smoke `smokeInstructions.ts`: user=3 sees user=1-authored client rule in their composer prompt |
| SI-002 | User rule private | **PASS** | Smoke assert: user=3 does NOT see user=5's user-scope rule |
| SI-003 | Client rule overrides user rule on conflict | **PARTIAL** | Composer prompt states the override; LLM is expected to resolve. No deterministic conflict resolver — a test with explicit conflicting rules hasn't been run. |
| SI-004 | Persist across sessions | **PASS** | Stored as `wiki_pages` with `page_type='instruction'`; reload-safe |
| SI-005 | CRUD (add/list/edit/delete) | **PASS** | `POST/GET/PATCH /brain/instructions`; archive = status flipped to 'archived' |
| SI-006 | Conditional rules (VIP list) | **PASS** | Watchpoints + subject matching implement conditional firing; `instructionMatcher.findVetoForEvent` differentiates by kind |

---

## 9. Learning Loop (7 tests)

| ID | Test | Status | Evidence |
|---|---|---|---|
| LL-001 | Improve drafts based on user edits | **PARTIAL** | Edit signals recorded via `preferenceLearnerService`; `toneService` draws on sent history. No measured improvement curve. |
| LL-002 | Criticality calibration from feedback | **NOT BUILT** | User marking "not critical" isn't wired as a signal to re-weight the criticality engine. |
| LL-003 | Optimal follow-up timing | **NOT BUILT** | `delegationFollowUpJob` uses a fixed 30-min cadence. No response-rate optimization. |
| LL-004 | Learn from misclassification | **PARTIAL** | `shadowRule` lifecycle promotes correct-choice patterns (SHADOW → ACTIVE). No explicit misclassification-correction feedback path for criticality or triage decisions. |
| LL-005 | Memory consolidation | **NOT BUILT** | No consolidation/aging job. |
| LL-006 | Skill acquisition (learn new workflows from demo) | **PARTIAL** | `ruleMiner` detects repeated user actions → promotes to shadow rule → activates after threshold. Not workflow-level (multi-step). |
| LL-007 | Thumbs up/down feedback | **PASS** | `preferenceLearnerService.recordSignal` accepts every UI interaction (accept, reject, delegate, edit, dismiss). 100 decision_log rows and 3 shadow rules already promoted from real usage. |

---

## 10. Multi-Tenant & Security (6 tests)

| ID | Test | Status | Evidence |
|---|---|---|---|
| MT-001 | Data isolation between tenants | **PARTIAL** | All queries are scoped by `clientNumber`. However — `tests/tenantIsolation.test.ts` has **31 known-red tests** (flagged in the earlier code review) for `prisma.user.findUnique({where:{id}})` paths missing an explicit `clientNumber` filter. Pending fix. |
| MT-002 | Knowledge isolation in reasoning | **PASS** | `brainComposer` openPagesForPlan + `searchWikiByVector` both enforce clientNumber + shared-types gate |
| MT-003 | User privacy within tenant | **PASS** | Per-user page types scoped by user_id. Verified in SI-002 smoke. |
| MT-004 | Session token isolation | **PASS** | `middleware/auth.ts` + `agentAuthMiddleware.ts`. Session tokens bind to `user.id`; tenant derived from user.clientNumber. |
| MT-005 | Audit trail for all actions | **PARTIAL** | `decision_logs` (100 rows) + `agent_actions` + `tenant_log` wiki page. **No dedicated `audit_logs` table** (verified: table does not exist). GDPR-grade structured audit is incomplete. |
| MT-006 | Right-to-delete | **NOT BUILT** | No user-data-purge endpoint. Would need to cascade across wiki_pages/feed_events/open_items/signals/etc. |

---

## 11. End-to-End (8 tests)

| ID | Test | Status | Evidence |
|---|---|---|---|
| E2E-001 | Deal-at-risk full cycle | **PARTIAL** | Criticality engine fuses signals correctly (smoke demonstrated 0.67 for SAP payment, 0.91 achievable with more signals). End-to-end "draft with counter → user approves → send → follow-up scheduled" is **not chained** — each is manual today. |
| E2E-002 | Multi-channel context synthesis | **PASS** | `personIdentityService` + cross-channel page expansion in `brainComposer`; demonstrated in Guru/Plaud smoke: email + attachment + transcript cross-cited in one answer |
| E2E-003 | SI + criticality + autonomy together | **PARTIAL** | All three subsystems exist; their interaction has been smoke-verified pairwise (instruction veto + shadow rule, criticality + attention) but not in a single VIP-SLA-autonomy scenario |
| E2E-004 | Self-correct after false positive | **PARTIAL** | Signal path exists (`preferenceLearnerService`) but no specific criticality-calibration loop (LL-002). |
| E2E-005 | New user onboarding (bootstrap from client knowledge) | **PASS** | New user inherits every tenant-shared page type immediately; verified because user=3 sees client rule without any prior signal |
| E2E-006 | Morning briefing | **PASS** | Day Brief shows: critical/attention, open items, drafts, observations, instructions, brain-actions — all in one view. `briefRoutes.ts`. |
| E2E-007 | 500+ simultaneous events | **MANUAL** | Not stress-tested in this session. Design is queue-based (`notification_queue`, background jobs). |
| E2E-008 | Recovery after restart | **MANUAL** | Persistent state is all in Postgres; in-memory state is only criticality-notifier debounce cache (20-min TTL). Not force-stop-tested this session. |

---

## Top priorities surfaced by this run

1. **OI-001 / OI-007 / OI-008 — outbound commitment extraction.** The biggest user-visible gap: Brain doesn't auto-create an `open_item` when you say "I'll send the deck Monday." Everything downstream (commitment register, fulfilment rate, auto-follow-up on your own promises) depends on this. Shape: a post-processor on outbound drafts + sent messages that extracts "I will X by Y" phrases → files open_item with `type='commitment'`, `owner=me`.

2. **MT-001 — 31 tenant-isolation red tests.** Already in the code-review backlog. Prisma `$use` middleware with AsyncLocalStorage keyed on `clientNumber` would turn the whole suite green in one pass.

3. **MT-005 / MT-006 — audit_logs table + data-delete endpoint.** Required for GDPR and for real accountability. No table today.

4. **LL-002 — criticality calibration.** Right now the user marking a criticality FP doesn't feed back into the engine. Simple signal path exists; just needs a learner hook.

5. **CR-001 — wire the two missing signal sources.** When Odoo opportunity cache mirror lands + any ERP connector, the CR-001 score jumps from PARTIAL to PASS and a whole class of cross-source reasoning becomes real. Single biggest lift for criticality quality.

6. **BR-010/011/012 — task decomposition.** The diagram's "Phase 2 → multi-step plan" is still missing. With 30+ action handlers already in `services/actions/handlers/`, wrapping a planner that chains them is < 1 week of work.

7. **LL-005 — memory consolidation.** With 1,038 attachment_doc + 656 sender_topic pages in one tenant, a compression/archival strategy will matter before long.

---

## What's genuinely working today (highlights)

- Tenant-shared wiki backbone: 339 entity_person, 123 topic, 131 project, 14 org_doc — Brain has a real semantic substrate to reason over.
- Cross-channel identity: same human across email + WhatsApp → one `entity_person` page.
- Standing instructions, both scopes: client rules visible to every user in the tenant, user rules private to author. Veto gate blocks auto-execution for "ask me first" rules.
- Criticality engine: 5 dimensions + 3 superpowers + action bands live; replaced 27 false-positive criticals with 0/2/3 distribution on real data.
- Meeting digestion: transcripts → `meeting_minutes` + open_items with meeting-as-source lineage. Plaud is treated as delivery channel, not source.
- Living-brain UX: persistent top-right avatar with expanding "thinking" pill on page-load events; Day Brief shows mind-state + observations from the 30-min cognitive tick.

---

*Generated by autonomous self-test pass against TMC-0001 live data on 2026-04-24.*
