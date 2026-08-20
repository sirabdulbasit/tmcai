# Build log — written by Claude, read by Codex

One `## Iteration N` section per build turn, appended, newest at the bottom.
Codex reviews these entries against the real diff, so a claim here that the diff
does not support is the single most useful thing for the reviewer to catch.

Required per iteration: what the fix queue said, what was changed and why, the
verification numbers (tsc / vitest, exact figures), what was NOT done, and the
honest expectation of which criterion should move.

## Iteration 1 — 2026-08-18

**Mode / scope.** The brief carries three competing instructions (clear a deck tag ·
build the dispatcher gap · CAMPAIGN SUSPENDED, only job = make HEAD deployable). The
campaign section governs, as it has every turn since the 2026-08-14 owner ruling that an
iteration is deployed before the next one starts. Its data is stale, though: it says 1
undeployed commit (`6057c9d`); the truth at turn start was **12 commits** between
deployed `6416743` and HEAD `d324488` — my five (DEF-230, DEF-231 + docs) plus seven
orchestrator deck/loop commits.

**What actually blocked release this turn.** The matrix at HEAD `d324488` was RED:
`npx vitest run` → **1 failed | 2791 passed**. The failure was
`tests/orchestratorPulseRoute.test.ts` — the contract test that executes the real
`scripts/orchestrator/pulse.py --json` — still pinning the old five-phase list, while
the orchestrator's own commits (`8964dbb` "two pulse kinds", `0629bfd`, `a0358ed`)
redesigned the pulse: `PHASE_ORDER_CONVERSATIONAL = ["Chat Analysis", "Build & Deploy"]`
vs `PHASE_ORDER_EVALUATION` (five), selected by `state/pulse-mode`, which is currently
`conversational`. So the one release blocker was a superseded test assertion, and closing
it is precisely this turn's job.

