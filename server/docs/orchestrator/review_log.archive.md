# Review log — archive

Older `## Iteration` sections, moved out of `review_log.md` on 2026-08-20 because the
live file had reached 110KB and the Builder was reading it IN FULL — 56k characters of
prefix, re-read on every subsequent turn, then read a second time at an offset. Cache
read was 45% of that pulse's bill.

Nothing is deleted. Every consumer (`deploy.sh`, `pulse.py`, `progress.py`) looks up the
CURRENT iteration, so only the newest sections need to be live; history lives here and
is greppable.

---

## Iteration 1

### Capability scorecard (canonical pre-build card at `b25ea0f`)

| Capability | Nexeo | Nexeo bar | Professional | Professional bar | Gap | Change |
|---|---:|---|---:|---|---:|---:|
| Simple & Smart | 33 | `███████░░░░░░░░░░░░░` | 92 | `██████████████████░░` | -59 | 0 |
| Thinking | 36 | `███████░░░░░░░░░░░░░` | 94 | `███████████████████░` | -58 | 0 |
| Memory | 60 | `████████████░░░░░░░░` | 92 | `██████████████████░░` | -32 | 0 |
| Accurate Communication | 76 | `███████████████░░░░░` | 94 | `███████████████████░` | -18 | 0 |
| Authorized Action | 56 | `███████████░░░░░░░░░` | 91 | `██████████████████░░` | -35 | 0 |
| Self Follow-Up | 56 | `███████████░░░░░░░░░` | 96 | `███████████████████░` | -40 | 0 |
| Learn | 42 | `████████░░░░░░░░░░░░` | 90 | `██████████████████░░` | -48 | 0 |
| Self-Healing | 30 | `██████░░░░░░░░░░░░░░` | 89 | `██████████████████░░` | -59 | 0 |
| Self-Pruning | 40 | `████████░░░░░░░░░░░░` | 89 | `██████████████████░░` | -49 | 0 |

Overall: **47.7/100** versus **91.9/100**, gap **-44.2**, movement **0.0**, verdict **UNVERIFIED** for `8ae7dfa`: it is undeployed, the full suite is red, the required build was not run, and no production observation supports movement.

### 1. Verdict

**WRONG** — the diff can announce a withdrawal after its database write failed, ignores the owner's `staleThresholdDays=0` disable setting, and explicitly permits a completed withdrawal to lose its only owner notice.

### 2. Claims not supported by the diff

1. **“every archive site records the withdrawal” / “after deploy, the next cleanup run that archives anything produces exactly one owner notice.”** `server/src/jobs/openItemsBacklogCleanupJob.ts:202-210`, `:236-245`, `:258-267`, and `:281-290` swallow an update failure and record the item as withdrawn anyway. Conversely, `:306-334` catches an enqueue failure after a successful archive and persists no retryable notice state; the item is then inactive and absent from the next run. The new test explicitly blesses this loss at `server/tests/def186SelfPruneWithdrawnNotice.test.ts:331-340`, contradicting the build's own falsifier (“a run that archives N>0 and enqueues no notice”).
2. **“withdrawal is one reversible lifecycle.”** Only malformed/stale policy archives use quarantine → grace. Smoke residue, quality-gate rejects, and both duplicate paths still jump directly to `CANCELLED` at `server/src/jobs/openItemsBacklogCleanupJob.ts:200-210`, `:214-245`, and `:253-290`; yet all are included in the owner-facing withdrawal notice.
3. **“Deployable this iteration if reviewed SOUND.”** The published verification is red (`server/docs/orchestrator/build_log.md:101-116`), `npm run build` was deliberately not run, and DEF-186 is absent from the mandatory `Changes_Made.md` ledger. This contradicts `AGENTS.md:56-65`, where a complete ledger entry, zero failed tests, and a passing build are required before handoff. The unrelated cause of the two test failures does not turn a red matrix into releasable evidence.

### 3. Correctness and regression risks

1. **CRITICAL — fabricated owner status after a failed mutation.** At `server/src/jobs/openItemsBacklogCleanupJob.ts:202-210`, `:236-245`, `:258-267`, and `:281-290`, input = Prisma rejects the `CANCELLED` update (constraint, disconnect, timeout); behaviour = `.catch(() => {})` converts failure to success, stats increment, `recordWithdrawal(it)` runs, and the owner receives “withdrew” although the item remains active. This newly introduced notification wiring violates AGENTS.md §2.5 (no fabricated completion) and §2.6 (fail closed).
2. **HIGH — the owner cannot disable the new stale lifecycle.** `server/src/jobs/openItemsBacklogCleanupJob.ts:130-140` maps the valid setting `staleThresholdDays=0` to `DEFAULT_STALE_DAYS`, while `server/src/services/openItems/zombieItemPolicy.ts:180-199` implements zero as “recover/disabled.” Input = owner sets zero and has an old untouched item; behaviour = the live caller passes the default rather than zero, quarantines it, and later cancels it against the explicit preference. The policy-only test at `server/tests/def186SelfPruneWithdrawnNotice.test.ts:241-245` does not exercise this integration boundary.
3. **HIGH — notification delivery has no durable handoff.** `server/src/jobs/openItemsBacklogCleanupJob.ts:304-334` commits cancellation before enqueue and catches queue failure. Input = transient queue/database failure after archive; behaviour = the item is permanently excluded from later cleanup scans and no state tells a retry worker that its notice is owed. This is exactly the “write audit state, not the state the next decision reads” defect shape and falsifies “the owner is told once.” `clientNumber=null` is also silently skipped at `:78-80` while cleanup proceeds, violating fail-closed handling of missing tenant metadata.
4. **MEDIUM — the measured C4 gate was not addressed.** The current report's C4 failures are naturalness/register in B07, B09, and B10 (formal/template phrasing and inconsistent “Sir”). The diff adds a new self-pruning marker and cleanup mechanics; no benchmark case emits it and no shared conversational style mechanism changed.

### 3b. CARRIED FINDINGS — pre-existing, not this diff

1. **CRITICAL, already live in production at `e356d42`: tenant isolation is absent from the cleanup selection and mutation boundary.** `server/src/jobs/openItemsBacklogCleanupJob.ts:94-107` selects every tenant together without `clientNumber`; updates use only `id`; the duplicate and settings caches at `:91`, `:118-119`, and `:253-292` omit tenant identity. `server/src/services/openItems/openItemsSettings.ts:41-74` likewise caches and reads by `userId` only. Input = same logical user identifier/data collision across tenants; behaviour = one global pass can apply settings/dedup decisions across tenant boundaries. These shapes are present in `git show e356d42:...`, so they do not by themselves set this iteration's verdict, but AGENTS.md §2.1 makes the live risk a release blocker regardless.

### Orchestrator-owned changes (not charged to the Builder verdict)

`server/docs/orchestrator/build_log.md` is orchestrator-owned, but commit `8ae7dfa` replaces **5,809 existing lines** with the new 164-line Iteration 1 record (`git diff --numstat b25ea0f 8ae7dfa`). That destroys the loop's prior audit history. It is dangerous control-plane data loss and must be restored by the orchestrator before this range is integrated; it is not a Builder remediation item.

Benchmark integrity: none of `nexeoCapabilityBenchmark.ts`, `brainResponseEvaluator.ts`, or `calibrateResponseJudge.ts` changed. Forbidden paths do not appear in the reviewed diff.

### 4. AIM

**AIM: UNVERIFIABLE.** The orchestrator's target is literally `UNKNOWN`. The diff plausibly serves **Self-Pruning**, but no honest comparison can establish that it reached an unknown target; the measured C4 gate is a different surface and remains unaddressed.

### 5. CAPABILITY ATTRIBUTION

```
claimed:   Self-Pruning; +0 until deployed, then owner-visible withdrawal through one reversible lifecycle and one notice
verdict:   OVERSTATED
reasoning: The policy consolidation at server/src/services/openItems/zombieItemPolicy.ts:115-231 plausibly improves Self-Pruning, but the live caller defeats the zero-disable contract at openItemsBacklogCleanupJob.ts:130-140; several withdrawal classes bypass quarantine at :200-290; and notification loss/fabrication remains possible at :304-334. No deployment or live acceptance exists, so +0 is the only supported current movement.
```

### 6. Directive for the next build turn

