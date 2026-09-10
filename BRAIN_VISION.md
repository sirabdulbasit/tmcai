# Nexeo Brain Vision

**Thinking - Memory - Communicates (Accurately & Meaningfully) - Action (Authorized to Do Everything) - Self Follow-Up - Learn - Self-Healing - Self-Pruning (incl. Simple & Smart)**

> **Owner ruling, 2026-08-31: "Simple & Smart" is merged INTO Self-Pruning. Nine become
> eight.** They were never two capabilities. Simplicity is not a thing Brain has; it is the
> *result* of pruning — of one owner per concern, one path per reply, one store per fact. A
> system carrying two composers, four morning briefs and 10,143 dead wiki pages cannot be made
> simple by trying harder to be simple. It becomes simple when the duplicates are gone.
> **Self-Pruning is therefore scored on both: what has been removed, and how simple what
> remains is to use.**

## How the capabilities are governed (owner ruling, 2026-08-19)

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
- the eight capability names, which are this document.

The test: **does it decide, or does it execute?** A decision goes to the model. A mechanic
stays in the script, deterministic and auditable.

---

## Self-Pruning (capability 8, absorbing Simple & Smart) — what it is, and the standing inventory

**Self-Pruning is not disk cleanup. It is the removal of PARALLEL OWNERSHIP — and, since
2026-08-31, it is also where SIMPLICITY is scored.**

### OWNER RULING, 2026-09-10 — the THREE aspects it must cover

*"Self Pruning has following aspects — 1. Files Pruning: where it analyze and remove
redundant and uncessary files (that was created during building). 2. Code Pruning: It will
analyze and remove uncessary and redundant code and make it more smart in coding (UI and
Functionality should not be changed). 3. DB Pruning: here it will read all tables and its
data and remove redundant and uncessary tables and their data, it will also remove
duplication records like in pruning contacts and wiki and anyother."*

This **replaces** the two-aspect ruling of 2026-09-08, which folded files and code into one
bucket. They are separated here because they fail differently and are proved differently: a
leftover file costs nothing until it is served, whereas rewriting live code can change what
the owner sees. The classes below still govern every deletion, and the merge rule below
still bounds the score.

**ASPECT 1 — FILES PRUNING: what the building left behind.**

Not source. The *residue* of having built: emitted artifacts whose source is gone, dated
backups, retired logs, old snapshots, generated output that outlived its input. The named
hazard is that **`tsc` does not delete output for a deleted input**, so a `.js` outlives its
`.ts` inside `dist` and keeps shipping — the one pruning fault that reaches production by
itself. Measured on 2026-09-08 the day PRUNE-001 deleted four sources: four orphaned `.js`
were still in `dist`, found by the pack rather than by a person.

**ASPECT 2 — CODE PRUNING: less code, smarter code, and NOTHING the owner sees changes.**

Two obligations:

1. **Remove** unnecessary and redundant code — by the four classes, never by filename.
2. **Modernise** what survives. Where a hand-rolled mechanism has been superseded by
   something the platform or the codebase now provides, collapse onto the newer one. In a
   Class 3 collapse the surviving owner should be the current idiom, not merely the older
   one.

**THE BINDING CONSTRAINT, and it is the owner's own words: the UI and the functionality do
not change.** This is what separates pruning from rewriting. A code prune is therefore a
*behaviour-preserving* change and must be provable as one:

- the full suite green **before and after**, with no test edited to accommodate the change —
  a test changed to fit a refactor is the refactor marking its own homework;
- no change to what the client renders, unless the ruling being applied is about the UI;
- **never batched with a Brain messaging-path change** (the standing prohibition below), so
  that if the owner's experience does shift, the cause is not ambiguous.

"Smarter" is not licence to redesign. If a simplification would change a reply, a screen or
an order of operations, it is a product change and needs its own decision — it is not
pruning.

**ASPECT 3 — DB PRUNING: read every table, then remove what no answer should ever use.**

Whole tables as well as rows — an empty or superseded table is a candidate, dropped only
through a hand-written idempotent migration. Three faults, three tests, because they need
different fixes:

| fault | what it means | what proves it |
|---|---|---|
| duplicated | the same fact stored twice | two rows a human would call one thing — duplicate contact names, a person in both `entities` and `persons` |
| redundant | one concern owned by two stores | a fact retrievable from more than one table, so a write to one leaves the other wrong |
| noisy | rows that exist but no answer should ever use | stale and orphan wiki pages, dead tuples, caches past their TTL |

Contacts and wiki are named by the owner, **"and anyother"** — so the sweep reads every
table rather than a curated list.

**"Without loss of any useful data" remains binding, not a courtesy.** Audit rows, receipt
tables and applied migration history are Class 4 — *empty is not unused*. A prune that
cannot state what it kept and why is refused, and nothing is deletable because it looks
unused.