**Change.** `server/tests/orchestratorPulseRoute.test.ts:171-189` — the phase-name
assertion now pins the contract PER MODE, against the `pulse_mode` the collector itself
reports: `conversational` → `['Chat Analysis', 'Build & Deploy']`, otherwise the five
evaluation phases; plus `expect(['conversational','evaluation']).toContain(d.pulse_mode)`.
Why this is the mechanism: the panel reads phase names verbatim, so the test must fail on
a rename — but it must not fail because the box happens to be mid-conversational-pulse
when vitest runs. Pinning against the collector's own reported mode keeps the test
deterministic across mode changes while still catching every rename in either list.
`pulse.py` itself is untouched (forbidden path, and correct — the redesign is the
orchestrator's intent; the test was the stale side).

**Verification (after the last edit, from `server/`):**
- `npx tsc --noEmit` → exit **0** (via the committed `server/.npmrc`, DEF-231)
- `npx vitest run` → **223 passed | 1 skipped** files; **2792 passed | 0 failed**
  (7 expected fail | 21 skipped | 1 todo, of 2821)
- `git diff --check` → clean
- `npm run build` was NOT run in this tree — `server/dist` is `chattr +i` and is the
  deployed artifact (CLAUDE.md). Build verification stands on the clean-clone build at
  `ec8ed31` (exit 0, artifact verified). Every commit since (`92917bb..d324488` and this
  one) touches no `server/src` file — verified with `git diff --name-only` — so the
  emitted artifact identity is unchanged. `--noEmit` is the build check.

**CAPABILITY:** RELIABILITY-ONLY
**PREDICTED:** +0
**MECHANISM:** a superseded harness-contract test made the release gate red at HEAD;
updating the pin to the redesigned two-mode contract restores a green matrix. Nothing
the owner receives changes.
**FALSIFIER:** the deploy phase still reads vitest RED at this HEAD; or the next
evaluation-mode pulse emits five phases and this test fails on it.

**Governing-docs verdict.** Neither *progressing* nor *circling* in the Brain sense: no
owner-visible Brain behaviour changed, so no DEF row and no symptom tag. This is the
supersedure pattern (DEF-226/DEF-165 precedent): the code moved by design, the test was
the stale half. No chat-archive entry is warranted — no owner conversation reported this.

**What I did NOT do, and say so plainly:**
- **No deck tag closed** (`whatsapp-ptt-media-not-ready`, `stale-signoff`,
  `wrong-from-account`) — the campaign section forbids new work while the deploy debt
  stands. What was done instead: the release blocker on that very debt.
- **The dispatcher gap was NOT built**, though I re-verified it live at HEAD this turn
  and it is real: `DISPATCHABLE_PLAN_STEP_KINDS` (`brainComposer.ts:184`) omits
  `mark_open_item_done`, `remove_open_item`, `record_preference`, all three present in
  `IMMEDIATE_INTERNAL_ACTION_TYPES` (`brainComposer.ts:211-223`); the rejection fires on
  the confirmed-plan path. The chat analyst's reading is confirmed — same kind
  executable on one path, rejected on the other (`protection-with-two-implementations`).
  This is the first build after the debt clears, and it must unify the sets, not patch
  `remove_open_item` alone.
- **I did not deploy** (forbidden; D-22 — the orchestrator deploys by hand).

**The real obstacle, named.** Deployed-sha has been `6416743` all session while 13
deployable commits accumulated. The work is not reaching production because the deploy
phase has not run — that is the finding. HEAD is green under the exact documented
matrix commands as of this entry; nothing in the tree blocks `deploy.sh`.

**Honest prediction.** No criterion moves from this change (it is test-only). What would
prove me wrong: any benchmark case moving more than noise, which would mean this entry
misattributed something. The prediction that matters: after deploy, the owner's next
"delete all actionable items" turn still fails with the dispatcher string — until the
set-unification build above ships.

## Iteration 2 — 2026-08-19

**Remediation turn (attempt 3 of 3): "Iteration 1's review closed WRONG."** The review
log holds TWO `## Iteration 1` sections (it is an untracked file spanning loop resets;
line numbers below are as of this entry). Rather than guess which one the template
resolved, both are closed here, finding by finding, with the closing commit and
file:line — every closing commit is an ancestor of the deployed SHA `41381db`, so these
closures are not just committed but LIVE.

### Section at line 11 — DEF-186 backlog cleanup, reviewed at `8ae7dfa`

| Finding | Closed by | Where it stands at HEAD |
|---|---|---|
| CRITICAL — `.catch(() => {})` fabricated "withdrew" after a failed mutation | `08237bb` (DEF-187/188), hardened `e441723` (DEF-189) | Every item mutation goes through `guardedItemUpdate` (`openItemsBacklogCleanupJob.ts:212-228`) — tenant+user+id+status+updatedAt compare-and-set returning `count===1`; every archive site checks `if (!ok) { stats.raced++; continue; }` before any stat or debt (`:369-386, :405-411, :439-445, :457-463, :478-484`). No swallowed catch remains on any mutation. |
| HIGH — `staleThresholdDays=0` mapped to the default instead of disable | `08237bb` (DEF-187) | Zero passes through unchanged as the owner's DISABLE (`:11-12` docblock, `:325-338` — the resolved value is used verbatim; `zombieItemPolicy` owns the zero-means-disabled semantics). |
| HIGH — notice had no durable handoff; cancel committed before enqueue; `clientNumber=null` skipped | `08237bb` (debt written IN the archiving write, `:381-383`) · `8576274` (DEF-190 outbox batches) · `2acb272` (DEF-208: claim + queue insert + sent-mark in ONE `prisma.$transaction`, `settleBatch` `:742-829`) · `41358ab` (DEF-209 paging past claimed debt) | The dispatcher runs every tick regardless of what the tick archived (`:284-286`); the all-tenants entry reads the tenant registry, no null skip exists (`:235-246`). |
| MEDIUM — C4 register not addressed | not this saga's scope | The review's own §6 assigns C4 to "the next fresh turn"; still open, named below. |
| CARRIED CRITICAL — tenant isolation absent from selection/mutation | `08237bb`/`e441723` | Entry point takes the tenant; every query carries `clientNumber` (`:265, :303, :532-535, :617, :746`); dup maps live inside the (tenant,user) partition (`:340-342`); settings resolve per `(userId, clientNumber)` (`:328`). |

### Section at line 284 — DEF-193 channel cap, reviewed at `e413758`-era tree

| Finding | Closed by | Where it stands at HEAD |
|---|---|---|
| CRITICAL — deterministic `(+N more not shown)` on a live owner path (AGENTS.md §2.4) | `c98a2c6` (DEF-194) | `transportBudget.ts:26-29` names this finding verbatim; the count leaves as STRUCTURED DATA (`omittedItems`, `:74, :245`); `channelRenderer.ts:176-178` — "this layer adds no words." |
| HIGH — wrapped list items mutilated (line-based algorithm) | `c98a2c6` | Whole semantic blocks are dropped, never a bullet head without its continuation (`transportBudget.ts:236-245`). |
| Directive 4 — consolidate the two WhatsApp truncators | `c98a2c6` | `WhatsAppInbound.ts:715-716` calls the SAME `fitToTransport`; parity pinned by `tests/def194OneTransportBudget.test.ts`. |
| Directive 5 — zero failed tests / restore the build-log record | `41381db` (mine, Iteration 1) for the red pulse contract; record restoration is orchestrator-owned per the review's own words ("not charged to the Builder") | vitest is 0-failed at HEAD (numbers below). |
| **Directive 3 — composition knows the channel budget — STILL OPEN** | — | Verified this turn: neither `brainComposer.ts` nor `brainAskRoutes.ts` references `WA_TRANSPORT_MAX_CHARS`/`transportBudget`. The renderer no longer lies, but the composer can still write "here is the full list" prose that transport then shortens (with an honest structured count). This is the one residual; closing it means giving the composition boundary the budget, which is NEW design work, not remediation — building it at attempt 3 of 3 would add exactly the review surface this turn is told not to add. Recommended as its own future iteration. |
| MEDIUM — 3900 ceiling may worsen brevity | accepted-by-design | Documented judgement in `transportBudget.ts` docblock; brevity is a composition decision (same residual as directive 3). |

### Campaign C-3 status (scope note, not an increment)

Increment 1 (classifier + counter reaching the owner) is **deployed** as of `41381db` —
DEF-217 (the notice path) and DEF-230 (selection rule corrected by the first production
read) are both under the deployed SHA. The Done-when's production quote exists (the
2026-08-18 read: the CL-033 number was 14/14 answered — the campaign's premise refuted;
the real noise is one item pushed 17× by four producers). What is still owed is the LIVE
observation of a notice reaching the owner — `selfpruning.withdrawal_notice_enabled` and
the noise notice path need a production observation before "Done" is claimed. Increment 2
(the digest) is NOT started this turn: remediation wins on scope.