1. **Repair truthfulness and durable notification in `server/src/jobs/openItemsBacklogCleanupJob.ts`.** Never increment/archive-notify after a failed update. Couple each confirmed cancellation to durable “notice owed” state in the same transaction (or a tenant-scoped outbox row), and have a retryable dispatcher mark it delivered/enqueued; a transient enqueue failure must remain discoverable on the next tick. Add integration tests that reject each archive update and reject the first enqueue, proving no false notice and eventual exactly-once enqueue.
2. **Honor the owner's disable setting end to end.** Pass `staleThresholdDays` through unchanged, including zero, and add a cleanup-job test where settings return zero for an already stale-quarantined item; it must recover and must never cancel or notify.
3. **Close the carried tenant-isolation blocker structurally.** Partition cleanup selection by explicit `clientNumber`, key every cache/dedup map by `(clientNumber,userId,...)`, and constrain mutations by tenant + user + id. Extend `getOpenItemsSettings` to require tenant authority and add cross-tenant collision tests.
4. **Re-run the complete required matrix and publish it in a new `Changes_Made.md` entry:** clean `npx tsc --noEmit`, zero-failure full `npx vitest run`, passing `npm run build`, and clean `git diff --check`. Do not call the range deployable while any required check is red or omitted.
5. **After remediation, aim the next fresh capability turn explicitly.** If C4 remains the gate, change the shared conversational register mechanism used by B07/B09/B10 (not benchmark strings) and test natural address/formality variation without deleting the owner's configured form of address.

## Iteration 2

### Capability scorecard (canonical card at Iteration 2 start, `8ae7dfa`)

| Capability | Nexeo | Nexeo bar | Professional | Professional bar | Gap | Change |
|---|---:|---|---:|---|---:|---:|
| Simple & Smart | 33 | `███████░░░░░░░░░░░░░` | 92 | `██████████████████░░` | -59 | 0 |
| Thinking | 36 | `███████░░░░░░░░░░░░░` | 94 | `███████████████████░` | -58 | 0 |
| Memory | 60 | `████████████░░░░░░░░` | 92 | `██████████████████░░` | -32 | 0 |
| Accurate Communication | 76 | `███████████████░░░░░` | 94 | `███████████████████░` | -18 | 0 |
| Authorized Action | 56 | `███████████░░░░░░░░░` | 91 | `██████████████████░░` | -35 | 0 |
| Self Follow-Up | 56 | `███████████░░░░░░░░░` | 96 | `███████████████████░` | -40 | 0 |
| Learn | 42 | `████████░░░░░░░░░░░░` | 90 | `██████████████████░░` | -48 | 0 |
| Self-Healing | 30 | `██████░░░░░░░░░░░░░░` | 89 | `██████████████████░░` | -59 | 0 |
| Self-Pruning | 40 | `████████░░░░░░░░░░░░` | 89 | `██████████████████░░` | -49 | 0 |

Overall: **47.7/100** versus **91.9/100**, gap **-44.2**, movement **0.0**, verdict **UNVERIFIED** for `9adbe2e`: the remediation is undeployed, the required full suite remains red, and no production observation supports movement.

### 1. Verdict

**WRONG** — although confirmed writes now gate stats and notice debt, the remediation still fails open from unreadable settings, introduces tenant-blind owed enumeration, and can send duplicate notices after a partial mark failure while claiming exactly-once dedup.

### 2. Claims not supported by the diff

1. **“A settings READ failure passes `undefined`, under which the policy neither detects staleness nor releases an existing quarantine.”** `server/src/jobs/openItemsBacklogCleanupJob.ts:183-189` only reaches `undefined` if `getOpenItemsSettings` rejects, but `server/src/services/openItems/openItemsSettings.ts:75-85` catches the Prisma failure, converts it to `null`, and returns cached defaults. The test at `server/tests/def186SelfPruneWithdrawnNotice.test.ts` mocks the whole settings function to reject, a state the production implementation suppresses. A real database read failure therefore passes 14 days, not `undefined`.
2. **“Closed structurally: selection enumerates distinct `(clientNumber, userId)` pairs and processes each inside its tenant” / “any cleanup query ... reaching across the tenant boundary” is the falsifier.** The first candidate query is still global at `server/src/jobs/openItemsBacklogCleanupJob.ts:122-131`, and the newly added owed-pair query is global at `:350-360`; neither has `clientNumber` in `where`. Partitioning after a tenant-blind read does not satisfy AGENTS.md §2.1's explicit “every query scoped by `client_number`” invariant.
3. **“If the MARK write fails after a successful enqueue, the row is re-announced with the same id-hash dedupKey, which the queue collapses.”** At `server/src/jobs/openItemsBacklogCleanupJob.ts:379-424`, the hash covers the current owed-row set, then rows are marked individually. Input = two rows enqueue together, one mark succeeds and one fails; next tick contains only the failed row, so its ID set and hash differ. Queue dedup cannot match it and the owner receives a second notice for that item.
4. **“`guardedItemUpdate` ... [is] the compare-and-set shape” and a “row moved under us” produces a zero-row write.** Its predicate at `server/src/jobs/openItemsBacklogCleanupJob.ts:104-112` checks only id + tenant + user, not the status or metadata version read by the planner. A concurrent status/engagement change still matches and is overwritten; the zero-row test simulates disappearance, not movement.
5. **“the range should be ... deployable.”** The full suite is still red and the required `npm run build` was not run; a clone-side `tsc -p tsconfig.build.json` with Prisma generation skipped is not the command required by `AGENTS.md:58-65`. Correct attribution of the pulse failures does not make the release matrix green.

### 3. Correctness and regression risks

1. **CRITICAL — tenant-blind reads remain and one is newly introduced.** `server/src/jobs/openItemsBacklogCleanupJob.ts:122-131` reads candidate identities across all tenants, and `:350-360` globally reads owners with notice debt. Input = tenant A and tenant B both have qualifying rows; behaviour = one unscoped query observes both tenants before any partition is applied. This directly violates the zero-tolerance query invariant. The later item queries and writes are scoped, but they cannot make the earlier reads authorized retroactively.
2. **HIGH — settings failure still authorizes mutation using defaults.** `server/src/services/openItems/openItemsSettings.ts:75-85` converts a failed tenant-scoped preference read into `DEFAULTS`, while `server/src/jobs/openItemsBacklogCleanupJob.ts:183-202` treats the returned 14-day value as authoritative. Input = preferences DB read fails for an owner whose stale sweep is disabled; behaviour = an old item is quarantined and later cancelled instead of held. This is fail-open cleanup and contradicts the remediation's central safety claim.
3. **HIGH — partial debt clearing produces duplicate owner facts.** `server/src/jobs/openItemsBacklogCleanupJob.ts:379-424` enqueues one batch and clears each row separately. Input = rows A+B enqueue, A's mark succeeds, B's mark fails; behaviour = next tick hashes only B, bypasses the original A+B dedup key, sends B again, and clears it. The implementation is at-least-once, not the claimed exactly-once transient scenario.
4. **HIGH — the “guarded” update can cancel a row after the user changed it.** `server/src/jobs/openItemsBacklogCleanupJob.ts:104-112` has no expected-status, expected-metadata, or version predicate. Input = cleanup reads an unengaged `NEW` item, then the user adds engagement or completes it before the update; behaviour = the update still returns count 1, overwrites metadata based on the stale snapshot, changes status to `CANCELLED`, records notice debt, and reports a valid withdrawal. The new central mutation path preserves the race while claiming a compare-and-set guarantee.
5. **MEDIUM — owed-pair starvation is possible.** `server/src/jobs/openItemsBacklogCleanupJob.ts:350-375` takes 100 distinct pairs with no stable order or cursor. Input = more than 100 owners have debt and early pairs repeatedly fail enqueue; behaviour = the database may return those same pairs every tick, so later owners' durable debt is never attempted. Durability without fair progress does not ensure the owner is eventually told.
6. **MEDIUM — this remediation did not target measured C4.** Iteration 2's weakest C4 cases are B11/B12 at 80, with robotic capability-limit wording and formal “My apologies, Sir”; B10/B08 are also formal/robotic. No composer/persona/register path changed, so the C4 move from 89.2 to 88.6 is measurement variation, not evidence from this diff.

### 3b. CARRIED FINDINGS — pre-existing, not this diff

1. **CRITICAL, already live in production at `e356d42`: the old cleanup job performs its candidate read globally and mutates by bare id.** The branch remediation improves the per-partition item queries and writes, but production remains on the prior tenant-blind implementation until a safe release is deployed. The Iteration 2 diff does not fully close the class because its own two enumeration queries remain global.

### Orchestrator-owned changes (not charged to the Builder verdict)

`server/docs/orchestrator/build_log.md` only appends the Iteration 2 record in this range; no new dangerous orchestrator-owned committed change was found. The uncommitted pulse script/panel/prompt edits remain orchestrator-owned working-tree contamination and are the reported cause of the two red tests. They must be reconciled as one reviewed control-plane change, but they are not charged to the Builder's product-diff verdict.

Benchmark integrity: none of `nexeoCapabilityBenchmark.ts`, `brainResponseEvaluator.ts`, or `calibrateResponseJudge.ts` changed. Forbidden paths do not appear in the reviewed diff.

