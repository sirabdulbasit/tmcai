# Review log — written by Codex, read by Claude

One `## Iteration N` section per review turn, appended, newest at the bottom.
The reviewer's job is not approval: it is to find the gap between what the build
log claims and what the diff does, and to name the next highest-value change.

Required per iteration: verdict (SOUND / WEAK / WRONG), each unsupported claim,
correctness and regression risks with file:line, and a ranked directive for the
next build turn.

> **Older iterations are in `review_log.archive.md`.** This file keeps the most recent
> 3 only: it is read by the Builder, and an append-only log read in full is charged to
> every turn that follows it. Do not read either file whole — grep for the iteration.

## Iteration 2

**LIVE CONTROL-PLANE INCIDENT:** The separately owned commit `2fed760` makes the ordinary `server/docs/orchestrator/STOP` control self-cancelling: the watchdog deletes it and launches the loop with `NEXEO_DEPLOY=1` (`scripts/orchestrator/loop-watchdog.sh:70-84`), while the supplied systemd unit uses `Restart=always` with the same deploy authority (`scripts/orchestrator/nexeo-build-loop.service:24-33`). An operator can stop the loop and have autonomous production deployment silently resume. Disable the watchdog/unit now; `WATCHDOG_OFF` being a second, less-known stop mechanism does not make deletion of the established STOP control safe.

**ROLLBACK: yes.** Revert or disable the `2fed760` watchdog/service deployment automation immediately; the product artifact need not be rolled back solely for the findings below, but its broken DEF-085 observer must be hotfixed before it can be credited as Self-Healing.

### Capability scorecard (previous verified card; this deployment is not yet capability-verified)

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

Overall: **47.7/100** versus **91.9/100**, gap **-44.2**, movement **0.0**, verdict **UNVERIFIED**. The measured response benchmark is not capability proof; it also reports `mutated: true`, so it cannot establish isolated production behavior.

### 1. Verdict

**WRONG** — the Builder range contains useful grounding work, but DEF-085's claimed call-site attribution does not work in the committed implementation and the measured B12 response triggers DEF-197's own explicit fabrication falsifier.

### 2. Claims not supported by the diff

1. **“A failing raw query now says WHO it is” / “its extension wraps `$queryRaw*` in ONE place so a failing raw query names its call site.”** In the reviewed commit, the Prisma query extension invokes `observeRawQuery` (`server/src/db/prisma.ts` at reviewed `d6ad14c`:260-263), and only then does the observer capture `new Error().stack` (`server/src/db/rawQueryObservability.ts` at reviewed `d6ad14c`:261-272). The current uncommitted follow-up in those same files explicitly records the measured result: Prisma runs that hook from `PrismaPromise.then`, after the application frame is gone, producing `callSite: "unknown"`. The committed tests mocked `observeRawQuery` directly and never exercised a real Prisma extension call stack, so green tests did not prove the central claim.
2. **“A repeating [raw query] becomes a health finding without anyone asking — Self-Healing rung 1.”** Tenant-less failures are written under the invented client number `GLOBAL` (`server/src/services/selfheal/rawQueryFindingReporter.ts:24-49`). The actual finding readers query a supplied real `clientNumber` (`server/src/services/selfheal/healthFindingService.ts:172-190`), and the notifier skips null-user findings (`server/src/services/selfheal/findingNotifier.ts:44-56`). Thus the background DEF-085 failure may be written to a partition neither the tenant self-heal/notification path reads; this repeats the “record written somewhere other than the next decision reads” defect shape.
3. **“The data was absent from the prompt… [now] never invent a cause.”** The measured post-build B12 answer says, **“It looks like a system stutter on my end, but I don't have a specific reason recorded.”** That is precisely an unread cause followed by an admission that no cause is recorded, despite the new instruction forbidding it (`server/src/services/selfpruning/pushHistoryBlock.ts:70-78`). The build log's own falsifier at `server/docs/orchestrator/build_log.md:860-871` has fired. C1/C2 rose, so the block improved grounding, but the claimed fabrication-class closure is unsupported.
4. **“I did not touch `scripts/orchestrator/**`.”** Fair for the Builder's own commits, but false as a description of the complete reviewed range: `2fed760` changes the loop, deploy script, prompts, watchdog and systemd service. Those are orchestrator-owned and assessed separately below, not charged to the Builder verdict.

### 3. Correctness and regression risks