**CAPABILITY:** RELIABILITY-ONLY
**PREDICTED:** +0
**MECHANISM:** no code changed this turn; the turn closes review findings by evidence —
each numbered risk mapped to the deployed commit and line that closed it, plus one named
residual (composer budget awareness) that was verified still open.
**FALSIFIER:** any of the cited lines not containing what this entry claims (Codex can
diff every citation); or a new occurrence of a closed finding in production.

**Verification (from `server/`, after last edit):** `npx tsc --noEmit` exit **0** ·
`npx vitest run` **223 passed | 1 skipped** files, **2792 passed | 0 failed** (7 expected
fail | 21 skipped | 1 todo, of 2821) · `git diff --check` clean · no in-tree
`npm run build` (dist immutable, CLAUDE.md; no `server/src` change this turn).

**Symptom tag:** none closed — say so plainly. This turn ships no owner-visible change;
the deck tags (`whatsapp-lid-activity-rejected`, `stale-contact-data`,
`whatsapp-ptt-media-not-ready`, `wrong-from-account`, `stale-signoff`) are untouched. What
was done instead: the remediation accounting above, which is the brief's stated scope.

**Governing-docs verdict:** accounting turn, no new root cause and no new patch —
neither *progressing* nor *circling* applies; nothing moved in `brain_change_log.md`
because no defect was fixed or introduced.

**What would prove this entry wrong:** a cited closure line that does not exist at HEAD,
or Codex demonstrating one of the five "closed" findings still reproducible on the
deployed artifact.