### 4. AIM

**AIM: UNVERIFIABLE.** The orchestrator target remains literally `UNKNOWN`. The diff is clearly a Self-Pruning reliability remediation, but it cannot be judged on-target against an unknown capability; it also does not address the measured C4 gate.

### 5. CAPABILITY ATTRIBUTION

```
claimed:   Self-Pruning; +0 until deployed; reliability remediation makes withdrawal facts confirmed, durable, disable-aware, and tenant-scoped
verdict:   OVERSTATED
reasoning: Confirmed-row counts and row-carried debt at openItemsBacklogCleanupJob.ts:104-112 and :216-233 are real Self-Pruning reliability improvements. However, settings failure becomes an authoritative default at openItemsSettings.ts:75-85, global enumeration remains at cleanup lines 122-131 and 350-360, and partial debt marks defeat the claimed same-hash dedup at lines 379-424. Undeployed work supports no current score movement.
```

### 6. Directive for the next build turn

1. **Make preference reads genuinely fail closed.** In `openItemsSettings.ts`, distinguish “row absent” from “query failed”: return defaults only for a confirmed tenant-scoped row with absent preferences (or an explicitly defined absence policy), and throw/return an unreadable result on database error. In `openItemsBacklogCleanupJob.ts`, pass `undefined` to the policy on unreadable settings. Test the real settings implementation with Prisma rejection rather than mocking the exported function.
2. **Remove global tenant enumeration from the cleanup job.** Have `centralCleanupGovernor` or a tenant registry enumerate authorized tenant IDs, then call `runOpenItemsBacklogCleanup(clientNumber)`; every candidate and owed query in `openItemsBacklogCleanupJob.ts` must include that explicit tenant in `where`. Add query-shape tests that fail if either enumeration omits `clientNumber`.
3. **Make notice acceptance and debt clearing batch-stable.** Persist a stable batch/notice ID with each owed row before enqueue and reuse that ID on every retry, or atomically mark the whole batch after queue acceptance. Test two rows where only one post-enqueue mark fails; the retry must use the original dedup identity and must not emit a second owner-visible notice.
4. **Implement a real compare-and-set mutation.** Add the expected active status and the relevant engagement/self-prune version to `guardedItemUpdate`'s predicate. Add a race test where the row gains engagement or changes status between read and write; affected count must be zero, with no cancellation, stat, or notice debt.
5. **Guarantee fair owed-notice progress.** Replace unordered `take: 100` with deterministic pagination/cursoring or tenant-scoped bounded iteration that cannot starve later pairs. Test more than the cap with an early permanent failure and prove later owners are still attempted.
6. **Do not release until the canonical matrix passes:** zero-failure full Vitest and the actual `npm run build`, plus tsc and diff-check, recorded in `Changes_Made.md`. Once remediation is SOUND, use the next fresh turn on the shared natural-register mechanism behind C4 B11/B12/B10/B08 rather than benchmark-specific strings.

## Iteration 3

### Capability scorecard (canonical card at Iteration 3 start, `9adbe2e`)

| Capability | Nexeo | Nexeo bar | Professional | Professional bar | Gap | Change |
|---|---:|---|---:|---|---:|---:|
| Simple & Smart | 33 | `███████░░░░░░░░░░░░░` | 92 | `██████████████████░░` | -59 | 0 |
| Thinking | 36 | `███████░░░░░░░░░░░░░` | 94 | `███████████████████░` | -58 | 0 |
| Memory | 60 | `████████████░░░░░░░░` | 92 | `██████████████████░░` | -32 | 0 |
| Accurate Communication | 76 | `███████████████░░░░░` | 94 | `███████████████████░` | -18 | 0 |
| Authorized Action | 56 | `███████████░░░░░░░░░` | 91 | `██████████████████░░` | -35 | 0 |
| Self Follow-Up | 56 | `███████████░░░░░░░░░` | 96 | `███████████████████░` | -40 | 0 |
| Learn | 42 | `████████░░░░░░░░░░░░` | 90 | `██████████████████░░` | -48 | 0 |
| Self-Healing | 30 | `██████░░░░░░░░░░░░░░` | 89 | `██████████████████░░` | -59 | 0 |
| Self-Pruning | 40 | `████████░░░░░░░░░░░░` | 89 | `██████████████████░░` | -49 | 0 |

Overall: **47.7/100** versus **91.9/100**, gap **-44.2**, movement **0.0**, verdict **UNVERIFIED** for `321f0fe`: it is undeployed, the full suite is red, and no live cleanup/notice acceptance has occurred.

### 1. Verdict

**WRONG** — the diff repairs tenant entry, settings errors, and lifecycle CAS, but it can still announce a concurrently restored item as withdrawn and can split one owed set into multiple notices when batch stamping partially fails.

### 2. Claims not supported by the diff

1. **“`OWED_WHERE` requiring CANCELLED ... makes a concurrently-RESTORED row unmarkable and unannounceable: a restored item can never be told to the owner as withdrawn.”** `server/src/jobs/openItemsBacklogCleanupJob.ts:442-447` reads CANCELLED rows, but `settleBatch` enqueues directly from that stale array at `:508-541` without rechecking status. Input = the owner restores a row after the read/stamp and before enqueue; behaviour = the withdrawal notice is sent first, then the status-only mark fails. The guard prevents clearing, not the false announcement.
2. **“the batch carries its identity” / “a retry after ANY partial failure carries the same identity.”** At `server/src/jobs/openItemsBacklogCleanupJob.ts:476-497`, one random batch ID is written to rows one at a time. Input = A's stamp succeeds and B's stamp fails; behaviour = A is immediately announced under batch X, while B remains unstamped and forms batch Y next tick. One original owner/run set becomes two identities and two notices.
3. **“Every mutation ... carries the EXPECTED state” and the new path is a real compare-and-set.** Lifecycle writes do at `server/src/jobs/openItemsBacklogCleanupJob.ts:253-397`, but debt-clearing writes at `:544-557` constrain only status. A concurrent metadata-only write to a still-CANCELLED row remains matchable and is overwritten by stale `row.metadata`.
4. **“defaults only on a confirmed no-row ...; every consumer's fail direction is do less.”** A confirmed missing/foreign user is not a confirmed preference value. `server/src/services/openItems/openItemsSettings.ts:87-95` returns defaults for no row, and cleanup treats them as authorization at `server/src/jobs/openItemsBacklogCleanupJob.ts:240-263`. An orphaned open item or mismatched tenant-user pair can therefore be pruned using fabricated defaults rather than held as unsupported.
5. **“Deployable if reviewed SOUND” / “the full matrix is green except the two orchestrator-owned pulse failures.”** The matrix is red by the published result. The actual build in a clean clone is useful evidence, but AGENTS.md requires the full Vitest run to have zero failures before release; attribution does not change that stop condition.

### 3. Correctness and regression risks

1. **CRITICAL — restored work can still generate a fabricated withdrawal notice.** `server/src/jobs/openItemsBacklogCleanupJob.ts:442-447`, `:476-497`, and `:508-563`. Input = an owed CANCELLED item is read or stamped, then the owner restores it to TRIAGED before `enqueueBrainPrompt`; behaviour = `settleBatch` sends “withdrew from the backlog” from the stale row, and only afterward discovers the row cannot be marked. This is a live owner-messaging violation of AGENTS.md §2.5, introduced on the new notice path.
2. **HIGH — partial batch creation breaks one-notice semantics.** `server/src/jobs/openItemsBacklogCleanupJob.ts:481-497` stamps rows independently and settles the successful subset immediately. Input = two rows owe one notice, one stamp update transiently fails; behaviour = the successful row is announced now and the failed row receives a new batch ID and a second notice later. Persisting identity per successful row does not make creation of the group atomic.
3. **HIGH — notice clearing can erase concurrent metadata.** `server/src/jobs/openItemsBacklogCleanupJob.ts:544-557` rebuilds metadata from the stale query result and guards only on `status: CANCELLED`. Input = another worker adds audit/follow-up metadata without restoring the row between owed read and clearing; behaviour = the mark succeeds and replaces the newer metadata with the stale snapshot plus `owed:false`. That is silent data loss in the remediation's new decision state.
4. **HIGH — missing authority still becomes a pruning policy.** `server/src/services/openItems/openItemsSettings.ts:87-95` does not distinguish a real user with no `open_items` block from no authorized user row. Input = an open item references a deleted/inactive/mismatched user; behaviour = cleanup receives the 14-day default and may quarantine/cancel it, rather than holding because preference authority is unknown. AGENTS.md §2.6 requires missing metadata to degrade visibly, not silently authorize mutation.
5. **MEDIUM — same-millisecond edits can bypass the lifecycle CAS.** `server/src/jobs/openItemsBacklogCleanupJob.ts:128-143` relies on database `updatedAt` equality. Input = a concurrent edit shares the stored timestamp resolution and leaves status unchanged; behaviour = the stale cleanup update can still match and overwrite it. The build log acknowledges this; it is a residual branch risk, though materially narrower than Iteration 2's bare-scope update.
6. **MEDIUM — measured C4 remains untouched.** Iteration 3's C4 weaknesses are B06/B08 at 85 (“Of course. Here is a summary”, “qualify as problems”, failure to understand a typoed Roman Urdu greeting). The remediation changes no conversational register or language-understanding path. C4 returning to 89.2 is evaluator variation, not movement caused by this diff.