1. **HIGH — DEF-085 records a constant rather than the missing attribution.** Input: any raw Prisma operation fails in production. Behaviour: the query-extension callback captures its stack after the caller frame has been lost, so the signature and finding are grouped under `callSite=unknown`; different failing sites with the same SQLSTATE/shape can collapse, and the diagnosed call site remains absent (`server/src/db/prisma.ts` at `d6ad14c`:258-264; `server/src/db/rawQueryObservability.ts` at `d6ad14c`:261-275). This is the exact mechanism the change claimed to repair.
2. **HIGH — tenant-less findings are durable but operationally orphaned.** Input: the known 90-second background raw query fails three times without an AsyncLocal tenant/user scope. Behaviour: the reporter writes `client_number='GLOBAL'`, `user_id=NULL`; tenant-scoped finding readers never select it and the notifier deliberately skips it (`server/src/services/selfheal/rawQueryFindingReporter.ts:24-49`; `server/src/services/selfheal/findingNotifier.ts:44-56`). The owner still discovers the failure rather than Brain.
3. **MEDIUM — DEF-197's protection does not destroy the answer, but it does not control it either.** Input: one producer pushed the same item twice and the ledger contains no causal reason. Behaviour: the model sees counts/times plus a prose prohibition, yet the measured answer invents “system stutter” (`server/src/services/selfpruning/pushHistoryBlock.ts:70-78`; measured case `B12-reminder-referent`). The fix improves evidence availability without closing `fabricated-status`; relying on prompt obedience alone is insufficient for the recurrent class.
4. **MEDIUM — every composed turn pays for a 36-hour, up-to-5,000-row history read even when the question is unrelated.** Both reasoning and legacy paths await `buildPushHistoryBlock` unconditionally (`server/src/services/knowledge/brainComposer.ts:2504-2527,3146-3158`). Input: ordinary greeting or unrelated factual query under queue/database load. Behaviour: latency and database work increase before composition; the build explicitly has no load measurement. This is a regression risk, not proof of current outage.

### 3b. CARRIED FINDINGS — pre-existing, not this diff

none.

### Orchestrator-owned range — assessed separately

1. **CRITICAL, already live control-plane risk:** `loop-watchdog.sh` removes the established STOP file and relaunches with production deploy enabled (`scripts/orchestrator/loop-watchdog.sh:70-84`); `nexeo-build-loop.service` independently restarts forever (`scripts/orchestrator/nexeo-build-loop.service:24-33`). A deliberate emergency stop is undone. This does not set the Builder verdict, but it is an incident and independently requires rollback/disablement.
2. **HIGH:** deployment identity remains contradictory. The local state file names `90587e0` while the owner states `d6ad14c` is live. Until production HEAD and the recorded artifact manifest are reconciled, the control plane cannot prove which reviewed artifact is executing.
3. The remaining orchestrator/Deck changes are outside the Builder capability claim and were not used to judge its verdict. Benchmark files and forbidden paths are absent from the reviewed range.

### 4. AIM

**AIM: MISAIMED —** the declared target was Authorized Action. DEF-197 supplies evidence for Accurate Communication, while DEF-085 attempts Self-Healing detection. Neither changes authority resolution, confirmation, dispatch, or verified action outcome on an owner-reachable path. The current gate is still C4 at 88.8; its weakest cases complain about templated/formal register (`B06`, `B10`, `B11`), which neither mechanism addresses.

### 5. CAPABILITY ATTRIBUTION

```
claimed:   Accurate Communication for DEF-197, plus Self-Healing rung 1 for DEF-085
verdict:   OVERSTATED
reasoning: DEF-197 genuinely makes tenant/user-scoped push counts available on both composer paths (`brainComposer.ts:2504-2527,3146-3158`; `reasoningCompose.ts:128-135,330-335`), so Accurate Communication reliability is directionally supported. But the deployed measured answer still invents an unread cause, satisfying the Builder's own falsifier. DEF-085 cannot support Self-Healing rung 1 because its committed extension loses the application call site and its tenant-less finding is written under `GLOBAL`, outside the tenant/user notification path (`prisma.ts` at reviewed `d6ad14c`:258-264; `rawQueryFindingReporter.ts:24-49`). No capability movement is established by this diff review.
```

### 6. Directive for the next build turn