**For the next FRESH turn (not this one), in priority order from the standing evidence:**
the dispatcher-set unification (`DISPATCHABLE_PLAN_STEP_KINDS` `brainComposer.ts:184` vs
`IMMEDIATE_INTERNAL_ACTION_TYPES` `:211`, rejection `:2670` — ~13 owner-facing hits,
re-verified live this session; derive both sets from the dispatcher's real case labels),
then the C4 register mechanism (B02/B06/B10/B12), then composer budget awareness.

## Iteration 9 — 2026-08-19

**Remediation turn (attempt 2 of 3): "Iteration 4's review closed WRONG."** The review
log's only `## Iteration 4` section is the DEF-186 self-prune notice outbox review. Every
one of its numbered risks was closed by a LATER commit that is an ancestor of the recorded
deploy SHA `41381db` — verified this turn against the code at HEAD, finding by finding,
with the mechanism read rather than the commit message trusted:

| Iteration 4 finding | Closed by | Where it stands at HEAD |
|---|---|---|
| CRITICAL 1 — revalidation not atomic with enqueue; a restored item could still be announced | `2acb272` (DEF-208) | `settleBatch` holds final revalidation, per-row claim CAS on (tenant, user, id, status, updatedAt), the queue insert ON THE SAME `tx`, and the batch sent-mark in ONE `prisma.$transaction` (`openItemsBacklogCleanupJob.ts:742-829`); `enqueueBrainPrompt` accepts `tx` (`brainPromptQueueService.ts:84,152,421`). A restore that commits first makes the claim match nothing; one that arrives later serialises behind it. Dispatch is deliberately outside — a queued row, not a sent message, so nothing rolls back a WhatsApp send. `def208TransactionalEnqueue.test.ts` covers it. |
| HIGH 2 — a sent batch permanently consumed an item id, erasing a later withdrawal event | `417b4a2` (DEF-202) + migration `20260817_self_prune_notice_event_tokens` | Identity belongs to the withdrawal EVENT: a token is minted when the debt is recorded (`:184`), batches claim by token (`:579-582`), and `clearOwedFlags` refuses to clear a later event's flag (`:880-887`). A restored-and-re-withdrawn item carries a NEW token and forms a new batch. |
| HIGH 3 — concurrent dispatch could create two sendable batches (uniqueness only on random dedup_key) | `417b4a2` (DEF-202) | The dedup key is now DETERMINISTIC from the sorted member event tokens (`:652-659`), so the existing unique index IS the ownership constraint — the second writer collides and stands down (`:672-681`). Any residual overlap is serialised row-by-row by the claim CAS inside the DEF-208 transaction. |
| MEDIUM 4 — the 200-row cap could starve unclaimed debt behind failing clears | `41358ab` (DEF-209 paging) | The owed scan pages past claimed rows until it finds unclaimed debt, bounded by `OWED_SCAN_PAGES`, and says OUT LOUD when it stops with debt unread (`:611-643`). |
| MEDIUM 5 — release evidence red | closed at THIS HEAD | The red pair was the orchestrator's own pulse-contract drift; the pulse committed its WIP in `81ba131` this session and the full matrix is now green (numbers below). |
| MEDIUM 6 — measured C4 untouched | out of scope, per the review's own §6 | Assigned to "a fresh iteration" by the directive itself; named as a residual, not smuggled in here. |
| Directive 5 — settings authority through mutating background callers; tenant-scoped delegation enumeration | `bb0cf57` (DEF-191) | `delegationFollowUpJob` resolves via `resolveOpenItemsSettings`; `no_user` HOLDS the item with a loud log, never inherits defaults (`:196-207`); the only cross-tenant read is the tenant REGISTRY, and every item query carries the tenant (`runDelegationFollowUpForTenant`). This also closes the review's carried finding 3b.1. |

All seven closing commits (`08237bb e441723 8576274 bb0cf57 417b4a2 2acb272 41358ab`) are
ancestors of `41381db` — these closures are recorded-deployed, not merely committed.

**What else this turn did — the release-blocking governance debt.** The chat analyst named
it verbatim: "DEF-232/233/234/235 are all UNLOGGED in brain_change_log.md (three-document
protocol violated: commits without DEF rows)" and "log DEF-232–235 with the correct
deployed-sha". Done: four rows added to `brain_change_log.md` §A (above DEF-231), each with
its capability block, falsifier, and symptom tag where one exists (`phantom-capability` on
DEF-232 and DEF-234; the others state plainly that no deck tag applies).

**And the deployed-sha discrepancy the analyst said the deploy seat must reconcile — RESOLVED
READ-ONLY, with evidence** (production-identity procedure, no mutation, `--no-optional-locks`):

- `server/dist` was REBUILT 2026-08-19 **20:50:06 UTC** and `tmcai-server` (pid 1154972,
  restarts 54) started 2026-08-19 **20:50:08 UTC** — two seconds later. PRODUCTION_OBSERVED.
- The artifact contains `internalActionExecutors.js` (exists only after DEF-232) and the
  DEF-034(a) wording — so the running code is POST-`41381db`. Artifact source class:
  the `23e255b` src tree (`f061cd90…`), i.e. everything through DEF-232/233/234/235 and
  DEF-034, but NOT DEF-236 (committed 21:13, after the build). STRONGLY_INFERRED (node
  loads at require-time; clone-rebuild reproduction still owed by the deploy seat).
- `state/deployed-sha` still says `41381db` (recorded 08-18 17:06Z) and the live dist
  manifest `3bf7a691…` matches NO entry in `state/deploy-manifests`. **The record is wrong,
  not the analyst's transcript reading.** `dist` is currently `chattr +i` again.
- Consequence for the deck: DEF-034(a)'s falsifier window and the `since` counters must be
  measured from 20:50Z (or from the earlier unrecorded restart, if any — S35 16:36 predates
  this build, so EITHER an earlier unrecorded artifact carried it or the model phrased the
  OLD curated fact similarly; not established, and said so rather than guessed).
- **This unrecorded build/restart violates the deploy protocol** (no manifest verify, no
  evaluation-chart row, no owner report, `deployed-sha` not moved). The actor is the
  orchestrator's own pulse ("approving its own build", `647a8d4`; "a click can actually
  build", `d2d73e1`). `scripts/orchestrator/**` is forbidden to me — the orchestrator must
  reconcile the record and bring its pulse deploys under `deploy.sh`'s bookkeeping.