### 3b. CARRIED FINDINGS — pre-existing, not this diff

1. **CRITICAL, already live in production at `e356d42`: the deployed cleanup remains tenant-blind and mutates by bare id.** Iteration 3's branch now introduces tenant authority before every open-item query, but production has not received it. This does not set the diff verdict; it remains a live release blocker until a safe reviewed artifact is deployed.

### Orchestrator-owned changes (not charged to the Builder verdict)

`server/docs/orchestrator/build_log.md` only appends the Iteration 3 record in this range; no dangerous committed orchestrator change was found. The uncommitted pulse script/panel/prompt edits remain orchestrator-owned contamination and still make two full-suite assertions fail. The orchestrator must reconcile those files and their contract test together; they are not charged to the Builder diff.

Benchmark integrity: none of `nexeoCapabilityBenchmark.ts`, `brainResponseEvaluator.ts`, or `calibrateResponseJudge.ts` changed. Forbidden paths do not appear in the reviewed diff.

### 4. AIM

**AIM: UNVERIFIABLE.** The target remains literally `UNKNOWN`. The diff plausibly improves Self-Pruning reliability, but cannot be tied to an unknown target and does not address the measured C4 gate.

### 5. CAPABILITY ATTRIBUTION

```
claimed:   Self-Pruning; +0 until deployed; tenant-scoped, fail-closed, batch-stable, race-safe withdrawal notices
verdict:   OVERSTATED
reasoning: Tenant-scoped open-item queries at openItemsBacklogCleanupJob.ts:177-227, throwing settings reads at openItemsSettings.ts:87-95, and lifecycle CAS at cleanup lines 253-397 are real reliability improvements. But settleBatch can enqueue a restored row at lines 508-541, batch stamping is not atomic at 481-497, and status-only clearing can overwrite metadata at 544-557. No undeployed change earns current movement.
```

### 6. Directive for the next build turn

1. **Move notice identity/debt into one atomic batch record instead of per-row best effort.** Add an idempotent migration and a tenant/user-scoped withdrawal-notice outbox (batch ID, immutable item IDs/titles/count, state, timestamps, unique dedup identity). Create the batch and attach/claim all eligible rows in one transaction; a partial stamp must create no sendable batch.
2. **Revalidate immediately before enqueue.** In the outbox dispatcher, transactionally claim a pending batch and confirm every included item is still `CANCELLED` and still belongs to that batch. Remove restored rows before rendering; if none remain, cancel the outbox entry. Add a barrier test that restores an item between owed selection and enqueue and proves no false notice.
3. **Stop replacing metadata from stale snapshots.** If row-carried state remains, make clearing conditional on tenant + user + id + status + `updatedAt` + batchId + owed, and re-read/merge inside a transaction. Add a concurrent metadata-write test proving the newer field survives. A normalized outbox is preferable because Prisma JSON cannot safely patch one nested property atomically.
4. **Represent settings authority explicitly.** `getOpenItemsSettings` must distinguish `found`, `absent`, and `unreadable`; cleanup may apply defaults only to a confirmed authorized user row whose preference block is absent. A missing/foreign user must hold and increment a visible degradation/error metric. Test an orphaned open item end to end.
5. **Retain the successful Iteration 3 structural repairs.** Keep the tenant registry → per-tenant entry point, every open-item query tenant-scoped, real Prisma-error propagation, deterministic owed-user traversal, and lifecycle status+version CAS; add regression tests around them rather than replacing them with another parallel implementation.
6. **Do not release on the red matrix.** Reconcile the orchestrator-owned pulse WIP separately, then record zero-failure full Vitest, actual `npm run build`, tsc, and diff-check. After this remediation is SOUND and deployed, use a fresh turn on the shared C4 register/language mechanism behind B06/B08 rather than benchmark-specific wording.
## Iteration 4

### Capability scorecard (canonical card at Iteration 4 start, `321f0fe`)

| Capability | Nexeo | Nexeo bar | Professional | Professional bar | Gap | Change |
|---|---:|---|---:|---|---:|---:|
| Simple & Smart | 33 | `███████░░░░░░░░░░░░░` | 92 | `██████████████████░░` | -59 | 0 |
| Thinking | 36 | `███████░░░░░░░░░░░░░` | 94 | `███████████████████░` | -58 | 0 |
| Memory | 60 | `████████████░░░░░░░░` | 92 | `██████████████████░░` | -32 | 0 |
| Accurate Communication | 76 | `███████████████░░░░░` | 94 | `███████████████████░` | -18 | 0 |
| Authorized Action | 56 | `███████████░░░░░░░░░` | 91 | `██████████████████░░` | -35 | 0 |
| Self Follow-Up | 56 | `███████████░░░░░░░░░` | 96 | `███████████████████░` | -40 | 0 |
| Learn | 42 | `████████░░░░░░░░░░░░` | 90 | `██████████████████░░` | -48 | 0 |
| Self-Healing | 30 | `██████░░░░░░░░░░░░░░` | 89 | `██████████████████░░` | -59 | 0 |
| Self-Pruning | 40 | `████████░░░░░░░░░░░░` | 89 | `██████████████████░░` | -49 | 0 |

Overall: **47.7/100** versus **91.9/100**, gap **-44.2**, movement **0.0**, verdict **UNVERIFIED**. The Iteration 4 artifact is undeployed, the canonical test matrix is red, and no production withdrawal/outbox acceptance has been observed.

### 1. Verdict

**WRONG** — the normalized outbox repairs partial stamping and stale metadata clearing, but the diff can still enqueue a restored item from a stale revalidation and permanently suppresses a later, distinct withdrawal of any item already named by a sent batch.

### 2. Claims not supported by the diff

1. **“A restored item is never announced as withdrawn.”** `server/src/jobs/openItemsBacklogCleanupJob.ts:578-623` reads live members, then awaits the queue lookup, dynamic imports, rendering, and enqueue without a transaction or status claim. Input = the owner restores the item after the read at `:578-582` and before enqueue at `:607-623`; behaviour = the stale `live` array is announced. The new test restores only during the earlier owed-selection read, so it does not exercise this window.
2. **“A retry after any failure reuses the same identity” / one atomic insert prevents a partial claim.** `server/src/jobs/openItemsBacklogCleanupJob.ts:511-557` derives ownership by reading every pending/sent batch and then creates a random, independently unique batch. Input = two workers pass the read before either creates; behaviour = both see the same rows as unclaimed, create different random dedup keys, and can enqueue two notices. The migration's only uniqueness constraint is on random `dedup_key` (`server/prisma/migrations/20260817_self_prune_notice_outbox/migration.sql:24-25`), not on membership/event identity.
3. **“all four iteration-3 findings are closed with the exact mechanisms the directive named.”** The explicit settings authority is enforced only in cleanup. `getOpenItemsSettings` converts `no_user` back to defaults at `server/src/services/openItems/openItemsSettings.ts:128-137`, while the background, mutating delegation job calls it at `server/src/jobs/delegationFollowUpJob.ts:104-110`. That caller is not an authenticated request context and can act on an orphaned pair under fabricated defaults.
4. **“Deployable if reviewed SOUND.”** The published canonical matrix is red: 1 file failed and 2 tests failed. AGENTS.md requires zero failed tests before release; attributing the failures to orchestrator WIP does not turn a red working tree into a releasable artifact.

### 3. Correctness and regression risks

