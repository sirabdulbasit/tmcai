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

## Iteration 2 — remediation of the iteration-1 WRONG, finding by finding

**Commit `08237bb`** (code) on `release/cmp-2026-08-16`. DEF-187 and DEF-188
rows added; `Changes_Made.md` §39 added (Codex claim 3 — the missing ledger
entry). No fixQueue entry targeted: remediation wins on scope, and the C4
entries (B07/B09/B10 register) are Codex's own directive 5 for the NEXT fresh
turn, not this one.

### The findings, in severity order, and what closed each

**CRITICAL — fabricated withdrawal after a failed write.** Closed at the class
level, not the four call sites: the job now has ONE mutation path,
`guardedItemUpdate` (`openItemsBacklogCleanupJob.ts:104-119`) — `updateMany`
constrained by `(id, clientNumber, userId)` whose affected-row count IS the
result. Every `.catch(() => {})` on a write is gone; a throw or a zero-row
write increments `errors` and NOTHING else — no stat, no owed state, no owner
fact. Named tests: a rejected write and a vanished row (count 0) both produce
no false notice (`def186…test.ts` "REJECTED archive write" / "ZERO-ROW
write").

**HIGH — the notice had no durable handoff.** The debt now rides the archiving
write itself: the same confirmed update that sets CANCELLED writes
`selfPruneNotice.owed = true` — one atomic row write, so a row either carries
its debt or was never archived. `dispatchOwedNotices` runs every tick,
independent of what the tick archived, announces owed rows per (tenant, user)
and clears `owed` only after the queue accepted the notice. A transient
enqueue failure leaves `owed = true` discoverable next tick. Honest edge,
stated rather than hidden: if the MARK write fails after a successful enqueue,
the row is re-announced with the same id-hash dedupKey, which the queue
collapses while the prior prompt is live — at-least-once is the floor, and the
reviewer's transient-failure scenario is exactly-once, proven across three
ticks in one test (enqueue rejected → delivered once → nothing further; the
row is CANCELLED and OUT of the candidate set in ticks 2-3, so the test proves
the dispatcher, not the archiver, delivers it).

**HIGH — the owner's 0 did not disable.** `staleThresholdDays` now passes
through VERBATIM (`cleanupTenantBacklog`), zero included; the policy already
treated 0 as disable-and-release. A settings READ failure passes `undefined`,
under which the policy neither detects staleness nor releases an existing
quarantine — it cannot judge either, so it holds (fail closed in both
directions). Named tests: disable end to end (a stale quarantine RECOVERS,
nothing cancelled, nothing announced) and unreadable-settings hold. The old
`0 → 30` mapping predates DEF-186, but DEF-186 made it harmful — Codex is
right that the integration boundary was untested, and now it is.

**Carried CRITICAL — tenant-blind cleanup (live at `e356d42`).** Closed
structurally per directive 3: selection enumerates distinct
`(clientNumber, userId)` pairs and processes each inside its tenant (the
DEF-176 `dispatchDuePrompts` shape); the dedup maps exist per partition, so a
cross-tenant collision is impossible rather than filtered; every mutation goes
through the guarded tenant-scoped path; `getOpenItemsSettings(userId,
clientNumber)` requires the tenant and the declaration constrains the
resolution query itself (`findFirst id + clientNumber`, DEF-179 pattern);
cache and invalidation are (tenant, user)-keyed; all three callers declare
their tenant (`openItemGate.ts`, `delegationFollowUpJob.ts` including its
per-run cache, `profileRoutes.ts`). The test mock honours every stated
filter — dropping a tenant scope anywhere in the job turns tests red — and a
same-userId two-tenant fixture proves duplicates never collapse across the
boundary. The `clientNumber=null` skip Codex flagged is deleted: the schema
column is NOT NULL (`schema.prisma` OpenItem `client_number VarChar(20)`), so
the guard was dead code masquerading as a policy.

**MEDIUM — C4 not addressed.** Correct, and per Codex's own directive 5 the
register work is the NEXT fresh capability turn. Not started here — a
remediation turn that also rewires the conversational register would be the
three-deaths-by-added-surface pattern this brief warns about.

**Claim 2 (lifecycle overstated) — accepted and corrected on the record.** The
quarantine → grace lifecycle covers the POLICY classes (malformed + stale),
which are fallible classifications. Smoke tags, hard gate codes and exact
duplicates carry their own evidence, and quarantining them would only delay
cleanup — they stay immediate, but every archive is reversible
(CANCELLED → TRIAGED), audited, and now announced and fail-closed. The
build-log sentence "one reversible lifecycle" claimed more than the diff did;
this entry is the correction.

### Verification (measured AFTER the last code edit)

- `npx tsc --noEmit` — clean.
- `npx vitest run` — **193 files: 191 passed / 1 failed / 1 skipped · 2,380
  tests: 2,349 passed / 2 failed / 7 expected fail / 21 skipped / 1 todo.**
- The 2 failures are both `tests/orchestratorPulseRoute.test.ts`, the contract
  test that EXECUTES the live `scripts/orchestrator/pulse.py`. That script is
  the orchestrator's uncommitted WIP (modified in git status since before
  iteration 1 began). **Proof the reviewed RANGE is green there:** running the
  COMMITTED script — `git show HEAD:scripts/orchestrator/pulse.py` — against
  the contract's exact assertions passes: phases
  `['Build','Checks','Measure','Review','Score']`, all states valid,
  `loop_alive` boolean. The red is working-tree contamination from a path the
  Builder is forbidden to touch. Named for the orchestrator: commit or revert
  the pulse rename, WITH its panel and contract-test counterparts, in one
  reviewed change.