**fixQueue entry targeted:** none, and here is why rather than silence — this is a
remediation turn and the campaign is suspended; the brief forbids new product surface. The
worst fixQueue entry (B07 C1/C6/C7 60: "Both items are marked as CANCELLED" contradicting
"outstanding") is real and untouched; it belongs to the next fresh turn.

**Verification (from `server/`, measured AFTER the last code-affecting state, at HEAD
`81ba131` + this turn's two doc files):**
- `npx tsc --noEmit` → exit **0**
- `npx vitest run` → **229 passed | 1 skipped** files (230); **2849 passed | 0 failed**
  (7 expected fail | 21 skipped | 1 todo, of 2878)
- `git diff --check` → clean (run after the final edit of this entry)
- `npm run build` NOT run in this tree — `server/dist` is `chattr +i` and is the running
  production artifact (CLAUDE.md); `--noEmit` is the build check. No `server/src` file
  changed this turn, so artifact identity is untouched by me.

**CAPABILITY:** RELIABILITY-ONLY
**PREDICTED:** +0
**MECHANISM:** no product code changed; the turn closes the Iteration 4 review by evidence,
pays the three-document debt on four shipped-in-fact commits, and establishes production
identity so the next deploy is measured against what is actually running.
**FALSIFIER:** any cited closure line not containing what this entry claims; or the live
dist manifest matching a recorded entry after all (I could not make it match any of the
last five).

**TARGET divergence, said explicitly:** the brief's target placeholder is malformed
("Simple @@TARGETCAP@@ Smart" — known orchestrator defect) and reads as Simple & Smart.
This turn does not move it: remediation wins on scope, campaign suspended. RELIABILITY-ONLY
+0 is the honest declaration, not a productivity claim.

**Symptom tag:** `phantom-capability` — partly closed, and precisely in this sense: the
shipped fixes (`010b130`, `76003a2`) predate the name-the-tag rule and never carried it;
this turn's DEF-232/DEF-234 rows and commit carry it on their behalf so the deck can link
reported→shipped. The three OPEN deck tags in the brief (the "reply send" demand, the
undeletable draft item, the verify-first magic word) are NOT closed by this turn — their
fixes are DEF-034(b) (not built), the DRAFT lifecycle floor (DEF-236 landed 21:13, row
still owed), and the confirmation-suppression class (DEF-151/161, open).

**Governing-docs verdict (rule 5):** the *turn itself* is accounting — neither progressing
nor circling. The four rows it logs: DEF-232/234 are the 17th recorded `phantom-capability`
occurrence closed STRUCTURALLY (gate derived from the dispatcher — the chart's §3 demanded
exactly that after the count reached 17); DEF-233/235 are new root causes (progressing).

**What I did NOT do, and am unsure about:**
- DEF-034(b) read-back-before-any-state-claim — the analyst's #1 — NOT built (structural,
  forbidden scope this turn). The DRAFT-delete fabrication (his item 1) therefore still
  stands in production.
- DEF-236 (DRAFT joins the lifecycle, committed by the pulse at 21:13 during this session)
  has NO change-log row — owed by its author or the next turn; I did not write it to avoid
  racing the pulse's own bookkeeping.
- The S35/S37 wording-provenance question is narrowed, not closed (see above).
- Operator directives D-5/D-11/D-1 etc. not advanced this turn — remediation wins on scope;
  D-11 is in fact moving via DEF-236, which is its prescribed structural fix.
- Unsure: whether the 20:50Z artifact was built from committed `23e255b` exactly or from a
  tree with uncommitted drift — only a clone rebuild against the manifest can settle it.

**Honest prediction:** no benchmark criterion moves (docs only). What would prove this turn
wrong: Codex finding a cited mechanism absent at HEAD, or the deploy seat reproducing the
manifest from `41381db` (which would mean my production-identity reading is wrong).
**Deployable at the end of this turn?** The matrix at this HEAD is green and the Iteration 4
findings are closed, so YES on the reviewed surface — but the deploy must FIRST reconcile
the unrecorded 20:50Z deploy (deployed-sha, manifest ledger, evaluation-chart row), or it
will be measured against a baseline production is no longer running.

## Iteration 12 — 2026-08-20

**Remediation turn (attempt 3 of 3): "Iteration 2's review closed WRONG."** The newest
`## Iteration 2` section (review_log.md:151 after rotation) is the wrong-referent review of
the DEF-197/198 prompt-wording repair, reviewed at deployed `5176c60`. Attempts 1 and 2
left no build entries (no Iteration 10/11 exists) — but the findings did not wait for this
turn either: **every numbered risk and directive was closed by DEF-199/200/201/203/213,
all five ancestors of the CURRENT deployed SHA `4bd6fbc`** (verified with
`merge-base --is-ancestor`, mechanisms read at HEAD, not trusted from titles):