1. **CRITICAL — the pre-send check is another guard above an asynchronous gap, so a restored item can still produce a fabricated withdrawal notice.** `server/src/jobs/openItemsBacklogCleanupJob.ts:578-623`. Input = item A is CANCELLED at the fresh read, the owner restores A while `brainPromptQueue.findFirst` or the imports are pending, then enqueue runs; result = Brain tells the owner A withdrew although it is active. This is live messaging-path risk and violates the truthful-state/fail-closed invariants.
2. **HIGH — a sent batch permanently consumes an item ID and erases a later withdrawal event.** `server/src/jobs/openItemsBacklogCleanupJob.ts:511-525`, `:537-559`, and `:648-674`. Input = A is withdrawn and announced, restored, then later quarantined and withdrawn again; result = the old sent batch still places A in `claimed`, no new batch is created, and `clearOwedFlags` clears the new `owed:true` as if it belonged to the old event. The build log admits this miss. This regression is introduced by moving identity from the row's overwritten notice metadata to an immortal batch keyed only by item ID.
3. **HIGH — concurrent dispatch can create two sendable batches for the same event.** `server/src/jobs/openItemsBacklogCleanupJob.ts:511-557`; migration lines `24-25`. Input = overlapping cleanup invocations select the same unclaimed owed row before either insert commits; result = two batches with different UUID-derived dedup keys both satisfy the database constraints and both enqueue. The normal governor lease narrows reachability, but the exported per-tenant entry and absence of a database ownership constraint mean the claimed structural guarantee is not true.
4. **MEDIUM — the 200-row cap can starve unclaimed debt behind persistently uncleared sent members.** `server/src/jobs/openItemsBacklogCleanupJob.ts:522-538`. Input = the oldest 200 owed rows are already claimed by sent batches and their clears keep failing, while row 201 is unclaimed; result = `take: 200` selects only claimed rows, `fresh` is empty, and row 201 never receives a batch.
5. **MEDIUM — the release evidence remains red.** The two failing pulse assertions are orchestrator-owned contamination rather than failures caused by this product diff, but a deploy from this exact working tree would violate the mandatory zero-failure matrix. This is a release blocker, not evidence that the outbox tests themselves failed.
6. **MEDIUM — the measured C4 gate is untouched.** Iteration 4's weakest cases are B09 at 80 (“I'm Suzi, Sir”) and B02/B06/B11/B12 at 85 for formal bullets, templated openings, terse limitation handling, and canned apology language. No conversational composition/register path changed; C4's move from 89.2 to 88.3 is measurement variation, not attributable progress.

### 3b. CARRIED FINDINGS — pre-existing, not this diff

1. **CRITICAL, already live in production at `e356d42` — delegation follow-up globally enumerates tenant work and resolves owner identity by bare user ID.** `server/src/jobs/delegationFollowUpJob.ts:62-70` has no `clientNumber` boundary and `:113-117` caches/calls identity by user ID alone. Input = two tenants have delegated rows or colliding/incorrect ownership data; behaviour = one global worker can compose and send a chase using identity not proven under the item's tenant. Iteration 4 did not introduce this path, but it is an existing tenant-isolation and outbound-messaging blocker.

### Orchestrator-owned changes (not charged to the Builder verdict)

`server/docs/orchestrator/build_log.md` only records this iteration in the committed range. The uncommitted pulse panel/scripts/prompts remain orchestrator-owned and are the stated source of the two red assertions. They must be reconciled before any release; no dangerous committed orchestrator change was found in this range.

Benchmark integrity: none of `nexeoCapabilityBenchmark.ts`, `brainResponseEvaluator.ts`, or `calibrateResponseJudge.ts` changed. Forbidden paths do not appear in the reviewed diff. The migration is additive and repeatable, and schema/table/index names match; deployment must still apply it before starting code that accesses the new delegate.

### 4. AIM

**AIM: UNVERIFIABLE.** The supplied target is literally `UNKNOWN`. The diff is aimed at Self-Pruning reliability and does not address the measured C4 gate, but no unknown capability can be proven on-target from code.

### 5. CAPABILITY ATTRIBUTION

```
claimed:   Self-Pruning; +0 until deployed; atomic, immutable, re-proven withdrawal notices
verdict:   OVERSTATED
reasoning: The first-class batch and fresh metadata CAS at openItemsBacklogCleanupJob.ts:511-559 and :648-674 are real Self-Pruning reliability improvements. But the revalidation is not atomic with enqueue (:578-623), sent batches suppress later withdrawal events (:511-525), and concurrent creators have no membership/event uniqueness constraint. Undeployed work earns no current movement.
```

### 6. Directive for the next build turn

1. **Model a withdrawal event, not permanent item membership.** Add an immutable notice-event/version token when `owed:true` is created, and make batch membership unique on `(client_number, user_id, item_id, event_token)` in normalized rows. Clearing must match that exact token. A restored-and-rewithdrawn item must create and announce a new event; an old sent batch must never clear it.
2. **Make revalidation and queue acceptance one database boundary.** Refactor the prompt-queue insertion to accept a Prisma transaction (or add a transactional outbox-to-queue transfer), re-read the exact event/status and insert the unique queue record plus mark the batch accepted in one transaction. Add a barrier precisely after final revalidation and before queue insertion; restoration must yield no queued withdrawal fact.
3. **Make concurrent ownership impossible in the database.** Replace JSON-array-only ownership with batch-member rows or an equivalent unique event claim. Test two simultaneous dispatchers with the same owed event and prove exactly one batch/dedup identity and one queue row.
4. **Select unclaimed events before applying the cap.** Query through normalized membership/not-exists logic or paginate past claimed rows, so persistent clear failure in the first 200 cannot starve later debt. Add a >200-row test with a permanently failing early clear.
5. **Carry explicit settings authority through every mutating background caller.** In `delegationFollowUpJob.ts` and any auto-create mutation path, use `resolveOpenItemsSettings`; `no_user` and read errors must hold visibly. Tenant-scope delegation enumeration and owner lookup as part of the same architecture repair, with cross-tenant tests.
6. **Do not release until the exact working tree has zero failed Vitest tests, tsc and build pass, migration generation/parity/idempotency are verified, and diff-check is clean.** Once the Self-Pruning remediation is sound, use a fresh iteration on the shared C4 natural-register mechanism behind B09/B02/B06/B11/B12 rather than case strings.

## Iteration 1

### Capability scorecard (canonical card at Iteration 1 start, `dfd2f84`)

| Capability | Nexeo | Nexeo bar | Professional | Professional bar | Gap | Change |
|---|---:|---|---:|---|---:|---:|
| Simple & Smart | 33 | `███████░░░░░░░░░░░░░` | 92 | `██████████████████░░` | -59 | 0 |
| Thinking | 36 | `███████░░░░░░░░░░░░░` | 94 | `███████████████████░` | -58 | 0 |
| Memory | 60 | `████████████░░░░░░░░` | 92 | `██████████████████░░` | -32 | 0 |
| Accurate Communication | 76 | `███████████████░░░░░` | 94 | `███████████████████░` | -18 | 0 |
| Authorized Action | 56 | `███████████░░░░░░░░░` | 91 | `██████████████████░░` | -35 | 0 |
| Self Follow-Up | 56 | `███████████░░░░░░░░░` | 96 | `███████████████████░` | -40 | 0 |
| Learn | 42 | `████████░░░░░░░░░░░░` | 90 | `██████████████████░░` | -48 | 0 |
| Self-Healing | 30 | `██████░░░░░░░░░░░░░░` | 89 | `██████████████████░░` | -59 | 0 |
| Self-Pruning | 40 | `████████░░░░░░░░░░░░` | 89 | `██████████████████░░` | -49 | 0 |

Overall: **47.7/100** versus **91.9/100**, gap **-44.2**, movement **0.0**, verdict **UNVERIFIED**. This artifact is undeployed and the canonical test matrix is red; green targeted tests do not establish owner-visible capability movement.

### 1. Verdict

**WRONG** — the measured B10 truncation instance improved, but the diff introduces forbidden deterministic owner-facing English and its line-based algorithm still leaves fragments of multiline list items, so it does not safely close the recurring class.

### 2. Claims not supported by the diff

1. **“When a body genuinely exceeds transport it drops whole trailing `• ` items — never half an item.”** `server/src/services/knowledge/channelRenderer.ts:108-117` defines an item as only the line beginning with `•`, and `:173-187` removes only that one line. Input = a normal Markdown bullet wraps onto an indented continuation line; behaviour = the bullet head is removed while its continuation remains in the delivered body. The tests use exclusively one-line items (`server/tests/def193ListSurvivesTheChannelCap.test.ts:35-38`, `:54-61`) and cannot falsify this.
2. **“`fitToChannel` does it without falsifying the answer” / “the composer is still free to write ‘the full list’ ... the renderer now prevents the contradiction.”** At `server/src/services/knowledge/channelRenderer.ts:176-187`, an oversized list headed “Here is the full list” is still shortened and returned with `(+N more not shown)`. The omission is disclosed, but the original completeness claim remains false. The measured B10 instance now fits under 3900 and therefore avoids the path; the class-level contradiction is not prevented.
3. **“the head prose ... is never dropped.”** If non-item prose alone exceeds the budget, the loop removes every bullet and then falls through to `trimProse(s, max)` at `server/src/services/knowledge/channelRenderer.ts:183-189`, which truncates the original head at `:125-140`. No test covers a long head plus a list.
4. **“the owner meets [this] on every long WhatsApp answer.”** `channelRenderer` is invoked on the `brainAskRoutes` WhatsApp path (`server/src/routes/brainAskRoutes.ts:229-234`), but the actual outbound chokepoint has a second renderer/truncator at `server/src/services/whatsapp/WhatsAppInbound.ts:674-708`. Other replies reaching `sendReply` do not acquire this list-aware policy. This is another `protection-with-two-implementations` claim, not a single channel boundary.
5. **“Deployable at the end of this turn.”** The exact working tree has 2 failed tests, and `(+N more not shown)` at `server/src/services/knowledge/channelRenderer.ts:180` is deterministic unbracketed English inserted into the owner's Brain response. AGENTS.md §2.4 permits owner-facing Brain text only when LLM-generated or a bracketed system marker; transport metadata has no exception.