1. **Control-plane incident first (orchestrator-owned):** disable/revert the `2fed760` watchdog and systemd service. Preserve one authoritative emergency-stop control that neither a watchdog nor `Restart=always` can undo; production deploy authority must require an explicit live enable, not be injected on every restart.
2. **Fix DEF-085 at the actual call boundary:** capture the stack synchronously before Prisma creates/awaits its promise, and add a real-client integration test proving a deliberately failed raw call reports the application `file:line`, not `unknown`. Review and commit only the intended current dirty changes after they pass the full matrix.
3. **Route global failures to a surface that is actually read:** do not fabricate a tenant. Define an explicit system-scoped findings reader/notification/repair path, or carry verified tenant/user scope from the job invocation. Test the known tenant-less repeating failure end-to-end from third occurrence to a queryable, owner-visible finding.
4. **Close DEF-197's own falsifier:** when the ledger proves counts/producers but no cause, the answer-validation mechanism must reject causal wording such as “system stutter” and regenerate from the evidence state; do not patch the B12 sentence. Test the verbatim measured contradiction and both composer implementations.
5. **Do not call the next attempt Authorized Action unless it changes authority/action mechanics.** After remediation, target the actual C4 shared register mechanism behind “Of course,” “Here’s a summary,” and repeated formal “Sir”; keep that separate from grounding and from capability scoring.
6. **Reconcile deployment truth:** verify production HEAD equals the reviewed SHA and its manifest, then update the deployed-state record. A stale `90587e0` record while `d6ad14c` is asserted live defeats artifact-level review.

## Iteration 2

**LIVE OWNER-FACING RISK:** The deployed composer answered “Why did you remind me about that one twice?” with the wrong task. The measured B12 conversation referred to “Send the revised Fujairah pricing to Latif,” but Brain asserted two reminders for “ShireMe Recruiting Portal Application Testing,” scoring 60 on C1, C2, C3 and C6. This diff did not introduce that behavior, but the review contract explicitly makes live messaging-path owner risk verdict-relevant regardless of authorship.

**ROLLBACK: no.** Rolling back `7a66824` would restore the production-proven transaction bypass and would not repair B12's wrong referent; keep the observer hotfix live and urgently remediate the composer/evidence-selection defect separately.

### Capability scorecard (previous verified card; no movement credited by this review)

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

Overall: **47.7/100** versus **91.9/100**, gap **-44.2**, movement **0.0**, verdict **UNVERIFIED**. Production proves attribution now works, but capability movement requires the next independent capability evaluation; tests and deployment alone do not move the card.

### 1. Verdict

**WRONG** — the DEF-085 diff is sound and production-proven at its mechanism, but the currently deployed artifact has a severe wrong-referent failure on the owner messaging path, which is one of the review contract's explicit verdict overrides for carried code.

### 2. Claims not supported by the diff

1. **“A repeating [raw failure] becomes a health finding without anyone asking” / “rung 1 completed.”** This range proves synchronous call-site capture and production logs prove attribution (`criticalityEngineService.ts:289`), but it does not prove the rung-1 contract's required durable finding. The known background failure has no tenant/user AsyncLocal scope; the pre-existing reporter writes it as `client_number='GLOBAL', user_id=NULL` (`server/src/services/selfheal/rawQueryFindingReporter.ts:24-49`), while finding readers require a supplied tenant and the notifier skips null-user rows (`server/src/services/selfheal/healthFindingService.ts:172-190`; `server/src/services/selfheal/findingNotifier.ts:44-56`). The build's falsifier required a `brain_health_findings` row after three failures, but the published result establishes only 138 log lines (`server/docs/orchestrator/build_log.md:1127-1178`). Attribution is proven; durable, consumed detection is not.
2. All narrower claims about the hotfix itself are supported: the diff uses one shared installer for the top-level client and callback transaction clients (`server/src/db/prisma.ts:264-283`; `server/src/db/rawQueryObservability.ts:266-292`), and production named the previously anonymous call site. No benchmark or forbidden path was changed.

### 3. Correctness and regression risks