**THE MEASUREMENT OBLIGATION THAT COMES WITH ALL THREE.** On 2026-09-08 the evidence pack
carried **zero** lines about database redundancy and **zero** about the codebase, so both
would have been scored as a read of this document — exactly how `Learn` sat at 42 with
nothing measuring it. Every aspect above has evidence lines in `evidence-pack.sh`. **An
aspect added here without an evidence line is not a capability, it is a wish.**

### Why the merge, and the one way it must not be abused

Simple & Smart scored **36** — the lowest of the nine, and the orchestrator's declared target
for 17 consecutive turns with a hit rate of **1/17**. Self-Pruning scored **61**. Those two
numbers describe the same illness from two ends: the system is hard to use *because* it carries
two of everything, and every attempt to raise "simplicity" directly failed because simplicity
is not an ingredient you add.

**The merged capability must not inherit 61.** A merge that quietly launders a 36 into a 61 is
the most expensive thing in this document: it would retire the loop's only honest signal that
the product is hard to use. The merged score is bounded by the WORSE half until re-measured
against both halves — what was removed, *and* whether a real turn got simpler.

The two halves, and neither alone is the capability:

- **Removal** — one owner per concern, one path per reply, one store per fact.
- **Experience** — fewer questions back, fewer steps to a result, no system vocabulary, no
  stale or duplicate data surfacing in an answer.

Junk data fails the second half without touching the first. **A contact that exists twice, a
memory that contradicts itself, and a wiki page that has been dead for months are not disk
problems — they are wrong answers waiting to be retrieved.** That is why data pruning belongs
here and not in housekeeping.

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

### Data pruning — Contacts, Wiki, Memory (the half that reaches the owner)

Code pruning makes the tree smaller. **Data pruning changes what Brain says.** Every row below
is reachable by retrieval, so junk here is not inert — it is a candidate answer. Measured
2026-08-31.

**Wiki — the worst of the three, by a distance.**

| Status | Pages | Share |
|---|---:|---:|
| `active` | 2,766 | **21%** |
| `stale` | 5,373 | 42% |
| `orphan` | 4,770 | 37% |
| **Total** | **12,909** (124 MB) | |

**10,143 of 12,909 pages — 79% — are stale or orphan**, and `wiki_pages` is the corpus Brain
actually retrieves from (`brainRetrievalPlanner` + `wikiEmbeddingService`). Four in five
candidates for any wiki-grounded answer are dead. This is the single largest quality risk in
the product, and it is invisible in every disk and token measurement.

Pruning rules: an **orphan** (nothing links to it, nothing sourced it) is a deletion candidate
once its source is confirmed gone; a **stale** page is a *re-derivation* candidate, not a
deletion — the subject may still be live while the page rotted. Never bulk-delete by status
alone: three linters disagree about what stale means (§ Class 3), and `wikiStaleness.ts` exists
precisely because they once disagreed 60 vs 90 days. **Fix the one-owner problem before running
any mass wiki prune**, or two linters will re-create what the third removed.

**Contacts — duplication across two stores plus a third copy in the wiki.**

`entities` **916** · `persons` **974** + `person_facets` **1,953**. Neither is a subset of the
other, and the wiki holds entity/sender pages as a third representation. Live junk today:
**24 entities with neither email nor phone** (unreachable — they can be named in an answer but
never acted on, which is how a delegation resolves to a dead target) and **24 duplicate names**
(the same person answering twice, so the model picks one and the owner sees the wrong history).

The resolver reads `persons`; the Contacts UI reads `entities`. **Pick one source of truth
before pruning either** — deleting from the store the resolver does not read removes the
evidence and leaves the fault. Junk removal itself is safe and should be continuous: no
identifier, no activity, no link, and no wiki page = prune, with the merge of duplicates
preferred over deletion so history survives.

**Memory — small in rows, dangerous in contradiction.**

`user_memories` **13** · `user_learning` **11** · `governed_brain_memories` **2** ·
`clarification_memory` **0** · `user_profile_memory` **0**.

Twenty-six live rows across **five stores**, and the `UserMemory` schema comment is stale — it
says the model was replaced by `user_profile_memory`, after which `user_memories` was re-added.
Both exist. **Here the pruning target is not volume, it is contradiction and provenance:** a
memory with no source turn, a memory contradicted by a later one, and a memory duplicated
across two stores are each a wrong answer with full confidence behind it. Prune on: superseded
by a newer statement, never re-confirmed after N surfacing opportunities, or no traceable
origin. Collapse the five stores to one owner; until then, a "forget that" from the owner must
delete from **all** of them or the fact returns.

**The standing rule for all three:** junk data is pruned **continuously and by evidence**, not
in a one-off sweep — and every prune is reversible for one retention window before it is final,
because a deleted contact, memory or wiki page is indistinguishable to the owner from Brain
having forgotten.

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