- `npm run build` — the emit build is proven WITHOUT touching the immutable
  dist (CLAUDE.md, 2026-08-16 ruling): clean `git clone --no-local` at
  `08237bb`, `tsc -p tsconfig.build.json` → success, `dist/server.js` and
  `dist/jobs/openItemsBacklogCleanupJob.js` produced in the clone.
  `prisma generate` was skipped in the clone because `schema.prisma` is
  byte-identical to the deployed `e356d42` (empty diff) and the generated
  client exists; the deploy phase runs the real `npm run build` under its own
  unlock per the standing protocol.
- `git diff --check` — clean.

### Capability declaration (contract §Builder)

```
CAPABILITY: Self-Pruning
PREDICTED:  +0 until deployed — this turn makes iteration 1's increment
            HONEST (no fabricated or lost notice, disable honored, tenant
            boundary closed); the owner-visible behaviour still arrives only
            with the deploy. Divergence from the brief's UNKNOWN target is
            per the remediation rule: the reviewed change is the scope.
MECHANISM:  every owner-facing withdrawal fact now has a confirmed
            tenant-scoped write behind it, and the notice survives transient
            failure instead of being lost.
FALSIFIER:  a tick where stats or a notice reflect an unconfirmed write; an
            owed row two consecutive healthy ticks fail to announce; a tenant
            with staleThresholdDays=0 acquiring a new stale quarantine; any
            cleanup query or write reaching across the tenant boundary.
```

### What I did NOT do, and what I am unsure about

- Did not touch `scripts/orchestrator/**` (the pulse red), the benchmark, or
  the C4 register mechanism (directive 5, next turn).
- Did not add an outbox TABLE for notices — the durable state lives in the
  row's own metadata because the archiving write is already the atomic moment;
  a second table would need its own two-phase write and reaper (the DEF-181
  shape). If Codex judges a table the stronger form, that is one contained
  change, but I argue row-carried debt is the smaller honest mechanism.
- Unsure: `dispatchOwedNotices` batches at most 200 owed rows per pair per
  tick (logged when at cap, remainder rides the next tick) — a deliberate
  bound, stated so it is judged rather than found.