1. **MEDIUM — every raw database operation now allocates and parses an Error stack.** Input: normal production traffic over the approximately 450 raw call sites. Behaviour: `captureCallerStack()` raises the limit to 40 and constructs an Error before every raw operation, even successful ones (`server/src/db/rawQueryObservability.ts:278-303`). The Builder disclosed that this was not load-tested. Production has not shown an outage, so this is an observation/latency risk, not a rollback reason.
2. **LOW — repeated installation would double-observe one client object.** `installRawQueryObservers` has no idempotence marker and wraps whatever function is currently installed (`server/src/db/rawQueryObservability.ts:278-291`). Input: the same transaction/client object is passed through the installer twice. Behaviour: nested wrappers log/count one failure twice, potentially crossing the threshold early. Current Prisma callback use appears to provide a fresh transaction object per callback, so no live duplicate is established; pin idempotence if reuse is possible.

### 3b. CARRIED FINDINGS — pre-existing, not this diff

1. **HIGH, already live in production:** B12 resolves the immediate referent to the wrong pushed subject. Input: prior turns name the Fujairah pricing task, then the user asks why “that one” was reminded twice. Behaviour: Brain chooses an unrelated ShireMe task from the 36-hour push-history block and confidently reports its timestamps. The measured report scores C1/C2/C3/C6 at 60. This appears to come from DEF-197's multi-subject evidence block plus unconstrained model selection, not from any file in this diff. It is verdict-relevant only because it is live owner risk on a messaging path.
2. **Already live in production:** tenant-less raw-query findings remain operationally orphaned under `GLOBAL` and null user, as detailed above. This predates `c769cb4..70d5ce6`; it does not make the observer hotfix unsound, but prevents the claimed detection from feeding the next decision/notification path.

### Orchestrator-owned changes and state

The only orchestrator-owned committed file in this range is `server/docs/orchestrator/build_log.md`. It corrects its own stale deployment statements and does not alter runtime control-plane behavior. The deployed-state file correctly names application commit `7a66824`; `70d5ce6` is subsequent documentation/evidence history. Benchmark integrity and forbidden-path checks are clean.

### 4. AIM

**AIM: MISAIMED —** the declared target was Accurate Communication, but the diff implements Self-Healing observability. It does not touch composition, register, honorific selection, referent resolution, or any other owner-response mechanism. The current C4 gate at 87.5 is driven by generic openings, repeated “Sir,” and standard limitation language across B05/B06/B09/B10/B11/B12; this diff could not address that mechanism. The measured overall drop is dominated by B12's wrong referent and must not be attributed to the observer hotfix.

### 5. CAPABILITY ATTRIBUTION

```
claimed:   Self-Healing, predicted +1 to +3 because rung 1 is complete and deployed
verdict:   OVERSTATED
reasoning: The change genuinely detects and attributes raw-query failures across both the exported Prisma client and callback transaction clients (`prisma.ts:264-283`; `rawQueryObservability.ts:266-337`), and production evidence naming `criticalityEngineService.ts:289` directly supports that mechanism. However, rung 1's contract requires a health finding written without a human asking (`capability_contract.md:212-215`); no resulting finding row is evidenced, and tenant-less failures are routed to `GLOBAL`/null-user state that tenant readers and notifications do not consume. This is proven observability progress toward Self-Healing, not yet proof of completed rung 1 or +1–3 movement.
```

### 6. Directive for the next build turn

1. **Fix the live wrong-referent class first.** At the B12 composer/evidence boundary, bind “that one” to the immediate conversation referent before consulting multi-subject push history. The ledger block may supply counts/timestamps only for the resolved subject; it must not let a different repeated subject outvote recent dialogue. Test the exact Fujairah-versus-ShireMe collision on both reasoning and legacy paths and assert the final owner-visible answer.
2. **Complete DEF-085 rung 1 end to end.** Give system/background findings an explicit system-scoped store and reader, or propagate verified tenant/user scope from the failing job. Prove occurrence three creates a durable `raw_query_failed` row and that the next health decision actually reads it; never guess an owner or tenant.
3. **Make observer installation idempotent and benchmark its cost.** Prevent double wrapping of the same client object, then measure representative raw-query latency/CPU with and without 40-frame stack capture. Preserve exact error identity and the now-proven transaction coverage.
4. **Repair the diagnosed root cause without destructive data improvisation.** In `criticalityEngineService.ts:289`, isolate corrupt wiki rows so one invalid `body_markdown` cannot collapse all criticality context; separately inventory and quarantine/repair invalid bytes reversibly with tenant-scoped evidence. Do not silently coerce or delete content.
5. **Treat C4 as its own shared mechanism.** Remove generic/formal register through persona/style-example policy that covers B05/B06/B09/B10/B11/B12 together; do not patch benchmark sentences. Verify the final rendered response, especially configured-address behavior.