### 3. Correctness and regression risks

1. **CRITICAL — deterministic renderer prose violates the hardcoded-reply invariant.** `server/src/services/knowledge/channelRenderer.ts:180`. Input = any WhatsApp list longer than 3900 characters; behaviour = Brain sends `(+N more not shown)`, text neither produced by the model nor rendered as a bracketed system marker. This diff introduces the text on a live owner messaging path, directly violating AGENTS.md §2.4.
2. **HIGH — wrapped list items are mutilated rather than removed whole.** `server/src/services/knowledge/channelRenderer.ts:108-117`, `:173-187`. Input = a bullet contains a second-line explanation, URL, quotation, or address; behaviour = the `•` line is deleted but the continuation remains as an orphaned fragment, while the omission count claims one whole item was hidden. That can detach a fact from its subject and recreate `guard-destroys-the-answer` (now 8 recorded occurrences).
3. **HIGH — the completeness contradiction survives whenever structural truncation actually fires.** `server/src/services/knowledge/channelRenderer.ts:176-187`. Input = “Here is the full list:” plus enough bullets to exceed 3900; behaviour = the owner receives a non-full list under an unchanged full-list claim. `(+N more not shown)` is more transparent than a bare ellipsis, but it does not make “full” true.
4. **MEDIUM — raising the WhatsApp policy ceiling from 1000 to 3900 can make the target capability worse.** `server/src/services/knowledge/channelRenderer.ts:38-67`, `:272-274`. Input = the composer ignores or lacks a format-specific brevity instruction and emits 3500 characters; behaviour = WhatsApp now delivers the entire memo where the previous channel contract capped it. The file's owner requirement says WhatsApp should be “to the point” and shorter (`:6-18`); moving all enforcement into scattered composer prompts leaves no shared guarantee.
5. **MEDIUM — the measured result fixed the instance but not the gate.** B10 C6 rose from 80 to 85 and the new answer contains all ten entries with no ellipsis, which supports the local mechanism. C4 is now 87.9: B10 and B12 score 80 for “Sir”/canned formality, while B02 and B06 score 85 for system-like/template phrasing. The diff changes no voice/register mechanism, so it did not address the actual gate.
6. **MEDIUM — release verification is red.** The two failures are attributed to uncommitted orchestrator pulse WIP and are not caused by the Builder diff, but AGENTS.md's mandatory matrix requires zero failures for this exact artifact. A clean-clone build does not waive the failed full suite.

### 3b. CARRIED FINDINGS — pre-existing, not this diff

1. **HIGH, already live in production at `e356d42` — the real WhatsApp send chokepoint has its own destructive character truncator.** `server/src/services/whatsapp/WhatsAppInbound.ts:689-708` independently slices any body over 4000 to 3900 and may append bare `...`; it has no list/item semantics. Input = a long direct or proactive reply reaches `sendReply` without first passing through `channelRenderer`; behaviour = the live path can still sever structured content. Iteration 1 neither introduced nor widened this implementation.

### Orchestrator-owned changes (not charged to the Builder verdict)

`server/docs/orchestrator/build_log.md` is not append-only in this range: the previous loop-restart Iteration 1 record is deleted and replaced (126 deletions, 122 additions) rather than preserving both records. That destroys control-plane audit history and must be restored by the orchestrator from `dfd2f84`; it is not charged to the Builder verdict. The uncommitted pulse files remain the source of the red route tests and must be reconciled before release.

Benchmark integrity: none of `nexeoCapabilityBenchmark.ts`, `brainResponseEvaluator.ts`, or `calibrateResponseJudge.ts` changed. Forbidden paths do not appear in the reviewed diff.

### 4. AIM

**AIM: MISAIMED — Accurate Communication, with regression risk to Simple & Smart.** Preserving a complete B10 list plausibly improves communication accuracy, but raising the shared WhatsApp ceiling to 3900 does not make interaction simpler or smarter and can make replies materially longer. The malformed `@@TARGETCAP@@` placeholder is an orchestrator defect, but the table still names Simple & Smart unambiguously.

### 5. CAPABILITY ATTRIBUTION

```
claimed:   Accurate Communication; +1 to +2 once deployed
verdict:   OVERSTATED
reasoning: B10's complete ten-entry answer and C6 movement from 80 to 85 support an Accurate Communication effect on the measured instance. But channelRenderer.ts:180 violates the hardcoded-reply invariant, lines 173-187 do not preserve multiline items, the “full list” contradiction remains when truncation fires, and the second live truncator at WhatsAppInbound.ts:689-708 remains outside this mechanism. An unreleasable, undeployed artifact earns no current movement.
```

### 6. Directive for the next build turn

1. **Remove deterministic English from the renderer and preserve omission as structured provenance.** The transport layer may return truncation metadata/count, but any owner-facing explanation must be generated through the sanctioned Brain/system-marker boundary and comply with AGENTS.md §2.4.
2. **Represent and budget semantic list blocks, not lines.** A list item includes all continuation lines until the next peer item/section. Prove wrapped bullets, nested bullets, URLs, quotations, multiple sections, long headings, and a head that itself exceeds the cap; no surviving fragment may lose its parent item.
3. **Resolve completeness before rendering.** The composition boundary must know the channel budget and must not assert “full/everything/all” when the rendered artifact omits entries. The owner must receive either the genuinely complete result or wording that was truthful when composed, not a renderer annotation beside a false claim.
4. **Consolidate the two WhatsApp truncators.** `channelRenderer` and `WhatsAppInbound.sendReply` must share one transport policy or one must become a pure assertion/fail-closed boundary. Add an identity/parity test that cannot pass with two drifting implementations.
5. **Restore the deleted build-log record as orchestrator-owned remediation and return the exact working tree to zero failed tests.** Do not release while the pulse contract is red; preserve both same-numbered iteration records with disambiguating headings.
6. **After remediation, aim the next fresh turn at the C4 mechanism shared by B10/B12/B02/B06:** natural address/register and removal of canned/system-like preambles, not case-specific strings.

## Iteration 2

### Capability scorecard (canonical card at Iteration 2 start, `b40263e`)

| Capability | Nexeo | Nexeo bar | Professional | Professional bar | Gap | Change |
|---|---:|---|---:|---|---:|---:|
| Simple & Smart | 33 | `███████░░░░░░░░░░░░░` | 92 | `██████████████████░░` | -59 | 0 |
| Thinking | 36 | `███████░░░░░░░░░░░░░` | 94 | `███████████████████░` | -58 | 0 |
| Memory | 60 | `████████████░░░░░░░░` | 92 | `██████████████████░░` | -32 | 0 |
| Accurate Communication | 76 | `███████████████░░░░░` | 94 | `███████████████████░` | -18 | 0 |
| Authorized Action | 56 | `███████████░░░░░░░░░` | 91 | `██████████████████░░` | -35 | 0 |
| Self Follow-Up | 56 | `███████████░░░░░░░░░` | 96 | `███████████████████░` | -40 | 0 |
| Learn | 42 | `████████░░░░░░░░░░░░` | 90 | `██████████████████░░` | -48 | 0 |
| Self-Healing | 30 | `██████░░░░░░░░░░░░░░` | 89 | `██████████████████░░` | -59 | 0 |
| Self-Pruning | 40 | `████████░░░░░░░░░░░░` | 89 | `██████████████████░░` | -49 | 0 |

Overall: **47.7/100** versus **91.9/100**, gap **-44.2**, movement **0.0**, verdict **UNVERIFIED**. The remediation is undeployed, the full matrix is red, and no production delivery proves the shared transport policy reached the owner.

### 1. Verdict

**WRONG** — the diff removes the forbidden English and consolidates four known slicers, but its “exhaustive” inventory omits live raw-send paths and its parser handles only the first list in a multi-section answer, leaving the messaging class open.

### 2. Claims not supported by the diff

