# Nexeo Brain Vision

**Simple & Smart - Thinking - Memory - Communicates (Accurately & Meaningfully) - Action (Authorized to Do Everything) - Self Follow-Up - Learn - Self-Healing - Self-Pruning**

## How the nine are governed (owner ruling, 2026-08-19)

**Every capability is governed by the model. Code holds guardrails only.**

The owner's words: *"we will govern all capabilities through LLM where we will have some
guardrail (like tenant and user scope etc will decide later in detail)."*

This was decided against measured evidence, not preference. Across 167 recorded defects,
**70 (42%) were code blocking or breaking a good answer** and **50 (30%) were the model
fabricating**. The guard layer has cost more than the model it was protecting against.

### What this means in practice

**The model decides.** Intent, action, parameters, wording. A capability the model can
express is a capability Brain has.

**A guardrail is an invariant about ANY action — never a list of which actions are allowed.**
That distinction is the whole ruling. An enumeration must be updated for every new capability
and is silent when someone forgets: `DISPATCHABLE_PLAN_STEP_KINDS` had 15 of 19 declared
capabilities, so `remove_open_item` died *after* the owner confirmed it (DEF-232, ~14 hits),
and `mark_contact_inactive` and `set_contact_scope` are in the same trap today. An invariant
covers capability #20 the day it is written.

The guardrails (details to be settled with the owner):

1. **Tenant and user scope** — never model-decided, ever.
2. **Target grounding** — a recipient, attendee, delegatee or item must resolve to a real
   record owned by this user, or the turn asks instead of guessing.
3. **Irreversible needs confirmation** — keyed on the *property* of the action, not on a list
   of verbs.
4. **No claim without a receipt** — the model may never say a thing was done without dispatch
   evidence. This is the one that keeps the 50 fabrication rows closed.

**Wording is the model's, facts are the system's.** A curated sentence may supply the FACT of
what happened; the phrasing must come from the model. A canned string is correct in exactly
one circumstance — the model is unreachable. (Owner, 2026-08-19: *"don't use any template
string, always respond through model."* It was echoing the template back byte-for-byte 19
times out of 21.)

### This binds the orchestrator too

Both crons — the 10-minute **conversational** pulse and the **nightly** evaluation — follow
this ruling when they choose a fix (owner, 2026-08-19: *"conversational cron and night cron
will also follow it"*). Concretely, for any defect where the model wanted to act and code
refused:

- **Adding the capability to an allow-list is NOT an accepted fix.** It repairs the instance
  and leaves the generator, which is how DEF-232's class reached ~14 occurrences.
- The accepted fix **removes the enumeration** or makes the two sides unable to disagree.
- A fix that moves authority from the model to code must state which of the four guardrails it
  is enforcing. If it is none of them, it is not a guardrail — it is the 42%.

### And it binds the orchestrator's OWN code, not only Brain's

Owner, 2026-08-19: *"always build & deploy under governance of LLM (not programatic or template
strings etc, nothing should be hardcoded)."*

The Build & Deploy stage decides things — which defect to work, what counts as a failure,
whether a fix held. **Those judgements belong to the model reading the evidence, never to a
literal in a script.** The first casualty was a list of 17 failure sentences hand-written in
`pulse.py`: a wording fix changed one of them, the detector was watching the sentence rather
than the mechanism, and a defect that recurred 71 minutes after its own fix was shown to the
owner as *fixed*. The chat analyst declares the signatures now, and with none declared the deck
says so rather than falling back to a default.

**What stays deterministic, and why it is not a contradiction.** These are mechanics, not
judgements — a model has nothing to decide here, and a non-deterministic answer would be a
defect:

- the deploy protocol (`chattr` unlock → build → the exact sha256 manifest → relock);
- the verification matrix (`npx tsc --noEmit`, `npx vitest run`, `git diff --check`) and its
  exact numbers;
- the four guardrails above;
- the nine capability names, which are this document.

The test: **does it decide, or does it execute?** A decision goes to the model. A mechanic
stays in the script, deterministic and auditable.

---

## Self-Pruning (capability 9) — what it is, and the standing inventory