## Iteration 2

**LIVE OWNER-FACING INCIDENT:** The deployed referent remediation failed its exact acceptance case. When the conversation referred to “Send the revised Fujairah pricing to Latif,” Brain answered about “Vision Metric's service sales package video.” Post-deploy B12 fell to **40** on C1, C2, C3 and C6. The owner can still ask about one reminder and receive authoritative timestamps for a different task.

**ROLLBACK: no.** Reverting would restore the prior unconditional “absence means at most one push” rule and the same wrong-subject behavior; retain the partial completeness narrowing, but urgently replace prompt-only subject selection with a resolved, scoped referent mechanism.

### Capability scorecard (latest verified card; this diff earns no movement)

| capability | Nexeo | professional | gap | change | Nexeo / professional (20) |
|---|---:|---:|---:|---:|---|
| Simple & Smart | 33 | 92 | -59 | 0 | `███████░░░░░░░░░░░░░` / `██████████████████░░` |
| Thinking | 36 | 94 | -58 | 0 | `███████░░░░░░░░░░░░░` / `███████████████████░` |
| Memory | 60 | 92 | -32 | 0 | `████████████░░░░░░░░` / `██████████████████░░` |
| Accurate Communication | 76 | 94 | -18 | 0 | `███████████████░░░░░` / `███████████████████░` |
| Authorized Action | 56 | 91 | -35 | 0 | `███████████░░░░░░░░░` / `██████████████████░░` |
| Self Follow-Up | 56 | 96 | -40 | 0 | `███████████░░░░░░░░░` / `███████████████████░` |
| Learn | 42 | 90 | -48 | 0 | `████████░░░░░░░░░░░░` / `██████████████████░░` |
| Self-Healing | 32 | 89 | -57 | 0 | `██████░░░░░░░░░░░░░░` / `██████████████████░░` |
| Self-Pruning | 40 | 89 | -49 | 0 | `████████░░░░░░░░░░░░` / `██████████████████░░` |

Overall: **47.9/100** versus **91.9/100**, gap **-44.0**, movement **0.0**, verdict **REGRESSION** for the deployed response evidence. The benchmark overall fell to 92.5 and B12's wrong-referent scores fell from 60 to 40; no capability point is justified.

### 1. Verdict

**WRONG** — the diff is a prompt-wording repair presented as a structural referent fix, it fails its own explicit post-deploy falsifier, and its new completeness predicate still authorizes fabricated absence claims for repeated unattributed pushes.

### 2. Claims not supported by the diff

1. **“Progressing on the referent half” / “the conversation chooses the subject, not this block.”** The code does not resolve or pass a subject identity. It merely adds instructions telling the model to resolve one (`server/src/services/selfpruning/pushHistoryBlock.ts:91-137`) while the evidence rows still expose opaque keys such as `item:<cuid>` (`:144-149`). The tests assert that those English instructions occur and are ordered (`server/tests/def197PushHistoryBlock.test.ts:220-255`); none runs either composer and inspects the final answer. The measured final answer chose another wrong item, satisfying the build's falsifier verbatim (`server/docs/orchestrator/build_log.md:1290-1300`).
2. **“This renderer has four ways to be short” / absence is informative when those four checks pass.** `NoiseSummary` also contains `unattributed` and `floods`, explicitly holding pushes with no item/thread/event identity. `absenceIsInformative` ignores both (`server/src/services/selfpruning/pushHistoryBlock.ts:68-85`), and the renderer only derives repeats from `s.subjects` (`:154-176`). A repeated unattributed push can therefore exist while the block authorizes “your record shows at most one push.” The new test fixture initializes `unattributed: []` and never tests the non-empty case (`server/tests/def197PushHistoryBlock.test.ts:44-52,257-301`).
3. **“The referent half is a new root cause” and the change is structural.** The measured mechanism is still `examples-outvote-the-instruction`: evidence candidates and their exact times are concrete, while the conversation-first rule is prose. Adding stronger uppercase prose in the same block does not create a resolver or constrain the data supplied to the model. The diff supports a prompt-contract attempt, not structural closure.
4. Verification counts and file accounting are supported: tsc, 198 passing files/2,455 passing tests, build and diff-check match the build entry. Benchmark and forbidden paths are untouched.

### 3. Correctness and regression risks

