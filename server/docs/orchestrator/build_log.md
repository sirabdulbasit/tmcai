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