**Self-Pruning is not disk cleanup. It is the removal of PARALLEL OWNERSHIP.**

Measured on 2026-08-31 at `d144edf`: the tree is 3.1 GB and the database 810 MB, but live
application source is **~14 MB**. Almost none of the weight is code, and almost none of the
harm is weight. The harm is that several concerns have **two or more live owners** — two Brain
composition paths, four morning briefs, three wiki linters, three WhatsApp senders, two contact
tables. Every one of those is a place where a fix can land on the side nobody is running.

That is why this capability sits beside Self-Healing rather than under housekeeping: a system
that cannot say which of its two implementations is authoritative cannot heal either of them.

### The four classes — a candidate is worthless until it is classified

Nothing is deletable because it *looks* unused. Every candidate belongs to exactly one class,
and the class decides the procedure.

**Class 1 — confirmed dead: zero static, dynamic, registry, script, or runtime references.**

- Client pages: `ClientConfigPage`, `SystemConfigPage`, `TenantPage`, `KnowledgePage`.
- Client components: `BrainAvatar` (owner, 2026-08-24: *"remove it from all pages"*),
  `CustomActionTab`, `ActionForms`, `ActionExecutionTab`, `WikiTab`.
- Server: `pipeline/hybridSearch.ts`, `pipeline/queryRewriter.ts`, `pipeline/reranker.ts`,
  **`pipeline/chunker.ts`**, `slaMonitorService.ts`, `middleware/pubsubHandler.ts`,
  `artifactService.ts` (with `general_artifacts` / `user_artifacts`, both 0 rows).
- Routes mounted but unreachable from the rail: `/chat-legacy`, `/brain/memory`, `/thoughts`,
  `/welcome`. Rail pages standing on 0 rows: `/agents`, `/schedules`.

Unmount the route before deleting the page, and remove the emitted artifact with the source —
`tsc` does not delete output for a deleted input, so a stale `.js` outlives its `.ts`.

**Class 2 — dead product still executing.** ~400 KB of source that costs **CPU and LLM calls,
not disk**: the legacy TMC chat stack (`chatRoutes`, `conversationRoutes`, most of
`controllers/`, `promptService`, `memoryService`, `newsService`, `knowledgeBaseService`); the
vendor services no Brain path calls (`groqService`, `openaiService`, `openrouterService`,
`domainLLMService`, and the second `controllers/chat/llmRouter.ts`); empty work still on a
timer (`index_events` every 10 s, hourly `proactive_alerts`, the 4 am `chunks` backfill, the
agent scheduler on 0 rows); and jobs with no production timer (`openItemFollowUpJob`,
`delegationFollowUpJob`, `junkContactCleanupJob`, `gmailFeedPoller.pollAllActiveUsers`,
`embeddingBackfill`, both follow-up workers). **Kill the switch first, delete the files
second** — two of those workers send outbound mail, so dropping them silently changes Self
Follow-Up.

**Class 3 — redundant but load-bearing: COLLAPSE, never delete.** Both sides are live, so
deleting either removes behaviour. Pick one owner, migrate every reader and writer to it, prove
the other has no live use, then retire it.

- **Compose:** `reasoningCompose` + `brainTools` is production; the `brainComposer` legacy tail
  is the `BRAIN_USE_REASONING=never` rollback; `agenticReader` is a **third** path that skips
  compose, preview and dispatch entirely.
- Wiki lint ×3, morning brief ×4, reflection ×2 — each writes a *different* table, so none is
  a no-op deletion.
- WhatsApp: `tenantWhatsappSender` is canonical, but the notification drain still goes through
  `whatsappAdapter` → `whatsappService`. That is a genuine dual path, not a wrapper.
- Feature-flag constants that gate nothing — only `ADK_AGENTS` is ever read. **Deleting the
  unused constants is cleanup; deleting the systems they name is not.**

**Class 4 — never pruned.** Everything under `server/src/services/knowledge/` is imported;
there is no dead Brain file. `server/dist` is the immutable deployed artifact (`chattr +i`).
WhatsApp session directories, `.env` and tokens, migration history already applied, audit and
receipt tables (empty is not unused), unique/foreign-key/tenant indexes, and **other pm2 apps
on this box**.