| Iteration 2 finding | Closed by | Where it stands at HEAD |
|---|---|---|
| CRITICAL 1 — multi-subject evidence lets the model attach authoritative counts to the wrong task | `f50e1cf` (DEF-200) | **The resolver runs in code, before rendering**: `selectSubjectsForConversation` (`pushHistoryBlock.ts:229-242`) matches subjects' REAL titles (the DEF-199 join) against the conversation; `renderPushHistoryBlock` renders ONLY what matched (`:366-374`), and the no-match case withholds the record entirely with an explicit "NO ENTRY FOR THE ITEM UNDER DISCUSSION" block that also refuses item-denial generalisation (`:385-406`, DEF-203). The candidates are not supplied, so there is nothing to outvote the dialogue — closure by construction, not instruction. Both live call sites pass the conversation: `brainComposer.ts:2628` (reasoning) and `:3275` (legacy) via `conversationTextForPushHistory` (`:701`). |
| HIGH 2 — `absenceIsInformative` ignored `unattributed`/`floods` | `f50e1cf` (DEF-200) | `pushHistoryBlock.ts:195-196` — both collections now veto the "at most one push" authorisation, with the reviewer quoted in the comment (`:188-194`). Refusal tests per degraded state at `def197PushHistoryBlock.test.ts:288-299`. |
| MEDIUM 3 — "see the ⚠ flags above" was false for a line-cap-only slice | `6dcc5c2` (DEF-201) | `incompletenessReasons` — each reason NAMES ITSELF (`pushHistoryBlock.ts:168-182`); the line-cap reason (`:175`) carries its own text and no ⚠ reference. |
| Directive 2 — test the final owner-visible path with the exact fixture; mutation: remove scoping and both tests fail | `6dcc5c2` (DEF-201) + `f50e1cf` | Codex's fixture verbatim (conversation says Fujairah; record holds ShireMe AND Vision Metric) driven through the REAL builder and title join — asserts neither unrelated title, key, count nor timestamp reaches the prompt (`def197PushHistoryBlock.test.ts:560+`). **Mutations applied and RUN, on the record in the commits:** DEF-200 — six mutants, all die (incl. "render allRepeats and ignore the resolver", 4 tests fail); DEF-201 — five mutants incl. M5 "remove the scoping", two tests fail. |
| Directive 4 — no unqualified "at most one" from a bounded window | `6dcc5c2` (DEF-201) | The absence claim is BOUND TO THE WINDOW in the standing rules (`pushHistoryBlock.ts:289-296`): "…IN THE LAST ${windowHours} HOURS", never a lifetime claim. |
| Directive 5 — C4 register, after truth/continuity repaired | deferred by the review's own sequencing | Untouched this turn, deliberately; named as the next fresh turn's aim (with `53982df` DEF-213 already removing the "my dispatch log" bookkeeping voice the judge flagged). |

**One residual, stated rather than papered over:** no test drives the full composer LLM
call to a final rendered ANSWER (DEF-201's commit declined it twice, on the record, for
arbitration). The closure argument that stands without it: the model cannot name a title
that never enters its prompt, and the real-builder test asserts exactly that absence. If
Codex still wants a full-composer harness, that is a named piece of NEW work, not evidence
these findings are open.

**What this turn changed (one file of substance):** `brain_change_log.md` — DEF-236's owed
row, the last surviving three-document violation (the chat analyst's second remaining
code-light action). The row records: root cause (`isValidStatus('DRAFT')` false → every
transition refused), the class fix (DRAFT joins the lifecycle: three transitions out, none
in, CANCELLED-never-CLOSED per DEF-129), deploy identity (`81ba131`, ancestor of `4bd6fbc`,
live since 21:25:06Z), and the honest split: the lifecycle-floor half of the deck row
**`guard-destroys-the-answer`** is shipped; the fabrication half (DEF-034(b)
read-back-before-claim) is NOT BUILT and stays open.

**fixQueue targeted:** none exists — the brief's report path is `none` and the benchmark
was reused. Remediation wins on scope regardless.

**Governing-docs verdict (rule 5):** the referent saga is *circling correctly handled* —
the chart's §3 counts `fabricated-status` at 6 and the reviewed diff was the forbidden
second patch-on-instance; DEF-200 is the demanded structural fix (the decision moved to
where the information is: code resolves the subject, the model never sees non-matching
candidates). This turn itself is accounting on top of that — no new root cause, no new
patch.