- The governing-docs verdict (rule 5): **circling on two known classes**
  (`fabricated-status`, `query-without-tenant-scope`) — closed here at the
  class level (one guarded mutation path; partition + constrained queries),
  which is what rule 5 demands, not another instance patch.

### Honest prediction

This closes every numbered iteration-1 finding at class level; the range
should be reviewable SOUND and deployable, with the pulse-contract red
explicitly attributed to orchestrator WIP outside the range. Wrong if: Codex
shows a write path that still claims success without a count, a notice
scenario that loses the debt (not merely delays it), or a cleanup query I
missed that reads across tenants.

## Iteration 3 — remediation of the iteration-2 WRONG, finding by finding

**Commit `e441723`** (code) on `release/cmp-2026-08-16`. DEF-189 row added;
`Changes_Made.md` §40 added. No fixQueue entry targeted — remediation wins on
scope; the C4 register cases (B11/B12/B10/B08) are Codex's own directive 6
for the next FRESH turn, and the re-scope instruction's "pick work that can
ship" is answered by finishing this range rather than opening new surface.

### The findings, in severity order, and what closed each

**CRITICAL — tenant-blind enumeration (one pre-existing read, one my own).**
Accepted without reservation: partitioning after a global read was not the
invariant, and the owed-pair enumeration was my own addition. Closed by
moving the boundary to the entry point: `runOpenItemsBacklogCleanup` now
TAKES `clientNumber`, and every openItem query in the file — both
enumerations included — carries it (`openItemsBacklogCleanupJob.ts:186-194,
216-231, 384-391, 419-425`). The one legitimately cross-tenant read left is
the tenant REGISTRY enumeration (distinct clientNumber over active users) in
`runOpenItemsBacklogCleanupForAllTenants:158-167` — the same sanctioned
pattern `runContactPruneForAllTenants` uses — and the governor now calls that
wrapper (`centralCleanupGovernor.ts:56-63`). The query-shape sweep test
(directive 2) asserts across a full two-tenant run that no openItem read
anywhere lacks its tenant.

**HIGH — settings failed open to defaults.** Codex was right that my
"unreadable → hold" claim was unreachable: the catch lived one level below
me. `getOpenItemsSettings` now THROWS on a database error
(`openItemsSettings.ts` — the absence policy stays narrow and deliberate: a
CONFIRMED no-row read or block-less row coerces to defaults; errors are never
cached). The REAL module is tested against a rejecting Prisma
(`def189OpenItemsSettingsFailClosed.test.ts`), per directive 1 — not a mock
of the exported function. Every consumer's fail direction on throw is "do
less": the cleanup holds (undefined window), the gate falls through to
CREATING visibly (`openItemGate.ts:167` catch — suppression is the dangerous
direction, DEF-156), the follow-up job skips the item for a tick.

**HIGH — a partial mark failure could double the notice.** Codex's scenario
was exact: the hash covered the retry subset, not the batch. The identity is
now PERSISTED: unannounced rows are stamped with a `batchId` in a confirmed
guarded write BEFORE anything is enqueued; the dedupKey derives from the
batchId alone; and `settleBatch` first asks the queue whether that identity
exists IN ANY STATE (`prisma.brainPromptQueue.findFirst` scoped tenant+user+
dedupKey) — if it does, the notice was accepted once and the debt clears with
no second message. This also survives the prompt going TERMINAL, which mere
enqueue-dedup (non-terminal only) would not. Named test: A+B announced once,
B's mark fails, tick 2 retries {B} under the original identity, finds the
prompt, sends nothing — `state.prompts` length stays 1.

