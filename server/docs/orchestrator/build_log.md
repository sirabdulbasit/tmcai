# Build log — written by Claude, read by Codex

One `## Iteration N` section per build turn, appended, newest at the bottom.
Codex reviews these entries against the real diff, so a claim here that the diff
does not support is the single most useful thing for the reviewer to catch.

Required per iteration: what the fix queue said, what was changed and why, the
verification numbers (tsc / vitest, exact figures), what was NOT done, and the
honest expectation of which criterion should move.

## Iteration 1

**Campaign C-3 (Self-Pruning), increment 3 — code-complete this turn. Commit `f9f5ebf`.**

### What governed this turn, and two corrections to the brief on the record

- The brief's campaign table says increments run 1 → 3 and "take the first that is
  not done". On THIS branch the state is: **increment 1 is built, deployed and
  measured** (`inboundNoiseLedger.ts`, `nexeoInboundNoiseReport.ts` are in the
  deployed SHA `e356d42`; the production measurement is quoted in
  `digestPolicy.ts`'s own header — the CL-033 sender was answered 13/13, and the
  real noise is a cross-producer drip: `item:cmqauv4xx…` took 13 pushes from three
  producers at 69% unanswered). **Increment 2 is built, deployed and default-off**
  behind `selfpruning.digest_enabled` (def 0, `behaviorConfig.ts:196`) — the
  owner-controlled gate Codex required before any automatic suppression. Its
  remaining work is ACTIVATION and live observation, which is an owner/orchestrator
  decision, not build work. **Increment 3 did not exist. That is the lowest-numbered
  increment with undelivered build work, and it is what this turn built.**
- The brief's "CAMPAIGN SUSPENDED — 3 undeployed commits (47461b9, 40893c2,
  373dbf8)" block is stale for this branch: `git branch --contains 47461b9` does
  not include `release/cmp-2026-08-16`; those commits live on
  `feat/nexeo-one-brain` and the campaign branches. The deployed SHA `e356d42` IS
  an ancestor of HEAD here, and the commits between it and my turn's start
  (`b3a213d`, `7fe41c0`, `a5ca591` + DEF-185 contract docs) are the CMP-2026-08-16
  chunk Codex already ruled SOUND / RELEASABLE (commits `1e8f98c`, `5b8310e`).
  I did not treat "make HEAD deployable" as this turn's job because on this branch
  HEAD had no open release blocker on record.
- `review_log.md` on this branch is a fresh header — no open findings, so no
  remediation scope. `owner_reports.md`: no unprocessed text below the marker
  (R-1, R-2 both PROCESSED).

### Three-docs check (CLAUDE.md rule 5), verdict out loud

**Circling on the mechanism class, and this change is the structural move, not a
patch.** The cleanup job held its own engagement definition (notes+delegation
only) and its own instant-archive path BESIDE `zombieItemPolicy`'s quarantine
lifecycle — that is `protection-with-two-implementations`, the §3 recurrence
table's most-recorded class. The fix DELETES the job's private path and moves the
decision into the one policy. The owner-notice half is new capability
(progressing): no symptom tag exists for "withdrawal happens in silence" because
nothing ever spoke it.

### What changed, by file, and why that is the mechanism

- `server/src/services/openItems/zombieItemPolicy.ts` — `'stale_no_engagement'`
  joins `ZombieReason`; `StalePruneOptions.staleAfterDays` carries the per-user
  window; `classifyZombieOpenItem` judges staleness with the ONE existing
  `hasEngagementEvidence` (so a due date, a user edit or a draft reply now
  protects an item the old job-side check would have archived); quarantine →
  7-day grace → soft-close, engagement recovers, and a caller that supplied no
  window HOLDS a stale quarantine (`planZombieLifecycle`) — the draft-ask job
  calls `planZombieLifecycle(item, now)` and must not release what it cannot
  re-make. This is "move the decision to where the information actually is":
  staleness needs the user's window, so the window travels to the policy instead
  of the decision leaking into the job.
- `server/src/jobs/openItemsBacklogCleanupJob.ts` — the private stale branch is
  deleted; the stale window is resolved before the lifecycle plan and passed in;
  stats split (`quarantinedStale`, `noticesEnqueued`); every archive site records
  the withdrawal, and after the loop the job enqueues ONE notice per
  (userId, clientNumber) — tenant declared (DEF-178/179 class), `expectsReply:
  false` (DEF-063: a notice never holds the conversation lock), `provenance:
  'system_marker'`, dedupKey = sha256 of the archived ids, and a notice failure
  increments `errors` without failing the cleanup.
- `server/src/services/notifications/proactiveMessageText.ts` —
  `renderSelfPruneNotice`: the sanctioned form only. JSON payload
  (count clamped 1..10 000 and forced ≥ titles named; ≤3 titles, cleaned,
  sentinel-stripped, 80 chars) inside a provenance-stamped
  `selfpruning_withdrawn` marker. No owner-facing English is written here.