### Two corrections, because a wrong "safe to delete" here causes an outage

This section is a governing document. Both were verified by execution on 2026-08-31, and both
contradict a self-pruning audit that called them safe.

1. **`agents/.venv` (728 MB) is NOT unused — it is a running production service.** pm2
   `tmcai-agents` executes `/var/www/tmcai/agents/.venv/bin/uvicorn` (3 days uptime, 0
   restarts), it answers on `127.0.0.1:8080`, and `healthRoutes.ts:307` polls it through
   `AGENT_WORKER_URL`. `feature_adk_agents` gates whether **Brain delegates work** to the
   fleet — it does not gate whether the service exists. Deleting the venv deletes the
   interpreter the app is running from. This single item was 728 MB of an 866 MB slice labelled
   *"Risk: None"*; the real safe total there is ~138 MB.
2. **`server/src/pipeline/*` is not wholly dead.** 9 of its 13 files are referenced
   (`embedder`, `piiService`, `gcpRetrieval`, `retriever`, `vectorStore`,
   `vertexVectorSearch`, `sectionRetriever`, `contentSanitizer`, `outputSanitizer`). Only four
   have zero references, and the fourth — `chunker.ts` — was missed by the audit that found the
   other three.

The lesson generalises: **a feature flag defaulting false does not mean the code behind it is
idle, and a directory is not a unit of deadness.** Classify per file, per process, per timer.

### Where the size actually is, so effort goes where it pays

Deleting source barely moves either number. Measured 2026-08-31:

| | Now | The lever |
|---|---|---|
| Disk 3.1 GB | `node_modules` 1008 MB · WhatsApp sessions 967 MB · `agents/.venv` 728 MB (live) · `.git` 117 MB | Four `dist.pre-*` snapshots (77 MB) and retired orchestrator logs (~61 MB) are the only safe disk wins |
| DB 810 MB | `llm_spend` **561 MB / 2,614,296 rows**, 91% older than 30 days · `wiki_pages` 124 MB (live) | **Retention, not deletion** — archiving `llm_spend` past 30 days takes the DB to ~300 MB |

`llm_spend` is 69% of the database and is the live cost ledger, not junk. Its size is a
retention policy that was never written, and the spend page must keep range-querying after any
archive or it will under-report the way `system_config` did (OPT-001).

### The order of operations

1. Establish that a candidate has **no** static, dynamic, registry, script or runtime reference.
2. Remove Class 1 — the old search pipeline, the unused SLA service, the Pub/Sub middleware.
3. Retire the empty artifact subsystem whole: service, seed code, test exemptions, and its two
   tables in one idempotent migration.
4. Remove unused packages (the superseded Google AI SDKs) after checking emitted JS, scripts and
   configuration-driven loading.
5. **Consolidate the duplicate reasoning paths BEFORE deleting the legacy composer** — instrument
   every real fallthrough from reasoning to legacy, close each reason at its class, and prove
   zero fallthrough across text, voice, image, confirmation, action and failure turns.
6. Remove expired API aliases and superseded pollers only after checking access logs and
   schedulers.
7. Archive retired orchestrator logs, old snapshots and dated backups out of the repository.
8. Drop empty snapshot tables through hand-written idempotent migrations; remove duplicate
   indexes while preserving every constraint-owning and tenant-scope index.
9. Clean generated builds before rebuilding, so stale compiled files cannot survive their source.

Never batch a Class 2 or Class 3 change with a Brain messaging-path change.

### What governs a deletion

The ruling above applies here unchanged: **does it decide, or does it execute?**

Whether something is dead is a **judgement on evidence** — imports, timers, row counts, access
logs, live process identity — and it belongs to the model reading that evidence, never to a
hard-coded list of filenames. What stays deterministic is the *proof*: `npx tsc --noEmit`,
`npx vitest run`, the build, `git diff --check`, and live acceptance for anything on a
messaging path. **A deletion that compiles is not a verified deletion**, and a test that fails
if a retired module or alias is reintroduced is part of the removal, not an optional extra.

Keep, always: active sessions, audit and receipt data, migration history, and any uncommitted
work in the tree that belongs to the owner or another agent.