**Verification (from `server/`, after the last edit, at HEAD `f0d662b` + this turn's two
doc files):**
- `npx tsc --noEmit` → exit **0**
- `npx vitest run` → **229 passed | 1 skipped** files (230); **2849 passed | 0 failed**
  (7 expected fail | 21 skipped | 1 todo, of 2878)
- `git diff --check` → clean (run after this entry was written)
- `npm run build` NOT run in this tree — `server/dist` is `chattr +i` and is the deployed
  artifact (CLAUDE.md); `--noEmit` is the build check. No `server/src` change this turn.

**CAPABILITY:** RELIABILITY-ONLY
**PREDICTED:** +0
**MECHANISM:** no product code changed; the turn closes the wrong-referent review by
evidence (five deployed commits mapped finding-by-finding) and pays the last ledger debt
(DEF-236's row), so the deck can link the draft-delete deck row to its shipped floor fix.
**FALSIFIER:** any cited line not containing what this entry claims; or a post-21:25Z
transcript showing the ShireMe/Vision-Metric wrong-referent shape again, which would mean
the in-code resolver does not reach the live path after all.

**TARGET divergence, said explicitly:** the brief's placeholder target ("Simple
@@TARGETCAP@@ Smart") is not moved; remediation wins on scope. Campaign C-3's next
increment (the digest) is NOT started: same rule.

**Symptom tag:** `guard-destroys-the-answer` — PARTLY, and precisely: DEF-236 (shipped
21:25Z) closes the draft-item lifecycle floor named in the deck row "Couldn't delete the
draft item, with no reason he could act on"; this turn's row and commit carry the tag on
the shipped fix's behalf (the fix commit predates the name-the-tag rule). The other two
open deck tags (the "reply send" demand; the verify-first magic word) are NOT closed —
their fixes are DEF-151/161 and the confirmation-suppression class, both open.

**What I did NOT do:**
- DEF-034(b) read-back-before-any-state-claim — the analyst's #1 remaining build. It is
  new structural code on the messaging path; at remediation attempt 3 of 3 it would add
  exactly the review surface this turn is told not to add. It is the strongest candidate
  for the next FRESH turn, ahead of campaign increment 2.
- No campaign increment, no C4 register work, no operator directives advanced (D-5 etc.) —
  remediation wins on scope; named, not silently dropped.

**Honest prediction:** no criterion moves (docs only). Deployable at end of turn: YES —
matrix green at this HEAD, doc-only diff on top of an already-deployed baseline; nothing
in this tree blocks `deploy.sh`. What would prove this entry wrong: Codex demonstrating
any of the five mapped findings still reproducible at HEAD, or the wrong-referent shape
recurring live.

## Iteration 17 — 2026-08-20

**Remediation attempt 1 of 3 for "Iteration 2's review" — resolved by pointer, and the
real blocker was elsewhere.** The review log's newest `## Iteration` section (line 151
after rotation) is STILL the wrong-referent review that Iteration 12 closed finding-by-
finding against deployed commits (DEF-199/200/201/203/213 — see that entry's table; all
citations stand). No review section exists for the one undeployed commit `efc29a4`, so
there were no new reviewer findings to close: the remediation counter appears to track a
review that was never re-run. Said plainly rather than re-litigated. Escalation ruling
carried from Iteration 14's brief, restated: the wrong-referent CRITICAL is closed
structurally in deployed code; the one residual (no full-composer final-answer test) is
a testing-depth limitation, recommended as **(a) known limitation** — reverting DEF-200
would restore the wrong-referent fabrication.

**What actually blocked deployability, and what this turn did about it:** the tree was
DIRTY with my own iteration-14 work — `actionReceipt.ts` (+82) and
`internalActionExecutors.ts` (+58/−9), left uncommitted when that session died mid-turn —
sitting on top of the undeployed `efc29a4`. Discarding it would have thrown away the fix
for the analyst's measured top defect; deploying around it is impossible (dirty-tree
refusal). So this turn FINISHED it, as **DEF-238**, renumbered because another session
took DEF-237 for the completion-gate work in `efc29a4`.

**DEF-238 — the diagnosis, from production, not inference:**
- 2026-08-19 22:23:40.059: `open_items.cmsotakwf0006rts1bdsrjjkj` went **CANCELLED** —
  "delete all open items" **EXECUTED** (read-only DB check, iteration 14).
- The executor returned the hand-written receipt `[removed: "…"]`;
  `curatedMarkerMeaning` has a rule for NONE of the executor's nine receipt strings; the
  composer does `answer = actionResult.message`; `answerSanitizer.ts:512` swallowed it to
  `NEUTRAL_MARKER_FALLBACK` — **"I couldn't put together an answer I trust for that
  one."** His list was emptied and he was never told. The 20:09 DRAFT refusal died in
  the same swallow, which is why its reason was never one he could act on.