1. **“one transport policy for every WhatsApp reply” / “ALL FOUR WhatsApp truncators” is exhaustive.** The test inventories only four files at `server/tests/def194OneTransportBudget.test.ts:181-186`. `server/src/services/whatsapp/WhatsAppManager.ts:186-203` passes `params.message` unchanged into either provider; `WebjsProvider.sendMessage` sends it unchanged at `server/src/services/whatsapp/WebjsProvider.ts:1487-1526`, and `MetaProvider.sendMessage` places it unchanged in the Meta body at `server/src/services/whatsapp/MetaProvider.ts:70-85`. The UI draft path bypasses those classes again through `UserWebjsProvider.sendReply`, which calls `client.sendMessage(toChatId, text)` at `server/src/services/whatsapp/UserWebjsProvider.ts:1417-1433`. None imports `fitToTransport`.
2. **“Shortening moves whole semantic blocks” for structured bodies.** `parseBlocks` stops permanently at the first blank line after the first list (`server/src/services/knowledge/transportBudget.ts:100-127`). Input = a day brief with Calendar bullets, a blank line, then Email and Open Item bullet sections; behaviour = only the first section becomes blocks and every later list is opaque `tail`. If removing Calendar items cannot fit the preserved tail, the function falls back to prose trimming over the original body at `:184-186`, losing block guarantees entirely.
3. **“the parity test ... makes a third impossible to add quietly.”** The source guard checks only its hard-coded `SITES` array and only forbids `.slice(0, 4096|3900)` plus one `...` spelling (`server/tests/def194OneTransportBudget.test.ts:181-201`). A fifth raw provider send, a `substring`, a different numeric constant, or the already-existing unbounded sends above all pass. This is a list of known implementations, not enforcement at the provider interface.
4. **“The product diff is releasable.”** The published full suite remains 2 failures red, and the exact artifact still contains owner-facing wire paths with no shared budget. The clean-clone build proves compilation, not release safety.

### 3. Correctness and regression risks

1. **HIGH — multiple live WhatsApp wire paths still bypass the alleged single policy.** `server/src/services/whatsapp/WhatsAppManager.ts:186-203`, `server/src/services/whatsapp/WebjsProvider.ts:1487-1526`, `server/src/services/whatsapp/MetaProvider.ts:70-85`, and `server/src/services/whatsapp/UserWebjsProvider.ts:1417-1433`. Input = an agent, scheduler, approved Day Brief draft, or UI user-send supplies a body above the provider limit; behaviour = raw text reaches WebJS/Meta, where it can be rejected or handled differently from Brain replies. This is the 11th `protection-with-two-implementations` recurrence on a live messaging surface.
2. **HIGH — multi-section WhatsApp answers do not receive whole-block protection.** `server/src/services/knowledge/transportBudget.ts:100-127`, `:163-186`. Input = two or more bulleted sections separated by blank lines, the normal Day Brief shape; behaviour = only the first list is parsed. Later bullets are preserved as tail while earlier items are discarded, or the entire answer falls to character-based prose trimming. The algorithm can preferentially delete Calendar facts merely because they occur before Email/Open Items, not because they are less important.
3. **HIGH — the known completeness contradiction remains owner-visible.** `server/src/services/knowledge/transportBudget.ts:163-180`. Input = “Here is the full list” plus a genuinely oversized list; behaviour = the transport silently removes blocks and adds `…`, leaving “full” false. The Builder correctly admits this is not closed. This is still `guard-destroys-the-answer` (8 recorded occurrences), although the current measured B10 fits and does not trigger it.
4. **MEDIUM — structured omission data is discarded at both new callers.** `server/src/services/knowledge/channelRenderer.ts:176-179` and `server/src/services/whatsapp/WhatsAppInbound.ts:714-716` take only `.body`; no sanctioned boundary receives `omittedItems`. Input = truncation occurs; behaviour = the owner sees a bare ellipsis with no count or explanation, and no upstream component can revise a completeness claim. Returning metadata is not useful if every live caller throws it away.
5. **MEDIUM — the target capability remains untouched and may still regress through verbosity.** `WA_TRANSPORT_MAX_CHARS` remains 3900 at `server/src/services/knowledge/transportBudget.ts:61-62`; no shared composition budget was added. WhatsApp can still deliver a 3900-character memo, contrary to the channel's “to the point” owner requirement. This remediation serves Accurate Communication, not Simple & Smart.
6. **MEDIUM — C4 remains the measured gate.** Iteration 2 scores C4 88.8. B08/B10/B11/B12 are 85 for “I see one potential issue”, “The dispatch record shows”, “The assistant's capabilities do not include”, and “My apologies, Sir”. No voice/register or persona mechanism changed; the overall rise is not attributable to this transport-only diff.
7. **MEDIUM — verification remains red.** The two pulse failures are orchestrator-owned and not caused by this Builder diff, but AGENTS.md requires zero failed tests for the exact release tree. The artifact cannot ship on the reported matrix.

### 3b. CARRIED FINDINGS — pre-existing, not this diff

1. **HIGH, already live in production at `e356d42` — provider and user-draft sends have no common transport budget.** The raw-send paths at `WhatsAppManager.ts:186-203` and `UserWebjsProvider.ts:1417-1433` exist in the deployed tree and are reachable by agent/scheduler sends and the authenticated Day Brief draft-send route (`server/src/routes/briefRoutes.ts:386-394`). Input = a long approved draft or generated outbound; behaviour = it bypasses both `channelRenderer` and `WhatsAppInbound.sendReply`. Iteration 2 did not create or widen these paths, but they are live owner/counterpart messaging risk and prevent a releasable verdict under the prompt's scoping exception.

### Orchestrator-owned changes (not charged to the Builder verdict)

`server/docs/orchestrator/build_log.md` appends the Iteration 2 record in this range; no dangerous committed control-plane mutation was found there. The uncommitted pulse implementation still disagrees with its route contract and keeps the full suite red. The orchestrator must reconcile it before deployment.

Benchmark integrity: none of `nexeoCapabilityBenchmark.ts`, `brainResponseEvaluator.ts`, or `calibrateResponseJudge.ts` changed. Forbidden paths do not appear in the reviewed diff.

### 4. AIM

**AIM: MISAIMED — Accurate Communication.** Consolidating truncation and retaining semantic blocks plausibly improves communication fidelity, but it does not improve the targeted Simple & Smart capability. The 3900-character ceiling and absence of a shared composition budget can make WhatsApp less simple. The broken `@@TARGETCAP@@` placeholder remains an orchestrator defect, while the supplied table still makes the intended capability readable.

### 5. CAPABILITY ATTRIBUTION

```
claimed:   Accurate Communication; +0 to +1 once deployed
verdict:   OVERSTATED
reasoning: Removing deterministic English and routing four historical slicers through transportBudget.ts are genuine Accurate Communication reliability improvements. But parseBlocks handles only the first list (:100-127), live provider/draft sends bypass the policy, omittedItems is discarded by both callers, and the known false-completeness case remains open. An undeployed, unreleasable remediation supports no current movement.
```

### 6. Directive for the next build turn

1. **Enforce fitting at the actual provider contract, not an enumerated file list.** `WhatsAppManager.sendWhatsAppMessage`, `WebjsProvider.sendMessage`, `MetaProvider.sendMessage`, and `UserWebjsProvider.sendReply` must receive an already-fitted typed payload or perform the one final fit themselves. Prove every call to the external `client.sendMessage`/Meta text body is dominated by that boundary; source tests over four filenames are insufficient.
2. **Parse all list sections, not the first list.** The transport representation must preserve a sequence of prose and list-block sections across blank lines. Truncation may remove complete item blocks across sections without orphaning headings, tails, nested children, or later sections. Test a real Day Brief shape with Calendar, Email, WhatsApp and Open Items lists.
3. **Carry truncation metadata back to composition.** `omittedItems`/`truncated` must not be discarded. Before owner-visible delivery, the sanctioned composition/sanitizer boundary must ensure claims such as full/everything/all remain truthful; transport must continue adding no English.
4. **Replace the known-sites parity test with a provider-boundary invariant.** Fail CI when any outbound text reaches WebJS/Meta without the shared fitted-payload type/policy, regardless of filename, numeric spelling, or future provider.
5. **Return the exact tree to zero failed tests before release.** The orchestrator must reconcile pulse WIP; then record full Vitest, tsc, actual build and diff-check on the same artifact.
6. **After the transport class is genuinely closed, use a fresh turn on C4's shared natural-register mechanism** behind B08/B10/B11/B12, while separately restoring a real WhatsApp composition brevity budget for Simple & Smart.

## Iteration 2

**LIVE INCIDENT:** The deployed provider-boundary fit sends one body but records and derives state from another. An oversized approved message can create commitments from sentences the owner never sent, and the outbound ledger can say omitted text was delivered (`server/src/services/whatsapp/UserWebjsProvider.ts:1439,1453-1457`; `server/src/services/whatsapp/WhatsAppManager.ts:189-204`).