- `server/src/services/knowledge/answerSanitizer.ts` — `withdrawnMarkerMeaning`,
  the marker's ONE vetted meaning, wired into `curatedMarkerMeaning` beside the
  digest's. Parser REJECTS what the constructor cannot produce (count<1,
  non-integer, >3 titles, titles>count, non-string member) → neutral fallback,
  never repaired facts. Wording keeps the vetted rules: facts, no promise, no
  vocative, no first-person future — "kept in full and can be restored" is a
  standing property (CANCELLED→TRIAGED exists in the matrix; nothing is deleted),
  not a promised action.
- `server/tests/def186SelfPruneWithdrawnNotice.test.ts` — 20 tests: sync
  (constructor↔parser), Codex-shape injection attempts (a title carrying
  `"]; count: 999; ["` and the sentinel stays inside its field), reject-to-
  fallback table, the lifecycle including the hold-not-release rule, and job
  integration: quarantine writes no status, archive writes the audit block,
  exactly one notice per tenant with the tenant asserted, zero-archive runs
  enqueue nothing, enqueue failure archives anyway.
- `server/tests/def129CancelAndAtomicity.test.ts` — the write-site count drops
  6→5 because the stale write site MERGED into the policy-archive site. The
  test's property (every site writes CANCELLED, none writes lowercase 'closed')
  is unchanged and still asserted.

### Verification (measured AFTER the last edit)

- `npx tsc --noEmit` — clean.
- `npx vitest run` — **193 files: 191 passed / 1 failed / 1 skipped · 2375
  tests: 2344 passed / 2 failed / 7 expected fail / 21 skipped / 1 todo.** Both
  failures are `tests/orchestratorPulseRoute.test.ts`, the contract test that
  spawns the LIVE `scripts/orchestrator/pulse.py` (test line 152). That script
  carries the orchestrator's own uncommitted stage-rename edits (in git status
  before this turn began; the test's received output shows the new stage names
  "Capability Evaluation" / "Build Capabilities"). My diff touches neither the
  script nor the test — the same pre-existing env-failure class DEF-174's row
  recorded. I did not touch `scripts/orchestrator/**`; if the rename is
  permanent, the orchestrator owns reconciling its script with the route's
  contract test, per the standing rule.
- `npm run build` — **deliberately NOT run.** CLAUDE.md (commit `b25ea0f`,
  newer than this prompt's step 5): `server/dist` is `chattr +i` immutable, a
  build in this tree is a deploy action, and `--noEmit` is the build check.
- `git diff --check` — clean.

### Capability declaration (contract §Builder)

```
CAPABILITY: Self-Pruning
PREDICTED:  +0 until deployed. Once deployed, the first cleanup run that
            archives anything delivers increment 3's owner-visible half: one
            message naming what withdrew. Against Grok's card (Self-Pruning 40,
            basis largely code-read) the code now carries all three increments;
            live observation, not this diff, is what the campaign's exit
            condition counts.
MECHANISM:  withdrawal is one reversible lifecycle with one engagement
            definition, and its outcome reaches the owner through the
            sanctioned marker path instead of silence.
FALSIFIER:  a run that archives N>0 and enqueues no notice; a stale item
            CANCELLED without a prior quarantined selfPrune block; an item
            with engagement evidence entering quarantine; live after deploy —
            an archiving run with no WhatsApp notice naming the count.
```

### What I did NOT do, and what I am unsure about

- **Did not enable `selfpruning.digest_enabled`** (increment 2's activation).
  It is the owner's gate by review requirement; flipping it in code would undo a
  reviewed protection. The orchestrator should put activation to the owner —
  that, plus one live burst, completes increment 2's done-when.
- **Did not run the benchmark.** The brief says the benchmark was reused; the
  compose path for the twelve read cases is untouched (the sanitizer change only
  ADDS a parser for a marker no existing case emits — `withdrawnMarkerMeaning`
  requires the `selfpruning_withdrawn:` prefix, so existing markers cannot match
  it). If the regression guard moves, that reasoning is what to re-check first.
- **Did not take D-11** (DRAFT outside the matrix) or D-1/D-5 (benchmark
  teardown / measurement surfaces): the campaign SCOPE rule made increment 3 this
  turn's one increment, and those directives remain open and named here rather
  than silently dropped.
- **Unsure:** (1) whether the owner wants duplicate-collapse and smoke residue
  counted in the withdrawal notice — I included every archive reason because the
  campaign's wording is "told once what was withdrawn", and the meaning says
  "open items", claiming nothing reason-specific. If Codex reads "junk
  withdraws" as stale-only, the filter is one condition in `recordWithdrawal`.
  (2) The [smoke]-tagged items older than the stale window now quarantine for 7
  days instead of archiving instantly (the plan runs before the smoke branch, as
  it already did for malformed titles) — a delay, not a loss, and dev residue
  only; flagged so the reviewer judges it rather than finds it.

### Honest prediction

Deployable this iteration if reviewed SOUND — the diff is self-contained, adds
no migration, and changes no message path any benchmark case exercises. The
benchmark should be flat (any C-move of 1–2 points is noise). The falsifiable
claim is live: after deploy, the next cleanup run that archives anything
produces exactly one owner notice naming the count, and its items are
restorable via CANCELLED→TRIAGED. If a run archives with no notice, or a notice
arrives as a raw bracket instead of prose, this turn failed at exactly the
place its tests claim it cannot.