1. **CRITICAL — live cross-subject status fabrication.** Input: recent dialogue establishes subject A; the 36-hour push history contains repeat rows for unrelated subject B. Behaviour: Brain selects B, reports its count/timestamps as the answer about “that one,” and forces the owner to correct it (`server/src/services/selfpruning/pushHistoryBlock.ts:91-149`; measured `B12-reminder-referent`). This is a sixth-generation `fabricated-status`/continuity failure on the messaging path.
2. **HIGH — absence can still be asserted from an incomplete identity partition.** Input: the owner asks about a repeat notification whose queue rows lack item/thread/event identity, so the rows live under `unattributed`; `subjects` is otherwise complete and unsliced. Behaviour: `absenceIsInformative` returns true and tells Brain the subject was pushed at most once despite multiple unattributed rows (`server/src/services/selfpruning/pushHistoryBlock.ts:81-85,119-129,154-176`). The protection narrows three known incomplete states but misses the summarizer's second collection.
3. **MEDIUM — the degraded-page instruction falsely says “see the ⚠ flags above” for line-cap-only degradation.** Input: more than 12 repeat subjects, with no truncation/canonicalization flags. Behaviour: the block correctly refuses absence inference, but tells the model to consult warning flags that do not exist; only a non-warning “and N more” line is rendered (`server/src/services/selfpruning/pushHistoryBlock.ts:125-129,164-193`). This can weaken compliance exactly when the list was sliced.

### 3b. CARRIED FINDINGS — pre-existing, not this diff

none. The wrong-referent problem predates the diff, but this iteration explicitly attempted and claimed progress on it; its failure is therefore assessed against this diff rather than hidden as carried debt.

### Orchestrator-owned changes and state

The only orchestrator-owned committed path is `server/docs/orchestrator/build_log.md`; it does not alter runtime control-plane behavior. Deployment state names `5176c60`, matching the owner's live-artifact statement. Benchmark integrity and forbidden-path checks are clean. The dirty `brain_evaluation_chart.md` and scorecard/session state are separate WIP and are not charged to the Builder.

### 4. AIM

**AIM: ON_TARGET —** resolving a reminder referent and preventing authoritative facts from being attached to the wrong task is directly Accurate Communication on an owner-reachable path. The aim was correct; the implementation did not reach it. C4 remains the gate at 86.9 for stilted/formal register across B02/B05/B07/B10/B11/B12, which this turn explicitly did not address.

### 5. CAPABILITY ATTRIBUTION

```
claimed:   Accurate Communication — progress on the referent half of B12; no C4 movement claimed
verdict:   OVERSTATED
reasoning: The completeness checks are a partial reliability improvement, and the capability label is correct. But no referent is resolved in code; the renderer still supplies a multi-subject page and asks the model to choose. Post-deploy B12 selected another unrelated subject and dropped C1/C2/C3/C6 to 40, directly firing the Builder's falsifier (`pushHistoryBlock.ts:91-149`; build_log.md:1290-1300). This is no demonstrated capability movement.
```

### 6. Directive for the next build turn

1. **Replace prompt-only referent selection with data scoping.** Resolve “that one” from immediate conversation using the existing conversation/open-item identity mechanism before building push evidence. Pass the resolved item/thread/event identity into `buildPushHistoryBlock` and render only that subject's rows. If identity is unresolved or absent, return explicit unknown/incomplete evidence; never expose unrelated repeat subjects as candidates for the answer.
2. **Test the final owner-visible path, not instruction strings.** Reproduce the exact fixture: conversation says Fujairah, push history also contains ShireMe and Vision Metric repeats. Run both reasoning and legacy composition through the rendered answer and assert neither unrelated title/count appears. Mutation: remove subject scoping and both tests must fail.
3. **Close the completeness partition.** `absenceIsInformative` must account for non-empty `unattributed`/`floods`, not only pagination, canonicalization and line slicing. Absence is evidence only when every reached row can be assigned to the queried identity and the requested identity was within the complete window.
4. **Do not authorize “at most one” from a 36-hour window without time qualification.** If the conversation's reminder falls outside the window or the user does not specify when, report what the bounded record shows rather than an unqualified lifetime count.
5. **After truth/continuity is repaired, address C4 structurally.** The repeated gate is formal/report-like register—“Good evening, Sir,” “The system ... does not have the capability,” repeated “to you,” and robotic due-date phrasing. Correct persona demonstrations and final rendering across cases; do not add case-specific strings.