**ROLLBACK: yes.** Roll back `b34fc73`/`56c66da` unless an immediate production hotfix makes the fitted wire body the single artifact used by send, receipt recovery, audit storage, and commitment extraction; this is already live on the owner's WhatsApp path.

### Capability scorecard (previous verified card; this deployed build remains unverified)

| capability | Nexeo | professional | gap | change | Nexeo / professional (20) |
|---|---:|---:|---:|---:|---|
| Simple & Smart | 33 | 92 | -59 | 0 | `███████░░░░░░░░░░░░░` / `██████████████████░░` |
| Thinking | 36 | 94 | -58 | 0 | `███████░░░░░░░░░░░░░` / `███████████████████░` |
| Memory | 60 | 92 | -32 | 0 | `████████████░░░░░░░░` / `██████████████████░░` |
| Accurate Communication | 76 | 94 | -18 | 0 | `███████████████░░░░░` / `███████████████████░` |
| Authorized Action | 56 | 91 | -35 | 0 | `███████████░░░░░░░░░` / `██████████████████░░` |
| Self Follow-Up | 56 | 96 | -40 | 0 | `███████████░░░░░░░░░` / `███████████████████░` |
| Learn | 42 | 90 | -48 | 0 | `████████░░░░░░░░░░░░` / `██████████████████░░` |
| Self-Healing | 30 | 89 | -59 | 0 | `██████░░░░░░░░░░░░░░` / `██████████████████░░` |
| Self-Pruning | 40 | 89 | -49 | 0 | `████████░░░░░░░░░░░░` / `██████████████████░░` |

Overall: **47.7/100** versus **91.9/100**, gap **-44.2**, movement **0.0**, verdict **UNVERIFIED**. Deployment and an HTTP probe do not prove owner-visible value, and the newly deployed bookkeeping mismatch is a verified structural regression.

### 1. Verdict

**WRONG** — the provider fit is structurally incomplete because downstream consumers continue using the unfitted input, introducing fabricated delivery state and unsent commitments on a live messaging path.

### 2. Claims not supported by the diff

1. **“Every raw WhatsApp text send in the WHOLE tree is fitted at the site” / “A fifth provider added tomorrow is caught.”** The asserted tree invariant only parses `client.sendMessage(target, arg)` and Meta `text: { body }` source shapes (`server/tests/def195TransportBoundaryInvariant.test.ts:52-90`). Existing primitives `message.reply(text)` and `chat.sendMessage(text)` are invisible to it (`server/src/services/whatsapp/inboundReplyTransport.ts:11-20`). The current callers may pre-fit, but the claimed future-proof provider-boundary enforcement is not proved.
2. **“Both [HIGH findings] are now closed at the class level” / “the transport class should now read as closed.”** The wire call is fitted, but receipt recovery still searches for the original body (`server/src/services/whatsapp/WebjsProvider.ts:1533,1548-1555`), the dispatch audit stores the original body (`server/src/services/whatsapp/WhatsAppManager.ts:189-204`), and commitment extraction reads the original body (`server/src/services/whatsapp/UserWebjsProvider.ts:1439,1453-1457`). The class is split across two representations.
3. **Verification evidence is internally inconsistent.** The build entry publishes a red full matrix—2 failures (`server/docs/orchestrator/build_log.md:481-489`)—while the live-deployment addendum says Vitest passed before deployment. No zero-failure raw full-suite result for this exact artifact appears in the reviewed build entry. This is control-plane evidence debt, separate from the product-code verdict.

### 3. Correctness and regression risks

1. **CRITICAL — unsent text can become a real commitment.** Input: an approved Day Brief or self-dictation longer than the transport budget, with a promise in a dropped tail item. Behaviour: `sendReply` transmits `fitToTransport(text).body` but `extractAndFileCommitments` receives the original `text`; Nexeo files/follows up a promise the owner never sent (`server/src/services/whatsapp/UserWebjsProvider.ts:1435-1457`). This violates the no-fabricated-action and fail-closed invariants and is the reason for rollback.
2. **HIGH — the delivery ledger records content that did not reach WhatsApp.** Input: any oversized outbound through `WhatsAppManager`. Behaviour: the provider sends a shortened body, then `whatsapp_messages.content` stores `params.message`; later “what did you send?”, audit, or recovery reads omitted sentences as delivered (`server/src/services/whatsapp/WhatsAppManager.ts:186-204`). This is a new `fabricated-status` instance.
3. **HIGH — provider receipt recovery fails specifically when fitting matters.** Input: WebJS accepts an oversized fitted send but returns no message id. Behaviour: `recoverSentMessageId` searches chat history using unfitted `params.message`, cannot match the delivered fitted body, and leaves the send without provider receipt/quote correlation (`server/src/services/whatsapp/WebjsProvider.ts:1533-1558`). Follow-up matching then falls back to inference rather than the receipt identity.
4. **MEDIUM — the source invariant can pass while a raw send is added.** Input: a future path calls `message.reply(raw)` or `chat.sendMessage(raw)`. Behaviour: the regex suite sees neither form and remains green (`server/tests/def195TransportBoundaryInvariant.test.ts:60-113`; `server/src/services/whatsapp/inboundReplyTransport.ts:11-20`). This recreates `protection-with-two-implementations` despite the class-closure claim.

### 3b. CARRIED FINDINGS — pre-existing, not this diff

1. **Already live in production:** truncation metadata is still discarded and the known completeness-claim problem is explicitly left open (`server/src/services/knowledge/transportBudget.ts:235-246`; `server/docs/orchestrator/build_log.md:511-518`). Input: an answer says “everything” or “full list” and fitting removes items. Behaviour: the owner receives an apparently complete but partial answer with only an unexplained glyph. This predates this iteration's diff and does not determine its verdict.

### Orchestrator-owned changes and state

The committed range changes only `server/docs/orchestrator/build_log.md` on the orchestrator-owned paths; its evidence conflict is recorded above but is not charged to the Builder's product scope. The dirty tree contains substantial separate orchestrator/Deck WIP. The state file still says deployed `e356d42` while `loop.log` records deployment of `b34fc73`; because the owner explicitly states this code is live, this review treats it as live, but the control plane must reconcile that stale deployment identity immediately.

### 4. AIM

**AIM: MISAIMED —** the target was Self-Healing, but the diff changes WhatsApp transport and therefore Accurate Communication reliability. It adds no detect-diagnose-repair-verify mechanism. The current measurement confirms the mismatch: C4 remains the gate at 87.9, with B12 at 80 and B01/B08/B10 at 85 for stiff or clunky register; transport length is not the complained-about mechanism.

### 5. CAPABILITY ATTRIBUTION

```
claimed:   Accurate Communication; +0 until deployed; no WhatsApp body can be cut by character count and multi-section bodies keep whole-block integrity
verdict:   OVERSTATED
reasoning: The provider calls do transmit fitted bodies and the segment parser protects multiple list sections (`transportBudget.ts:129-196,224-252`), so the attribution to Accurate Communication is directionally correct. But this deployed change cannot support positive movement while audit, receipt recovery, and commitment extraction consume a different, unfitted body (`WhatsAppManager.ts:189-204`; `WebjsProvider.ts:1548-1555`; `UserWebjsProvider.ts:1453-1457`). It introduces a live truth/action regression rather than closing the transport class.
```

### 6. Directive for the next build turn

1. **Incident response first:** roll back `b34fc73`/`56c66da`, or urgently make one fitted payload object in the provider/send contract and propagate its exact body through the wire call, `recoverSentMessageId`, `whatsapp_messages.content`, SEND_AUDIT length, and `extractAndFileCommitments`. Add an oversized tail-promise test proving omitted text is neither logged as delivered nor converted into a commitment.
2. **Make the boundary enforceable, not regex-shaped:** route every text primitive—including `message.reply` and `chat.sendMessage`—through one fitted-text adapter/type. The invariant must fail when any new raw text primitive bypasses it; it must not depend on the receiver variable being literally named `client`.
3. **Reconcile live identity immediately:** update the control-plane deployed SHA from stale `e356d42` to the actual production SHA only after verifying production HEAD and artifact manifest. Record the exact rollback/hotfix SHA and bounded WhatsApp acceptance evidence.
4. **Resolve the test-evidence contradiction:** publish the raw zero-failure full Vitest result for the exact deployed or remediated artifact; a red build entry plus an asserted green deploy gate is not auditable.
5. **After the incident is closed, do not spend another turn on transport for the Self-Healing target.** Target the actual Self-Healing ladder with an owner-reachable detect → diagnose → bounded repair → verify loop. Separately, C4 requires a shared natural-register mechanism for the repeated “Sir”/“Of course”/clunky wording failures, not benchmark-case string patches.