**HIGH — the "guarded" update was scope, not compare-and-set.** Also exact.
`guardedItemUpdate(target, expected, data)` now carries the EXPECTED state:
the status the planner read plus the `@updatedAt` version token (the column
is `@updatedAt`, so any user edit bumps it) for all lifecycle writes;
`status: 'CANCELLED'` for post-archive notice writes — which, with
`OWED_WHERE` requiring CANCELLED, also makes a concurrently-RESTORED row
unmarkable and unannounceable: a restored item can never be told to the owner
as withdrawn. A fired guard increments `raced`, never a stat or debt. Named
test: the concurrent editor adds a due date after the read — count 0, the
edit survives, no cancellation, no debt, no notice, `errors` 0.

**MEDIUM — owed-pair starvation.** Closed by determinism rather than a
cursor: within a tenant, owed USERS are enumerated with no cap, userId asc;
rows per batch oldest-first, capped 200 with the cap logged. Every owed owner
is attempted every tick and one owner's failure cannot displace the next —
the starvation shape (unordered take re-returning the same failing head) is
gone. If tenant counts ever make "no cap over users" wrong, that is a scale
problem to raise, not silently re-cap.

**MEDIUM — C4 unaddressed.** Correct, and deliberately so per directive 6:
the register mechanism is the next fresh turn. The 89.2 → 88.6 move is inside
the noise band and I claim nothing about it.

### Verification (measured AFTER the last code edit, commit `e441723`)