**The class fix (files:lines at this commit):**
- `actionReceipt.ts` — `itemOutcomeMarker` + `itemOutcomeMeaning`: constructor and
  renderer in ONE module, one payload; renderable by construction; a payload the
  constructor could not mint is rejected, not repaired.
- `internalActionExecutors.ts` — all nine receipts constructed; the success receipt is
  built FROM the transition result AFTER it ran (read-back, DEF-034(b)'s principle at the
  site that fired).
- `answerSanitizer.ts` — `curatedMarkerMeaning` consults `itemOutcomeMeaning`; BOTH
  neutral-fallback sites now `console.warn` the swallowed marker head (the 22:23 swallow
  left no trace and had to be dug out of pm2 logs).
- `brainComposer.ts` (`action_plan` join) — each step's marker renders to its curated
  fact before joining; the join was shipping RAW markers into the owner's numbered list
  (proven by the superseded `actionPlan.test.ts` assertion that pinned one).

**Verification (from `server/`, after the last edit):**
- `npx tsc --noEmit` → exit **0**
- `npx vitest run` → **231 passed | 1 skipped** files (232); **2868 passed | 0 failed**
  (7 expected fail | 21 skipped | 1 todo, of 2897) — 10 new tests in
  `def238ReceiptRendersAsFact.test.ts` on the live fixtures.
- **Mutations RUN, not asserted:** (M1) drop the renderer hook from
  `curatedMarkerMeaning` → **7 of 10 fail** (survivors are the pure constructor tests,
  correctly); (M2) revert the success receipt to the old hand-written string → **2 fail**
  across def238+def232. Both restored, restoration verified by grep.
- Superseded assertions updated with reasoning inline: def232 (4 — now assert the
  RENDERED FACT), def127 (3 — source assertions follow the moved contract), actionPlan
  (1 — the curated ask replaces the raw marker it used to pin).
- `git diff --check` → clean (run after this entry).
- `npm run build` NOT run in this tree — dist is `chattr +i` (CLAUDE.md); `--noEmit` is
  the build check.

**Governing docs (rule 5 verdict): CIRCLING, handled structurally.**
`guard-destroys-the-answer` stood at 8 and the 22:23 turn is its 9th, post-deploy — so a
patch on the instance was forbidden. This is the structural close for the receipt
family: the producer/renderer split that generated the class is gone for every receipt
these executors mint. Rows written: **DEF-238** (this work) and **DEF-237** (`efc29a4`
shipped without its row — the last unlogged commit; rule-1 violation named).

**CAPABILITY:** Accurate Communication
**PREDICTED:** the owner is told what a delete actually did — including success, which
was being swallowed. No numeric claim until scored.
**MECHANISM:** receipt producer and renderer share one module and one payload, so no
item-action outcome can reach the sanitizer unrenderable; the plan join renders per-step
facts; both fallbacks log what they discard.
**FALSIFIER:** any post-deploy transcript where a delete/mark-done turn returns the
neutral fallback; or a raw `item_outcome` payload visible in a reply.

**Symptom tag:** `guard-destroys-the-answer` — this closes the deck row "Asked to delete
his items, got a message he could do nothing with — again, after it was supposedly
fixed" at the mechanism that produced both its occurrences. The DEF-237 row carries
`trigger-instruction-as-task` (hole 1) and partly `fabricated-status` (hole 2) on
`efc29a4`'s behalf.

**What I did NOT do, named:**
- The analyst's NEW top items from S37 13:14 — the `(unknown item <cuid>)` preview
  (DEF-044/045) and the confirm-gate re-ask on a direct instruction (DEF-038/151/161) —
  are NOT touched: deployability won on scope. They are the next fresh turn's target,
  and the analyst's class prescription (ONE shared item-label resolver; instructed
  deletes skip the re-confirm) is the right shape.
- DEF-034(b) general ledger read-back: still not built (DEF-238 applies its principle
  only to these receipts).
- `set_contact_scope`/wiki-page executor failures and composer-local failure markers
  (`[add_open_item: …]`, `[delegate_open_item: …]`) still have no curated meanings —
  same class, now at least LOGGED when swallowed; named as the residual migration.
- `brain_evaluation_chart.md` carries the orchestrator's own uncommitted D-66 deploy row
  — orchestrator-owned WIP, not committed by me; it must be reconciled before deploy.

**Honest prediction:** deployable at end of turn — YES for the Builder's surface: the
matrix is green and every Brain-code file is committed; the remaining dirt is
orchestrator state/WIP. What would prove this entry wrong: Codex showing a receipt path
this misses, or the fallback string appearing on a delete turn after this deploys.