- `npx tsc --noEmit` — clean.
- `npx vitest run` — **194 files: 192 passed / 1 failed / 1 skipped · 2,386
  tests: 2,355 passed / 2 failed / 7 expected fail / 21 skipped / 1 todo.**
  The 2 are `orchestratorPulseRoute.test.ts` executing the orchestrator's
  uncommitted live `pulse.py`; the COMMITTED script passes the contract's
  exact assertions (proven and recorded in Iteration 2's entry). Still owed
  by the orchestrator: reconcile the pulse rename as one control-plane change.
- **`npm run build` — the ACTUAL script, this time** (directive 6 rejected
  the tsc-only proof): fully isolated clean clone at `e441723`,
  `npm ci` (848 packages, own node_modules, no symlink), then
  `npm run build` = `prisma generate && tsc -p tsconfig.build.json` →
  Prisma Client v6.19.2 generated, emit succeeded, `dist/server.js` and
  `dist/jobs/openItemsBacklogCleanupJob.js` produced IN THE CLONE. The
  production `server/dist` (immutable, `chattr +i`, CLAUDE.md 2026-08-16) was
  not touched — an in-tree build is a deploy action and remains the deploy
  phase's, under its own unlock and manifest.
- `git diff --check` — clean.

### Capability declaration (contract §Builder)

```
CAPABILITY: Self-Pruning
PREDICTED:  +0 until deployed — third pass making DEF-186's increment honest.
            Divergence from the brief's UNKNOWN target is the remediation
            rule: the reviewed change is the scope.
MECHANISM:  every guarantee now lives at the level that enforces it — the
            query carries the tenant, the error carries the failure, the
            batch carries its identity, the write carries its expectation.
FALSIFIER:  any openItem query in the job without clientNumber; a DB-error
            settings read returning values; a partial-mark retry producing a
            second owner message; a concurrent user edit still cancelled
            over; an owed owner never attempted while an earlier one fails.
```

### What I did NOT do, and what I am unsure about

- Did not touch `scripts/orchestrator/**`, the benchmark, or the C4 register
  path (directive 6: next fresh turn).
- Did not paginate owed USERS within a tenant — deliberate: determinism plus
  per-owner isolation removes the starvation mechanism Codex named; a cursor
  adds state for a set that is small per tenant. Said here so it is judged.
- Unsure: the CAS `updatedAt` equality predicate is millisecond-granular; a
  same-millisecond concurrent write could in principle slip it. The status
  predicate still bounds the damage class (an active row can only be
  cancelled FROM the status that was read), and `@updatedAt` is the
  strongest version token the schema carries today.
- Governing-docs verdict (rule 5): **circling** — `query-without-tenant-scope`
  (this closes members at the enumeration level after DEF-178/179/188 closed
  other members) and the fail-open/fabricated-status family. Closed at class
  level per the structural requirement: the tenant now enters at the entry
  point, and the settings module can no longer manufacture a preference.

### Honest prediction

Deployable if reviewed SOUND: every iteration-2 finding is closed at the
level Codex named, the full matrix is green except the two
orchestrator-owned pulse failures, and the actual build passes in isolation.
Wrong if: Codex finds an openItem read I missed outside the job (the sweep
asserts the job's own calls only), a notice path that still changes identity
across retries, or judges the registry enumeration itself insufficient as
the one cross-tenant read.

## Iteration 4 — remediation of the iteration-3 WRONG, finding by finding

**Commit `8576274`** (code + migration) on `release/cmp-2026-08-16`. DEF-190
row added; `Changes_Made.md` §41 added. No fixQueue entry targeted —
remediation wins on scope (attempt 3 of 3); the C4 cases (B06/B08) stay
Codex's own directive 6 for the next fresh turn. The re-scope instruction's
"pick work that can ship" is answered by finishing this range: this turn
follows Codex's directives 1–5 exactly rather than opening new surface.

### The findings, in severity order, and what closed each

**CRITICAL — a restored item could still be announced.** Accepted: my
iteration-3 claim confused "unmarkable" with "unannounceable" — the enqueue
read stale rows. Closed per directive 2: `settleBatch` REVALIDATES with a
fresh read immediately before enqueue (`openItemsBacklogCleanupJob.ts`,
`settleBatch`): only members still CANCELLED are rendered; restored members
drop out; a batch with no live members flips to `cancelled` and nothing is
sent. Named tests: the restore lands between owed selection and enqueue —
no prompt, batch cancelled, the restore survives; and the two-member variant
where the live member is announced while the restored one is absent from the
vetted meaning. The residual window (a restore after the fresh read, inside
the same millisecond as the send) is the irreducible one — no second phase
exists between our database and WhatsApp — and it is stated, not hidden.

**HIGH — per-row stamping split one owed set into two notices.** Accepted.
Closed per directive 1: the outbox (`self_prune_notice_batches`, migration
`20260817_self_prune_notice_outbox`, idempotent) makes batch creation ONE
atomic INSERT carrying the immutable member snapshot and the unique dedup
identity — there is no per-row claim step left to partially fail. Named
test: the insert is rejected → nothing sendable exists, no notice; next tick
forms ONE batch over the whole owed set → exactly one notice saying "2 open
items withdrew". The sent-mark failure case keeps exactly-once the other
way: the retry finds the queue already holding the batch identity (asked IN
ANY STATE, so a terminal prompt still counts) and settles without re-sending.

**HIGH — clearing erased concurrent metadata.** Accepted. Closed per
directive 3: `clearOwedFlags` re-reads each row FRESH and writes through the
status+updatedAt CAS, merging the FRESH metadata — never the dispatch-time
snapshot. Named test: another worker writes `followUpAudit` between
acceptance and clearing; the field survives and the debt still clears. A
raced clear stays owed INSIDE its sent batch — which excludes it from ever
joining a new batch — and is retried next tick; that is the loop that makes
row flags eventually consistent without a second notice. I did not adopt an
interactive transaction for this: the CAS on the fresh read's version token
gives merge-or-nothing without holding a transaction open across row loops;
if Codex judges a transaction stronger, it is a contained change.

**HIGH — a missing user became a pruning policy.** Accepted — the reviewer
is right that my "confirmed no-row → defaults" absence policy conflated WHO
holds the preference with WHAT it is. Closed per directive 4:
`resolveOpenItemsSettings` returns explicit authority — `found`,
`absent_preferences` (confirmed user row without the block: defaults are his,
authorized), `no_user` (null value) — and the cleanup HOLDS on `no_user`,
counting the visible `heldNoAuthority` metric and logging the pair. End-to-end
orphan test: no quarantine, no release, metric at 1. Database errors still
throw (DEF-189) and the real module is tested for all three states plus the
throw. `getOpenItemsSettings` survives as the read-side convenience for
authenticated-context callers (gate, follow-up, profile), where the pair
exists by construction and a read-only default is the safe direction.

**MEDIUM — same-millisecond CAS residual.** Acknowledged again, not fixed:
`@updatedAt` is the strongest version token the schema carries; the status
predicate bounds the damage class. Recorded in the DEF-190 row as a known
residual rather than dressed as closed.

**MEDIUM — C4 untouched.** Deliberate, per directive 6: next fresh turn.

**Directive 5 (retain iteration-3's repairs) — done by construction:** the
tenant registry → per-tenant entry point, every openItem query tenant-scoped
(the sweep test now also covers outbox reads), thrown settings errors,
deterministic owed traversal, and the lifecycle status+updatedAt CAS are all
unchanged and still under their named tests. No parallel implementation was
added: the outbox REPLACED the per-row stamping path rather than joining it.

### Verification (measured AFTER the last code edit, commit `8576274`)

- `npx tsc --noEmit` — clean.
- `npx vitest run` — **194 files: 192 passed / 1 failed / 1 skipped · 2,393
  tests: 2,362 passed / 2 failed / 7 expected fail / 21 skipped / 1 todo.**
  The 2 are `orchestratorPulseRoute.test.ts` executing the orchestrator's
  uncommitted live `pulse.py` (the COMMITTED script passes the contract's
  exact assertions — proven in Iteration 2's entry). Directive 6's "do not
  release on the red matrix" is the orchestrator's to satisfy by reconciling
  its own pulse WIP; the Builder cannot touch `scripts/orchestrator/**`.
- **`npm run build` — the ACTUAL script at `8576274`, in the fully isolated
  clean clone** (own `npm ci` dependencies): `prisma generate` ran against
  the NEW schema — the `selfPruneNoticeBatch` delegate is confirmed present
  on the generated client (`typeof p.selfPruneNoticeBatch === 'object'`) —
  and the emit succeeded, `dist/jobs/openItemsBacklogCleanupJob.js` produced
  in the clone. The immutable production `server/dist` was not touched.
- `git diff --check` — clean.
- Migration: `20260817_self_prune_notice_outbox` — additive, idempotent
  (`IF NOT EXISTS` on table and both indexes), no data backfill, applied by
  the deploy runner at deploy time.

### Capability declaration (contract §Builder)

```
CAPABILITY: Self-Pruning
PREDICTED:  +0 until deployed — fourth pass making DEF-186's increment
            honest. Divergence from the brief's UNKNOWN target is the
            remediation rule: the reviewed change is the scope.
MECHANISM:  the notice's lifecycle now lives in a first-class record whose
            creation is atomic, whose identity is immutable, and whose
            members are re-proven live at the moment of speaking.
FALSIFIER:  a restored item named in any notice; two notices covering one
            owed set; a concurrent metadata field lost to a clear; an
            orphaned item quarantined under default settings; a batch whose
            retry carries a different dedupKey.
```

### What I did NOT do, and what I am unsure about

- Did not touch `scripts/orchestrator/**`, the benchmark, or the C4 register
  path. Did not use an interactive transaction for owed-flag clearing
  (argued above — CAS on the fresh version token; contained change if Codex
  prefers the transaction).
- The working tree reaches the outbox through a narrow typed cast, because
  the local Prisma client regenerates only inside a deploy's build and
  `npx prisma` never runs on prod (CLAUDE.md). The clone build proves the
  generated client carries the delegate; at runtime the dispatcher degrades
  VISIBLY if it is ever absent (debts persist, `errors` counts, nothing
  announced). Stated so the reviewer judges the trade rather than finds it.
- Unsure: cancelled batches are terminal — an item restored and later
  RE-archived forms a NEW batch and is announced again, which I judge
  correct (it withdrew twice); an item whose owed flag lives in a SENT batch
  and which is re-archived after restore would have its second withdrawal
  cleared without a second announcement — a miss, never a double. Both
  stated in the row.

### Honest prediction

Deployable if reviewed SOUND: all four iteration-3 findings are closed with
the exact mechanisms the directive named (outbox, pre-send revalidation,
fresh-read merge, explicit authority), the two MEDIUMs are recorded
honestly, and the actual build passes against the new schema in isolation.
Wrong if: Codex finds a path where a batch's members can change between the
atomic insert and the revalidating read in a way that survives both the
status filter and the queue-identity check, judges the delegate cast
unacceptable before the deploy-time generate, or requires the interactive
transaction for clearing.

## Iteration 5 — the escalation ruling: withdraw the contested mechanism from the live surface

**Commit `bb0cf57`** on `release/cmp-2026-08-16`. DEF-191 row added;
`Changes_Made.md` §42 added. This turn answers three instructions at once and
says how: the ESCALATION asks for a ruling on the remaining findings, the
RE-SCOPE demands something that can ship, and STRUCTURAL MODE forbids a fifth
patch on the same class. The ruling below satisfies all three; what I dropped
is the fifth remediation attempt itself, deliberately.

### The ruling, plainly

**(a) Known limitation — for a path now DISABLED BY DEFAULT — not (b) full
revert.** Codex's four open findings (revalidate→enqueue async window,
immortal batch membership erasing a re-withdrawal, no DB ownership
constraint, cap starvation) are ALL confined to the announce dispatcher.
Closing them honestly requires Codex's own directives 1–3 — withdrawal-EVENT
tokens, batch-member rows unique on (tenant, user, item, event), and a
transactional outbox→queue transfer — which is a redesign of the delivery
boundary, not a patch. Four consecutive remediation turns have each closed
the previous turn's mechanism and exposed the next hole one level deeper,
because notice delivery spans two systems with no shared transaction. A
fifth attempt inside an escalated turn is the exact shape D-21 recorded as
"a turn too large to hold every invariant in view".

So the dispatcher now runs ONLY when the owner switches
`selfpruning.withdrawal_notice_enabled` on (`behaviorConfig.ts` — def 0,
tenant scope; `dispatchOwedNotices` gates first, unreachable config reads as
0, unknown-key bugs still throw). This is the same owner-controlled-gate
shape Codex REQUIRED for `selfpruning.digest_enabled`. While 0 — the shipped
state — no outbox row is minted and nothing is announced; the four findings
are dormant limitations of a disabled path, recorded in the DEF-191 row, and
the gate must not open before the event-token redesign lands.

**Why not full revert:** reverting f9f5ebf..8576274 would also revert
DEF-188/189's tenant-scoping of the cleanup path — putting the LIVE
tenant-blind cleanup CRITICAL back into the deployable artifact — and would
discard the quarantine lifecycle, the fail-closed settings, and the CAS
writes, all progressively reviewed clean, to remove one feature that is now
off. The gate is the minimal revert: the contested BEHAVIOUR leaves the live
surface; the reviewed code and the durable debt recording stay.

### What still changed in code, and why it is small on purpose

- **The gate** (above): `behaviorConfig.ts` registry entry +
  `openItemsBacklogCleanupJob.ts` (`dispatchOwedNotices` head). Tests: the
  registry default announces nothing while archives and debts continue; an
  unreachable config announces nothing; all dispatcher tests now run with
  the gate explicitly on.
- **Claim 3's LIVE half** (Codex directive 5, the part that fits this turn):
  `delegationFollowUpJob.ts` resolves settings under EXPLICIT authority —
  a `no_user` pair is HELD (`summary.held`, logged), never chased under
  fabricated defaults; a thrown read is an error, not a chase. Tested in
  `def191DelegationAuthorityHold.test.ts` (no verdict asked, nothing sent;
  the found-authority control proceeds with the real followUpDays under the
  item's tenant).
- **NOT done, named per the directive rule:** directives 1–3 (the event-token
  redesign — the next scoped Self-Pruning turn, before the gate opens);
  directive 4 (cap starvation — dormant behind the gate, recorded);
  directive 5's other half — the delegation job's GLOBAL enumeration and
  bare-id owner lookup are the pre-existing carried CRITICAL, live at
  `e356d42`, recorded OPEN in DEF-191: it needs its own scoped turn, and
  bolting it onto an escalation turn is the three-deaths-by-added-surface
  pattern this brief warns about. Directive 6's C4 register turn stays next.

### The regression guard, analyzed rather than waved off

B05 C1 100→85 and B12 C2 100→85. The flagged sentences ("I've sent you a
notification about it", "The dispatch record doesn't show a reason") do NOT
appear in iteration 3's answers for the same cases — the reply text changed
between runs. But the range `e356d42..HEAD` touches no compose path: the
only message-path file in the diff is `answerSanitizer.ts`, whose addition
is a parser matching only the `selfpruning_withdrawn:` prefix, which neither
answer contains; the composer, persona, and register files are untouched.
The variation is composer sampling. The CLASS the judge flagged —
send-claims resting on artifacts the owner cannot verify — is real and is
exactly the unverifiable-claim family this loop fights; it belongs to the
C4/C1 register turn Codex's directive 6 already queues, where it can be
fixed at the composition mechanism rather than per case.

### Governing-docs verdict (rule 5)

**Circling on the notice-delivery class — and this turn's structural answer
is withdrawal of the mechanism, not another instance patch.** Removing the
weaker implementation from the live surface until the correct one exists is
the same move D-20 prescribed for the marker path ("delete, do not repair a
seventh time"), applied at the feature boundary.

### Verification (measured AFTER the last edit)

- `npx tsc --noEmit` — clean.
- `npx vitest run` — **195 files: 193 passed / 1 failed / 1 skipped · 2,398
  tests: 2,367 passed / 2 failed / 7 expected fail / 21 skipped / 1 todo.**
  The 2 remain `orchestratorPulseRoute.test.ts` against the orchestrator's
  uncommitted `pulse.py` (committed script passes the contract — proven in
  Iteration 2's entry). The orchestrator still owes that reconciliation.
- **`npm run build`** — the actual script at `bb0cf57` in the fully isolated
  clean clone (own `npm ci` dependencies): generate + emit OK,
  `dist/jobs/openItemsBacklogCleanupJob.js` and
  `dist/jobs/delegationFollowUpJob.js` produced in the clone. Production's
  immutable dist untouched.
- `git diff --check` — clean.

### Capability declaration (contract §Builder)

```
CAPABILITY: Self-Pruning
PREDICTED:  +0 — the announce half is now explicitly owner-gated OFF. What
            ships live: the reversible quarantine lifecycle and the
            tenant-scoped cleanup (closing the deployed tenant-blind
            CRITICAL), with withdrawal debts accumulating durably and
            silently. Divergence from the brief's UNKNOWN target: the
            escalation ruling is this turn's mandated scope.
MECHANISM:  the contested mechanism is withdrawn from the live surface
            instead of patched a fifth time; the reviewed-clean mechanism
            ships.
FALSIFIER:  with the gate at 0 — any outbox row minted, any withdrawal
            notice reaching the owner, a cleanup run that stops archiving or
            stops recording owed debt; a delegation chase composed for a
            pair with no user row.
```

### Honest prediction

Deployable if reviewed SOUND, and this is the artifact's honest shape: what
is live is what survived four reviews; what did not survive is off, recorded,
and waiting for its redesign. The benchmark should be flat (no compose path
changed). Wrong if: Codex finds a path that reaches `dispatchOwedNotices`'s
announce logic with the gate at 0, judges the gate itself an evasion rather
than the digest-precedent containment, or shows the delegation authority
hold to be incomplete in a way its tests miss.
