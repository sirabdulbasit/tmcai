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

## Iteration 57 — 2026-09-01

**ROLLBACK: no.** The diff is sound and, in any case, not live: `deployed-sha` is
`8882bd5`, which is BEHIND this range (`9abc41c`→`19d3860`). `git merge-base --is-ancestor
19d3860 8882bd5` → NOT deployed. The harness "you are reviewing code that is already live"
premise is **false for this iteration** — DEF-259 is branch-only. Production still runs the
old `rulesFor(false, incompletenessReasons(s, 0, allRepeats.length), …)` line
(`git show 8882bd5:…/pushHistoryBlock.ts:415`), i.e. the false line-cap reason is what is
live, not this fix.

### 1. Verdict: SOUND
Two `export` keywords, one truthful-reason branch in the scoped no-match state, and a
paired test suite. Every build-log claim checks out against the diff; the one behaviour
change on a live-reachable path is correctly gated and is strictly *more* truthful than
what it replaces. tsc exit 0 (re-run), touched suite 67/67 (re-run). Nothing here deserves
WEAK: the finding that dominates this iteration is the measurement, not the code.

### 2. Claims not supported by the diff
**None material.** Spot-checks that held:
- "assembleSystemPrompt EXPORTED / renderUserMessage EXPORTED, no behaviour change" —
  `brainComposer.ts:1693` and `reasoningCompose.ts:321` are `export` keyword additions
  only; bodies untouched. True.
- "no query and no write touched … resolveSubjectTitles remains scoped by id AND
  clientNumber AND userId" — diff touches no query. True; `selectSubjectsForConversation`
  and the resolver are unchanged.
- "the false line-cap bullet is gone from the scoped no-match state" — the replacement
  calls `incompletenessReasons(s, allRepeats.length, allRepeats.length)`, so
  `shown < repeatsTotal` (`pushHistoryBlock.ts:175`) is false and the line-cap sentence
  cannot render. True.
- Verification numbers: I independently re-ran and confirm tsc exit 0; def197 suite
  **67 passed**; the 10 vitest failures are **entirely** `tests/orchestratorSpend.test.ts`
  (see §3b), not this diff.

One correction, not a contradiction: the build log frames the turn as closing the
Iteration-2 review "the same findings govern." The review seat is NOT dead this iteration —
I am producing this review against the real diff. Whatever DEF-258 fixed, a review runs
tonight; treat the "dead since 08-25" line as describing the prior window, not now.

### 3. Correctness and regression risks — this diff
**None rising to a defect.** The single behaviour change is the new authorization in the
scoped no-match branch (`pushHistoryBlock.ts:426`):
`scopedInformative = allRepeats.length === 0 && absenceIsInformative(s, 0, 0)`.
I checked the one way this could be wrong — authorizing "at most once" when something was
actually pushed twice:
- `REPEAT_THRESHOLD = 2` (`:150`), so `allRepeats.length === 0` means **no** subject
  reached 2 pushes → "at most once in the window" is literally true for every subject.
- Hidden multi-pushes that never reach `s.subjects` (the DEF-200 escape) are covered:
  `absenceIsInformative` (`:184`) requires `unattributed.length === 0 && floods.length === 0`
  plus `!truncated && !canonicalisationFailed && unresolvedSubjects.length === 0`. So the
  authorization fires only in a provably-clean, zero-repeat window.
- The "at most once" wording still renders in exactly one place (`rulesFor` absence branch,
  `:296-297`); `rulesFor` is called once per render. DEF-257's one-implementation property
  holds. Test pins `hits.toHaveLength(1)` (`def197…:259`).

Net: in the clean zero-repeat state the OLD code was itself wrong — it emitted "THIS LIST
IS INCOMPLETE" with an empty reasons list and forbade a true statement. The new code both
removes the line-cap lie AND stops asserting false incompleteness. This is a truthfulness
improvement, not a lateral move.

### 3b. CARRIED FINDINGS — pre-existing, not this diff
- **CRITICAL (measurement) — the iter-57 benchmark scored NOTHING; the gate's
  null@null is an infra failure, not a Brain result.** `scores/iter-57-post-build.json`:
  `overall: null`, `criteriaAvg: {}`, `casesScored: 0`, `casesFailed: 12`, `fixQueue: []`.
  Every one of the 12 cases has `answer: "I'm having trouble reasoning right now. Please try
  again in a moment."` and `error: "judge returned nothing"` — i.e. Brain's reasoning call
  degraded to its fallback on all cases and the judge returned empty. **No capability
  conclusion is possible this iteration**, for the target or any criterion. This is
  orchestrator-owned (the collector/judge/model wiring), lives only in the loop's records,
  and is the single most important thing to fix before the next scored turn — a null score
  read as a pass or a regression would mislead every downstream decision. Not caused by the
  diff; the diff cannot move a benchmark that never scored.
- **HIGH (tree hygiene) — the working tree is RED from a concurrent session, not the
  Builder.** `orchestratorSpendService.ts` is +94/-1 vs HEAD (working 548 lines, HEAD 456);
  `schema.prisma` +10; untracked `migrations/20260831_orchestrator_spend_limits/`,
  `product_size_codex.md`, `product_size_grok.md`. All 10 vitest failures are in
  `tests/orchestratorSpend.test.ts` at `orchestratorSpendService.ts:514`, a line that does
  not exist at HEAD (`git show HEAD:…` = 456 lines). Branch-only, uncommitted — a
  `git pull --ff-only` deploy would NOT carry it, so production is unaffected. But it leaves
  the standing matrix RED in this tree and would fail any full-vitest gate run against the
  dirty tree. Orchestrator-owned; commit-or-revert it.
- **LOW (live) — the false line-cap reason is in production.** `8882bd5:pushHistoryBlock.ts:415`
  passes `incompletenessReasons(s, 0, allRepeats.length)`, so in the scoped no-match state
  with repeats present, the live refusal blames a "list cut to 12 lines" that did not happen.
  Impact is bounded: it corrupts only the *reason* text of an already-correct refusal, on a
  rarely-hit state. This iteration fixes it — it just hasn't shipped.

### 4. AIM: MISAIMED
Target was **Self-Pruning** (attempt 9). The file touched (`selfpruning/pushHistoryBlock.ts`)
sits in the self-pruning module, but the change moves **Accurate Communication** — the
truthfulness of a refusal's stated reason and a narrow truthful authorization. It does not
change what Brain prunes, withholds, or pushes. The Builder declared this divergence
explicitly ("remediation wins on scope"), which is the honest call for a mandated
attempt-3 remediation turn. Not a verdict factor; correct it by aiming iteration 58, not by
redoing this one.

### 5. CAPABILITY ATTRIBUTION
```
claimed:   Accurate Communication (PREDICTED +0, "no score claim")
verdict:   SUPPORTED — but reliability-grade, and the +0 is the honest number
reasoning: pushHistoryBlock.ts:415-435 removes a false sentence (line-cap that never
           happened) and stops a false "INCOMPLETE" assertion in the clean zero-repeat
           state; reasoningCompose.ts:321 / brainComposer.ts:1693 are test-visibility
           exports with no runtime effect. This genuinely improves the truthfulness of
           the push-history refusal (Accurate Communication), but the surface is one
           degraded prompt-block state that a benchmark case may never hit — hence +0 is
           correct, and this turn's score can neither confirm nor deny it (§3b: the
           benchmark scored zero cases).
```

### 6. Directive for the next build turn — ranked
1. **ORCHESTRATOR, before anything else: repair the benchmark.** iter-57 scored 0/12 with
   Brain degraded to "trouble reasoning" and the judge returning nothing. Until a run
   produces non-null `overall`/`weakestCriterion`, every gate read is meaningless and no
   Self-Pruning attempt can be measured. Check the model/judge credentials the collector
   runs with (the vitest matrix used `env -u GEMINI_API_KEY`; if the benchmark inherited a
   stripped key, that is the cause). This blocks the loop more than any Brain code.
2. **ORCHESTRATOR: ship the backlog and clean the tree.** Production is `8882bd5`, behind
   DEF-253/256(partly)/257/259. Deploy the reviewed-or-arbitrated backlog so the false
   line-cap reason (live now) and the DEF-257 single-sourcing actually reach the owner;
   and commit-or-revert the uncommitted `orchestratorSpendService.ts`/`schema.prisma`/
   migration that is holding the tree RED.
3. **BUILDER, once measurement is restored: a real Self-Pruning increment.** The 56→92 gap
   is untouched by 57. Pick one owner-reachable pruning decision (what Brain suppresses vs
   surfaces on a repeat-push / noise turn) and move it, with a benchmark case that exercises
   it — not another prompt-block truthfulness patch. Only worth doing after directive 1, so
   the move is visible.

## Iteration 57 — 2026-09-01

**1. Verdict: `SOUND`** — the diff is two behaviour-neutral exports plus one branch in
`pushHistoryBlock.ts` that removes a false refusal-reason and adds a *fail-closed*
authorization that fires only in a provably-safe state; tsc exit 0, touched suite 67/67,
and the reviewer's own mutation criterion executed. Nothing in it is dangerous live.

**ROLLBACK: no.** The behavioural change narrows nothing the model could previously say
truthfully and widens no unsafe assertion (proof in §3). The two exports change no runtime
path. There is nothing here to roll back.

**2. Claims not supported by the diff**

- **The header's "score is MEASURED and current" is FALSE for this iteration — and this is
  the most important thing in the review.** `scores/iter-57-post-build.json` has
  `casesScored: 0`, `casesFailed: 12`, `overall: null`, `weakestCriterion: null`,
  `fixQueue: []`. Every one of the 12 cases carries `error: "judge returned nothing"`, and
  the model-under-test itself returned the reasoning-failure fallback
  (`answerSanitizer.ts:93` — *"I'm having trouble reasoning right now"*) on B01. So BOTH the
  system-under-test and the judge produced nothing this run. There is no measurement to
  attribute anything to. `tmcai-server` is online (pm2, 9h uptime) so this is a
  benchmark-harness/env failure (the build turn ran the matrix under `env -u
  GEMINI_API_KEY`; the reasoning path evidently inherited a missing model key), **not** a
  production outage and **not** caused by this diff. But the consequence is severe and must
  be said plainly: **with the review seat dead since 08-25 (DEF-258) AND the benchmark now
  scoring nothing, the loop is completely blind — neither of its two feedback signals is
  producing a value.** That is a finding for the orchestrator, and it outranks any code
  note this turn.
- Everything the build log's Iteration-57 entry claims about the diff *is* supported:
  `assembleSystemPrompt` exported (`brainComposer.ts:1693`), `renderUserMessage` exported
  (`reasoningCompose.ts:321`), the no-match branch rewritten (`pushHistoryBlock.ts:415-435`),
  67/67 on the touched suite (re-run, confirmed), tsc exit 0 (re-run, confirmed). The claim
  that the 10 vitest failures are foreign is verified: `orchestratorSpendService.ts` is NOT
  in the reviewed range (`git diff 9abc41c 19d3860 --name-only` — absent) and shows as an
  uncommitted `M` in `git status`. Honestly quarantined, not absorbed.

**3. Correctness and regression risks (this diff)** — none rise above informational.

- `pushHistoryBlock.ts:426` — the one behavioural line,
  `scopedInformative = allRepeats.length === 0 && absenceIsInformative(s, 0, 0)`. This is
  the reversed `guard-destroys-the-answer` shape the history warns about, so I traced it:
  the new authorization can fire ONLY when zero subjects reached `REPEAT_THRESHOLD` in the
  window AND `absenceIsInformative` is true (no `truncated`, `canonicalisationFailed`,
  `unresolvedSubjects`, `unattributed`, `floods`; `pushHistoryBlock.ts:184-198`). A repeat
  push can hide from `allRepeats` only in `unattributed`/`floods`/`truncated` — every one of
  which `absenceIsInformative` already excludes. So in the state that authorizes, "no repeat
  push in the last N hours" is *literally true*, window-bound, and the DEF-257 one-
  implementation property still holds (test at suite line 735 pins `hits.toHaveLength(1)`).
  The previous code passed `false` unconditionally, refusing even here — i.e. the change
  makes the block MORE truthful in the safe state and leaves every uncertain state refusing.
  **Fail-closed confirmed. No unsafe widening.**
- `pushHistoryBlock.ts:433` — `incompletenessReasons(s, allRepeats.length, allRepeats.length)`
  passes `shown === repeatsTotal`, which suppresses the `shown < repeatsTotal` line-cap
  bullet (`:175`) while preserving every genuine ⚠ reason (truncated/canonicalisation/etc.).
  This is exactly the false-"cut to 12 lines" removal claimed, and the test asserts both the
  removal and the retention of real reasons. Correct.
- Benchmark integrity: the diff does NOT touch `nexeoCapabilityBenchmark.ts`,
  `brainResponseEvaluator.ts`, or `calibrateResponseJudge.ts`. No score-motivated edit.
- Forbidden paths: none in the diff or the tree.

**3b. CARRIED FINDINGS — pre-existing, not this diff**

- **DEF-258 (review seat dead since 08-25) is still open and is now compounded by the null
  benchmark above.** Already live in the orchestrator's own tooling, not Brain code. Not
  this diff's fault; carried so the orchestrator owns it. The combination means every
  ITERATION_VERDICT and every score since 08-25 rests on nothing.
- **Uncommitted concurrent work in the tree, not the Builder's** (judged separately, per the
  orchestrator-scope rule): `orchestratorSpendService.ts` (+93/-1, failing 10 tests at
  `:514`), `schema.prisma`, `prisma/migrations/20260831_orchestrator_spend_limits/`, and two
  untracked root files `product_size_codex.md` / `product_size_grok.md`. None are in the
  reviewed range and none are charged to the Builder. Flag for the orchestrator: a WIP
  migration sitting in the tree ships with the next deploy if `git add` is not disciplined —
  the exact BLD-001 shape CLAUDE.md rule 4 exists to prevent. Someone should confirm those
  paths are intended before the next deploy stages anything.

**4. AIM: MISAIMED** — the iteration was aimed at Self-Pruning (widest gap, 36 vs 92); this
diff moves **Accurate Communication** (truthful refusal wording + testability of the absence
claim). The Builder declared this divergence openly and it was a *mandated remediation turn*
on the Iteration-2 WRONG review, so the misaim is a planning artifact, not a defect. Per the
standing rule this does not touch the verdict. Correct the aim on the NEXT iteration, not by
redoing this one.

**5. CAPABILITY ATTRIBUTION**
```
claimed:   Accurate Communication · PREDICTED +0 (no score claim)
verdict:   SUPPORTED — with the caveat that the two exports are RELIABILITY-ONLY
reasoning: pushHistoryBlock.ts:415-435 removes a false sentence from the model's
           instructions and makes a truthful window-bound statement available in the
           safe state — a genuine truthfulness refinement to Accurate Communication.
           brainComposer.ts:1693 and reasoningCompose.ts:321 are pure test-enablement
           (RELIABILITY-ONLY): no runtime path changes. The +0 prediction is honest;
           this turn cannot move a score that did not compute.
```

**6. Directive for the next build turn** — ranked, most valuable first:

1. **The loop is blind — fix the measurement before building anything else.** The benchmark
   scored 0/12 this iteration (every case `judge returned nothing`, the model itself hit the
   reasoning fallback) and the review seat has been dead since 08-25. Neither is Brain code,
   both are the orchestrator's, and until at least ONE of them produces a real value, every
   verdict and every capability claim is unfalsifiable. Diagnose why the benchmark ran with
   no working model/judge key (the `env -u GEMINI_API_KEY` matrix env is the first suspect)
   and re-run `iter-57-post-build` to a real `overall` and `weakestCriterion`. This is the
   only directive that matters until it is done.
2. **The Builder's own iteration-56/57 finding is correct and should be acted on: DEPLOY the
   reviewed-or-arbitrated backlog.** DEF-256 is deployed; DEF-253/257/259 sit CODE-COMPLETE
   and unshipped while Grok scores production. With no live reviewer, the arbitration path
   (orchestrator-campaign skill) is how these reach production. This is an orchestrator
   action, not a build task.
3. **Only after 1 and 2 — return to Self-Pruning (attempt 10).** The 56-point gap is
   untouched and cannot be closed by more prompt-block truthfulness patches. Identify the
   Self-Pruning surface that actually runs on the owner's path (the inbound-noise ledger /
   push-suppression decision, not the block that *describes* it) and move it, with a
   benchmark case that exercises it. Do NOT attempt this while the benchmark cannot score.

## Iteration 62 — 2026-09-01

**Scope note first, because the labels do not line up.** The `build_log.md` "Iteration 62"
section describes DEF-267 quoted-text work in `WebjsProvider.ts`/`WhatsAppInbound.ts` —
**that is not what this turn produced.** The actual reviewable change is the **uncommitted**
DEF-277 suppression-digest work in `brainOutboundService.ts` + the untracked
`def277SuppressionDigest.test.ts`, whose narrative lives only in the `brain_change_log.md`
DEF-277 row. The header's own test numbers settle it: **3211 passed / 264 files matches the
DEF-277 row exactly**, not DEF-267's 3189/262. So I judge DEF-277, and I flag that this
iteration shipped no `build_log` entry for the code it actually wrote.

**1. Verdict: `SOUND`** — the digest mechanism is real (not inert), tenant-scoped,
fail-safe, and correctly bounded; record() persists the metadata the digest query reads
(`brainOutboundService.ts:880`), the tier loop skips the new kind, the daily cap exempts it,
and dedup neither recurses nor burns its key on a hold. tsc exit 0 (re-run), the new suite
8/8 (re-run), no benchmark or forbidden path touched.

**ROLLBACK: no — and note the premise does not hold this turn: this work is UNCOMMITTED, so
it is NOT live.** The deployed HEAD `a6044b8` ran `ea83f08` (DEF-273/276). Nothing in the
DEF-277 diff is in production; there is nothing to roll back. When it *is* committed and
deployed it is safe to ship (evidence in §3).

**2. Claims not supported by the diff**

- Build log (DEF-277 row): *"`record()`'s reason argument is logged and returned but never
  persisted, so the audit trail could not distinguish a budget hold from a dedup skip."* The
  first half is true (the 2nd positional `reason` string is not written to a column), but the
  framing undersells what already worked: `record()` **has always persisted the `metadata`
  object** (`brainOutboundService.ts:880`, `metadata: (o.metadata ?? {})`). The fix rides that
  existing persisted channel by stamping `metadata.suppressedBy='budget'` — which is exactly
  why the digest query at `:1021` can find the rows. This is the load-bearing fact for the
  whole feature and the build log states it as if metadata were newly persisted. It is not a
  defect; it makes the fix *sounder* than the narrative claims. Worth correcting for the record.
- Everything else the DEF-277 row claims checks out against the tree: the digest is exempt
  from the daily cap only (`:426` `&& req.kind !== SUPPRESSION_DIGEST_KIND`) and from tiers by
  non-membership (`SUPPRESSION_DIGEST_KIND` is in neither `DIAGNOSTIC_KINDS` nor
  `HOUSEKEEPING_KINDS`, `:351-382`, so the loop `continue`s at `:385`); dedup counts only
  `sent`/`partial` (`:489`) so a quiet/office-hours hold retries; the curated fallback fires
  only on `callLLM` failure and `callLLM` genuinely returns `{text}` (`llmRouter.ts:131`), so
  "wording belongs to the model" is real, not always-fallback; opt-in still binds (the digest
  does not set `bypassOptIn`). 8/8 and tsc 0 reproduce.

**3. Correctness and regression risks (this diff)** — all LOW; none dangerous-while-live.

- `brainOutboundService.ts:1043` — **an `await callLLM` runs on EVERY budget hold, before the
  digest reaches its own dedup gate.** `maybeSendSuppressionDigest` is `void`-called at both
  suppression sites (`:412`, `:435`) on every hold; it composes via LLM *then* calls
  `brainContactsUser`, where dedup (`:483`) suppresses all but the first digest of the day. So
  N budget holds in a day ⇒ N LLM calls (12s timeout, 300 tok each) for 1 delivered digest.
  Failure scenario: a 40-message suppression burst ⇒ ~38 wasted Gemini calls. Bounded by real
  hold events and fail-safe, so not a correctness bug — but if the cheap `held.length===0`
  short-circuit were moved above the LLM call *and* a same-day-already-sent check added before
  composing, it would drop to one call. Cheap win for a later turn.
- `brainOutboundService.ts:1064` — **the dedup key is the calendar date
  (`…:${ISO.slice(0,10)}`) while the window is a rolling 24h.** A digest sent 23:00 keys on
  day-1; a new hold at 01:00 keys on day-2 and sends a *second* digest two hours later, and
  because the held query (`:1013`) looks back a rolling 24h, that second digest re-counts the
  23:00 holds. Failure scenario: owner gets two digests ~2h apart across midnight with
  overlapping counts. "One per (user, day)" is true for a calendar day but not for any rolling
  24h; minor owner-facing noise, not data loss.
- Benchmark integrity: none of the three scoring files touched. Forbidden paths: none in the
  diff or tree. Tenant scoping: the held query and the send are both (clientNumber, userId)-
  scoped (`:1015-1017`), digest goes only to the affected owner — no cross-tenant path.

**3b. CARRIED FINDINGS — pre-existing, not this diff**

- **The capability benchmark is still producing NOTHING — same failure as iteration 57, one
  turn later, un-actioned.** `iter-62-post-build.json`: `casesScored: 0`, `casesFailed: 12`,
  `overall/weakestCriterion: null`, every case `error: "judge returned nothing"` and the
  model-under-test returning the `answerSanitizer` reasoning fallback. Combined with the review
  seat dead since 08-25 (DEF-258), **both feedback signals remain dead and the header's "score
  is MEASURED and current" is false for the second consecutive reviewed iteration.** This is
  orchestrator-owned and is the single highest-value fix in the whole loop; it was directive #1
  last turn and did not happen.
- **`build_log.md` has no entry for the DEF-277 work in the tree** (its "Iteration 62" is the
  DEF-267 quoted-text turn). Process gap, orchestrator/campaign bookkeeping — the reviewed code
  and the build log are decoupled this turn; only the `brain_change_log` row carries the
  narrative. Not Brain code; carried so it is not lost.
- **Uncommitted concurrent-session litter in the tree:** untracked `product_size_codex.md`,
  `product_size_grok.md`, `"Brain Evolution2.jpeg"`. Not the Builder's DEF-277 change and not
  in any commit; flag so a future `git add` does not sweep them into a deploy — the exact
  BLD-001 hazard iteration 60 already named and iteration 62's own build log says just bit the
  DEF-267 half.

**4. AIM: MISAIMED (as against the header's stated "Thinking" target) — but ON_TARGET for the
Self-Pruning gap the table and the build log actually name.** The prompt is internally
contradictory: the section title and the judgment line say **Thinking**, while the gap table
and "WIDEST GAP" say **Self-Pruning (56)**, which is also what DEF-277 declares. The diff
moves neither reasoning nor planning, so it does not touch *Thinking*. It does plausibly move
*Self-Pruning*: it makes the pruning mechanism's held-count observable to the owner, which is
the "manage volume AND account for it" half of that capability. Aim does not affect the
verdict; recording the contradiction so the next target is set from a single source.

**5. CAPABILITY ATTRIBUTION**
```
claimed:   Self-Pruning · "increment-2 exit evidence becomes producible — a real burst
           yields one message naming the held count"; no score claim
verdict:   SUPPORTED, with a precise caveat: the behaviour added is TRANSPARENCY of pruning,
           not smarter pruning. The suppression (DEF-104/271 tiers + daily cap) already
           existed; this diff adds the receipt.
reasoning: brainOutboundService.ts:412/435 stamp WHY on the held row and fire the digest;
           :1043-1070 emit one bounded receipt through the same brainContactsUser chokepoint.
           As increment 2 of a Self-Pruning campaign the attribution is defensible; a purist
           would file "the owner learns what was held" under Accurate Communication. Either
           way the claim is honest and unexaggerated (explicit "no score claim").
```

**6. Directive for the next build turn** — ranked, most valuable first:

1. **Fix the measurement before ANY new build — this is the second turn it has scored zero.**
   `iter-62-post-build.json` scored 0/12, every case `judge returned nothing` and the model
   itself hitting the reasoning fallback. Until the benchmark returns a real `overall` and
   `weakestCriterion`, every SOUND verdict ships blind and no capability claim is falsifiable.
   First suspect remains the matrix env (`env -u GEMINI_API_KEY` leaving the reasoning/judge
   path keyless); confirm the benchmark runs with working model + judge credentials and re-run
   iter-62. Orchestrator-owned; nothing else matters until it produces a number.
2. **Commit the DEF-277 work and write its `build_log` entry.** It is sound but uncommitted and
   undocumented in the build log; leaving it dirty invites the same concurrent-session
   `git add` sweep that already mis-attributed the DEF-267 half (build log's own INCIDENT
   note). Name the files, commit, then it can deploy and its falsifier (a real burst yields one
   digest) can actually be tested live.
3. **Two cheap DEF-277 refinements while it is fresh** (`brainOutboundService.ts`): (a) short-
   circuit `held.length===0` and a same-day-already-sent check ABOVE the `callLLM` call at
   `:1043` so a burst does not spend one Gemini call per hold; (b) make the digest genuinely
   once-per-rolling-window by keying dedup on the window, not the calendar date, so two digests
   cannot fire 2h apart across midnight with overlapping counts. Both are LOW severity; do them
   only if directives 1–2 are clear.
4. **Only after the benchmark scores — return to the real widest gap (Self-Pruning, 36).** The
   digest is transparency *about* pruning; the 56-point gap is the pruning DECISION itself (the
   inbound-noise ledger / suppression logic on the owner's path). Move that, with a benchmark
   case that exercises it — and do not attempt it while the benchmark cannot measure whether it
   moved.

## Iteration 67 — 2026-09-03

**LIVE STATUS FIRST.** `state/deployed-sha` reads `caea52f` — the reviewed HEAD — so this
DEF-293 change is **running on the owner's production WhatsApp path now**. Nothing in it is
dangerous while live: it is purely ADDITIVE context (two read-only, tenant-scoped queries
rendered into an existing prompt block), fail-safe, and it removes/gates no existing answer.
**ROLLBACK: no** — additive evidence provision, tenant-scoped, fail-closed to "unavailable",
on both composer paths; there is nothing here to unwind.

**1. Verdict: `SOUND`** — DEF-293 surfaces two records that were STORED but never in context
(`brain_prompt_queue`: the question Brain asked + his answer; `item_status_history`: attempted
transitions + the recorded rejection reason) into the ONE shared `buildDispatchLedgerBlock`
that both composer paths read, tenant-scoped, bounded, fail-closed, and it reads the actual
`outcome` column rather than inferring status. This is the structural class fix its own build
log claims, verified below — not a patch on one call site.

**The high-yield check cleared — this is NOT `protection-with-two-implementations`.**
`buildDispatchLedgerBlock` is invoked at `brainComposer.ts:2843` (reasoning path) AND
`brainComposer.ts:3556` (legacy path), and DEF-165 already unified both onto the SAME builder
(the comment at `brainComposer.ts:1734-1745` names this explicitly: "Same builder, not a
second copy — `protection-with-two-implementations` … two ledger renderers would be the
tenth"). DEF-293 edits that single builder (`dispatchLedgerService.ts:322-385`), so both paths
inherit the new interaction records with zero drift. `grep` for other renderers of
`brainPromptQueue`/`itemStatusHistory` into context finds none competing on the compose path.

**The `fabricated-status` check cleared.** The transition render at
`dispatchLedgerService.ts:377-380` maps `outcome === 'accepted' ? '✓' : REFUSED`. The
`item_status_history.outcome` domain is EXACTLY `{accepted, rejected}` — enforced at the type
level (`lifecycleService.ts:178` `outcome: 'accepted' | 'rejected'`) and documented in the
schema (`schema.prisma:1256`, `// accepted | rejected`). The other `outcome:` literals grep
surfaces (`failed`, `consumed`, `success`, …) belong to different tables, not this one. So the
binary read is faithful to the column, not an inference — the exact opposite of the
`fabricated-status` shape.

**2. Claims not supported by the diff**

- Build log: *"each query deferred into the promise chain so even a synchronous throw is
  caught (the DEF-274 gap)"* — SUPPORTED. `dispatchLedgerService.ts:170,181,199` each wrap the
  Prisma call in `Promise.resolve().then(() => …).catch(() => null)`, so a mock/client that
  throws on synchronous property access is caught. Verified against the diff.
- Build log: *"both composer paths already read … no path can drift"* — SUPPORTED (call sites
  `2843`/`3556`, single builder). Verified.
- Build log: *"A failed read is `null` — unavailable ≠ none (DEF-085)"* — SUPPORTED. The
  interface types both arrays as `… | null`, and the renderer prints
  `"(this record could not be read — say you cannot tell, do not guess)"` on `null`
  (`dispatchLedgerService.ts:349-350,360-361`), never a false empty. Verified.
- **Minor — the build log carries TWO `## Iteration 67` sections** (a 2026-09-02 no-op deploy
  certification and the 2026-09-03 DEF-293 build). The reviewed range `915a75e..caea52f` is
  exactly the one DEF-293 commit; the first section describes a prior certification turn that
  produced no code. Not a claim-vs-diff contradiction for this commit, but the build log
  conflating two turns under one iteration number is a bookkeeping smell — call it out so the
  next reader does not attribute the cert turn's reasoning to this diff.
- Verification numbers (3314 passed / 277 files; new suite 8 passed): the suite is confirmed 8
  tests with the tenant-scope assertion present (`def293JustActedReferent.test.ts:34-50`,
  `clientNumber === 'TMC-0001' && userId === 2` on all three queries). tsc-clean and full-count
  are the deploy-gate's measurement, not re-run here; nothing in the diff contradicts them.

**3. Correctness and regression risks (this diff)** — all LOW; none dangerous-while-live.

- `dispatchLedgerService.ts:339-346` — **three extra DB reads on EVERY compose turn, on both
  composer paths**, i.e. on the owner's live messaging path. All are `(clientNumber, userId)`-
  scoped with `take: 10` and the title lookup is `id IN (…)`, so latency is bounded and small —
  but it is new per-turn cost that did not exist before, worth naming. Not a correctness bug.
- `dispatchLedgerService.ts:388-393` — **the referent rule says "the most recent line ABOVE is
  the thing he means," but "above" spans two separately-sorted sub-blocks** (prompts `id desc`,
  transitions `createdAt desc`). The single most-recent interaction could be the top line of
  EITHER block; the model must compare the rendered timestamps to pick. Failure scenario: a
  refusal at 10:02 and a prompt-answer at 10:05 both render at the top of their own block; a
  bare "which one?" could resolve to the refusal if the model reads "above" positionally rather
  than by timestamp. LOW — the timestamps are rendered so it is recoverable, and it is prompt
  guidance to a model, not a code guard. A later turn could merge both into one time-ordered
  list to make "most recent" unambiguous.
- `dispatchLedgerService.ts:388-393` — **the instruction "Never offer other items from
  elsewhere in your context while a line here matches the moment" is strong.** It is prompt
  text, not a code guard, so it CANNOT `guard-destroy-the-answer` (no canned denial replaces
  output). But it could bias the model to over-anchor on a ledger line when the owner genuinely
  meant a fresh item. Conditioned on "while a line here matches the moment" and the model still
  decides, so risk is LOW — flag for the live watch, not a fix.

**3b. CARRIED FINDINGS — pre-existing, not this diff**

- **The capability benchmark produced NOTHING again — `iter-67-post-build.json`:
  `casesScored: 0`, `casesFailed: 12`, `overall`/`weakestCriterion` `null`, `fixQueue: []`.**
  This is the THIRD reviewed iteration in a row with a dead measurement (57, 62, 67). The
  header's "score is MEASURED and current" is false for the third consecutive turn. This is
  orchestrator-owned and is the single highest-value item in the loop: every `SOUND` verdict —
  including this one — ships to production BLIND, and no capability claim (this diff's included)
  is falsifiable until it returns a real `overall` and `weakestCriterion`. Already live/ongoing,
  not introduced here.
- **`state/deployed-sha` is dirty/uncommitted while already reading `caea52f`** (git status
  shows it modified). Same half-executed-deploy shape the prior turn's build log flagged: state
  advanced, its commit pending. Orchestrator must make deploy completion atomic (state + log +
  restart land together) or the next iteration's "N undeployed commits" premise is one crash
  from wrong. Orchestrator-owned.
- **Untracked root litter still present** — `product_size_codex.md`, `product_size_grok.md`,
  `"Brain Evolution2.jpeg"`. Flagged at iterations 60, 62, 66; still a BLD-001 `git add` sweep
  hazard. Not the Builder's DEF-293 change.

**Orchestrator-owned items (judged separately, not charged to the Builder):** the dead
benchmark, the dirty `deployed-sha`, the stranded reviewer lines / dual build-log header, and
the root litter above are all orchestrator/campaign bookkeeping. None is Brain code; none is
dangerous while live except insofar as the dead benchmark means the loop is flying blind.

**4. AIM: MISAIMED** (relative to the harness's stated targets) — **ON_TARGET for Memory,
which is what the build log honestly declared.** The header names *Thinking*; the gap table
names *Self-Pruning (56)*; the two contradict each other, as the build log itself notes. The
diff moves NEITHER: it does not add reasoning/planning (Thinking) and it does not prune or
account for volume (Self-Pruning). What it does is make two STORED interaction records present
in context so a follow-up resolves to the just-acted item — that is recall, i.e. **Memory**.
The build log's own `CAPABILITY: Memory` is the accurate label. Aim does not touch the verdict;
recorded so the next target is set from ONE source, and so the harness's self-contradictory
target line (Thinking vs Self-Pruning) is fixed before it wastes another aim.

**5. CAPABILITY ATTRIBUTION**
```
claimed:   Memory · "a follow-up seconds after an action lands on that action"; +0 claimed,
           measured only when a live turn exercises it
verdict:   SUPPORTED — with the precise caveat that the capability added is RECALL/EVIDENCE
           PROVISION (surfacing brain_prompt_queue + item_status_history into the shared
           ledger block), not new reasoning. There is a Thinking flavour in the referent-
           resolution rule, but the load-bearing change is making the record PRESENT, which
           is Memory. The "+0 claimed" is honest and unexaggerated.
reasoning: dispatchLedgerService.ts:339-346 read the two tables; :364-393 render them into the
           block both brainComposer paths consume (brainComposer.ts:2843, 3556). No authority
           moves to code; wording stays the model's; no allow-list or enumeration.
```

**6. Directive for the next build turn** — ranked, most valuable first:

1. **FIX THE BENCHMARK before any new build — this is the third turn it scored zero.**
   `iter-67-post-build.json` scored 0/12, every case failing. Until it returns a real `overall`
   and `weakestCriterion`, every SOUND verdict ships blind and no capability claim is
   falsifiable. First suspect remains the matrix env (`env -u GEMINI_API_KEY` leaving the
   judge/model path keyless); confirm the benchmark runs with working model + judge credentials
   and re-run iter-67. Orchestrator-owned; nothing else matters until it produces a number.
2. **Make the deploy atomic and clean the tree** (orchestrator): commit `deployed-sha` with its
   D-row and the stranded reviewer lines in the same step; remove/ignore the three untracked
   root files so no `git add` sweeps them.
3. **Fix the harness's self-contradictory target line** — header says Thinking, table says
   Self-Pruning. Pick one source so the Builder is not aimed at two capabilities at once.
4. **Only after the benchmark scores — attack the real widest gap, Self-Pruning (36).** DEF-293
   is Memory transparency; the 56-point gap is the pruning DECISION on the owner's inbound path
   (the noise ledger / suppression logic), with a benchmark case that actually exercises it.
5. **If continuing on referent quality (DEF-293 follow-through):** live-verify that the "most
   recent line above" rule resolves correctly across the two sub-blocks, and consider merging
   prompts + transitions into ONE time-ordered list so "most recent" is unambiguous by
   construction rather than by the model comparing timestamps.

## Iteration 73 — 2026-09-05

**LIVE STATUS FIRST.** `state/deployed-sha` reads `1d9f255` — the reviewed HEAD — so DEF-321
is running on production now. It is safe while live: a purely ADDITIVE change to the rarely-hit
WhatsApp-disconnect handler, every new branch wrapped so it cannot throw into that handler, no
existing answer removed or gated. **ROLLBACK: no** — additive fault-announcement on a cold
path, fail-safe, tenant-scoped.

**1. Verdict: `SOUND`** — DEF-321 fixes the ONE shared `alertWhatsAppDisconnect`
(`connectionWatchdog.ts:298`): it captures per-recipient failure reasons, escalates `sent===0`
to `log.error` with those reasons, and adds an always-on second delivery route through the
`brainContactsUser` chokepoint (durable audit row + WhatsApp attempt + DEF-296 email fallback)
using the pre-existing `connector_stale` DIAGNOSTIC kind, all wrapped so alert plumbing can
never take the handler down. Every build-log claim checks out against the diff, and the fix is
placed at the shared function so all four callers inherit it.

**The high-yield check cleared — genuinely closes, not re-creates,
`protection-with-two-implementations`.** `alertWhatsAppDisconnect` is the single disconnect-
alert function; its callers are `connectionWatchdog.ts:267` and `WebjsProvider.ts:1435/1463/
1585` — all route through this one function, so none is left on the old email-only path. The
two OTHER `connector_stale` senders (`connectorHealthService.ts:402`, `integrationService.ts:
218`) are connector-health, not WhatsApp-disconnect, and already use `brainContactsUser` — no
email-only sibling exists. Fix is at the chokepoint, not a third path. Verified.

**2. Claims not supported by the diff** — none. Spot-checks:
- *"kind `connector_stale` (DIAGNOSTIC_KINDS — reserved slice under DEF-308's floor, never
  crowds humans)"* — SUPPORTED. `connector_stale` is in `DIAGNOSTIC_KINDS`
  (`brainOutboundService.ts:406`); under DEF-308's floor the human reserve protects HUMAN_KINDS
  and diagnostics ride their own slice, so this alert is not dropped by the daily cap that
  silenced real work in DEF-308.
- *"A second route … always, not only on failure"* — SUPPORTED. The `brainContactsUser` block
  (`connectionWatchdog.ts:410-452`) is unconditional, outside any `if (failed)`; the test pins
  "route-fires-on-success" (`def321…test.ts`).
- *"Per-recipient failure REASONS captured (throw or false, both stated)"* — SUPPORTED
  (`:346-353`: try→`ok?null:'sendEmail returned false'`, catch→`String(e?.message).slice(0,200)`).
- *"both-routes-down is itself an error log … handler can never be taken down"* — SUPPORTED
  (`:447-451` outer catch logs `error`; no rethrow).
- **Honesty credit:** the build log CORRECTS the analyst's root-cause hypothesis ("sent over
  the dead channel") to the true one (email was the only route and the one admin email failed,
  its reason swallowed by `.catch(()=>false)`). The correction matches the pre-image and is the
  right diagnosis.

**3. Correctness and regression risks (this diff)** — all LOW; none dangerous-while-live.

- `connectionWatchdog.ts:399` — **`ORDER BY user_type, id LIMIT 1` picks `AD` before `SA`**
  (alphabetical), so the durable chokepoint notice lands in the first admin's channel history,
  which may not be the SA owner's. The build log's "the owner gets the notice in HIS own
  channel history" is only exactly true when the owner sorts first. Failure scenario: tenant
  has an AD and the SA owner; the WhatsApp-history row + push go to the AD's userId, the owner
  sees it only via the multi-recipient EMAIL route (`:309-313`, which does include the SA). LOW
  — the durable-row + second-route goal is met for *someone* and email still reaches the owner;
  a later turn could target the SA deterministically.
- `connectionWatchdog.ts:410-446` — **in the exact 09-04 incident (email transport itself
  failing), the chokepoint's DEF-296 fallback is also email**, so both delivery routes fail
  together; the only guaranteed artifact is the undelivered `brain_user_messages` row, surfaced
  when the channel is re-paired. This is honestly scoped by the build log's own falsifier ("a
  row exists"), and the row's existence — not its delivery — is the guarantee. Not a defect,
  but the owner should know delivery is NOT guaranteed when email is the failing component;
  the value is the receipt + escalated error log, not a second live channel in that case.
- `connectionWatchdog.ts:356-364` — **empty `recipients` → `sent===0` fires the "reached NO
  ONE" `log.error` with `failures: []`** even though nothing was attempted. Cosmetic; the
  chokepoint route still notifies the SA/AD from the DB. LOW.

**3b. CARRIED FINDINGS — pre-existing, not this diff**

- **THE BENCHMARK IS ALIVE AGAIN — stated affirmatively.** `iter-73-post-build.json`:
  `casesScored: 12`, `casesFailed: 0`, `overall: 92.8`, `weakestCriterion: C4 @ 87.1`, a
  populated `fixQueue`. Iterations 57/62/67 all scored 0/12; whatever restored the model+judge
  credentials (directive #1 across three reviews) worked. The loop has its only feedback signal
  back — this is the most important non-diff fact this turn.
- **The gate-blocking criteria are CONVERSATIONAL, and DEF-321 addresses none of them.** C4 @
  87.1 (the gate minimum) is a naturalness/tone nit — its worst case `B10-what-did-you-send`
  scores 80 for "'Sir' … slightly overly formal" and "clunky" phrasing. The fixQueue's worst
  is `B04-outstanding-question-ignored`: Brain ignored the user's bare "Priority high" answer
  to Brain's OWN outstanding prompt (C6=0, C5=20, C3=40 — "no recognition of this answer …
  non-sequitur"), and `B01-did-you-send` (C3=75, redundant "which message?" re-ask). These are
  DEF-293-family continuity defects, live in production, untouched by this iteration and by its
  target capability.
- **Untracked root litter, now growing** — `product_size_codex.md`, `product_size_grok.md`,
  `"Brain Evolution2.jpeg"`, plus newly untracked `server/docs/WHATSAPP_INTEGRATION_SPEC.md`
  and modified `WHATSAPP_QR_ARCHITECTURE.md`. Flagged since iteration 60; still a BLD-001
  `git add` sweep hazard. Orchestrator/docs, not Builder code.

**4. AIM: ON_TARGET (Self-Healing) — with a measurement caveat.** The diff plausibly moves
Self-Healing: it is the DETECTION-AND-ANNOUNCE half of self-healing — a dead channel now
reports its own death through an independent route with a durable receipt and an escalated
error log, instead of five hours of silence. The caveat, stated because it decides whether the
number moves: this is fault ANNOUNCEMENT, not fault RECOVERY (the channel still needs a human
QR re-pair, which the build log says plainly), AND the benchmark's C1–C8 are conversational
criteria that cannot exercise a WhatsApp disconnect — so the SCORE will not reflect this change
regardless of its merit. The score-moving surface this turn is the conversational fixQueue
(B04/B01), a different capability (continuity / Accurate Communication), not Self-Healing.

**5. CAPABILITY ATTRIBUTION**
```
claimed:   Self-Healing (the assigned target, "aligned with the analyst's #1"); +0 score claim
verdict:   SUPPORTED — as the detection/announce component of Self-Healing, with the precise
           caveat that it ANNOUNCES a fault rather than RECOVERING from it; the "+0 score claim"
           is honest and, given the benchmark cannot exercise a disconnect, correct.
reasoning: connectionWatchdog.ts:431 routes the notice through the brainContactsUser chokepoint
           that owns audit+fallback; :356-363 escalate silence to log.error; the re-pair
           remains manual (build log states it), so no auto-recovery is claimed or present.
```

**6. Directive for the next build turn** — ranked, most valuable first:

1. **The benchmark measures again and the gate minimum is C4 @ 87.1 with a concrete fixQueue —
   ATTACK THAT, not another infra capability.** Highest signal: `B04-outstanding-question-
   ignored` — Brain ignored the user's bare "Priority high" answer to Brain's OWN pending
   prompt_queue question (C6=0, C5=20, C3=40). This is the DEF-293 continuity family: wire the
   OUTSTANDING-question state (`brain_prompt_queue` unanswered rows) into the compose path so a
   short next message is first tested as the ANSWER to the open ask before anything else runs.
   Moves C3/C5/C6 together and is exactly what the gate reads.
2. **`B01-did-you-send` (C3=75): dedup the clarifier.** Brain asked "Which message were you
   asking about?" then immediately "Which message are you referring to?" in one turn — one
   clarifying question per turn; collapse duplicate clarifiers in `brainComposer`.
3. **C4 naturalness (the gate minimum itself): the "Sir"/clunky-phrasing register.** `B10`
   scored 80 purely on tone. If C4 is to clear 95, the standing register instruction needs to
   drop the reflexive "Sir" and stiff constructions — a prompt-level change, measured directly
   by C4.
4. **Orchestrator: fix the self-contradictory target line** (header "Thinking" vs table
   "Self-Pruning", still unfixed — Iteration-67 directive #3, now a 4th sighting) and **clean
   the untracked tree litter** so no `git add` sweeps it into a deploy.
5. **DEF-321 follow-through (LOW, optional):** target the SA owner deterministically for the
   chokepoint notice (`connectionWatchdog.ts:399` currently `ORDER BY user_type` picks AD
   first), so "his own channel history" is literally true.

## Iteration 73 (build 2, DEF-315) — 2026-09-06

**LIVE STATUS FIRST.** `state/deployed-sha` reads `561ce79` — the reviewed HEAD — so DEF-315
is running on production now. It is strictly SAFER than what it replaced: it removes a source
of a false denial and makes the identity fallback fail toward honesty. Nothing here is
dangerous while live. **ROLLBACK: no** — the change only ever turns a false "I don't have a
number" into an honest "I can't confirm it right now"; reverting would restore the defect.

**1. Verdict: `SOUND`** — the load-bearing change is the render fix
(`systemCapabilitiesService.ts:256-270`): the null-identity branch no longer manufactures a
WORLD-claim ("I do not currently have a WhatsApp number of my own connected") from an EMPTY
READ; it now states a fact about THE READ and forbids deriving the denial. That is the DEF-085
discipline correctly applied to the last self-fact that could blank into a denial, it is
cache-independent, it sits in the ONE renderer both live compose paths use, and it fails toward
honesty. The paired cache change is sound but its stated benefit is overstated (§2). The def299
pin update is legitimate — it retargets the exact assertion that BECAME this regression while
preserving DEF-299's real requirement (never fill silence with a guess), asserted now as the
read-fact statement.

**The high-yield renderer check cleared.** The old denial string exists nowhere else in
`server/src` except this file (now only in its explanatory comment). The other "no WhatsApp
number" hits (`delegateeFollowupWorker.ts:19`, `brainTools.ts:445`) are about a CONTACT's
number, a different fact. `renderCapabilitiesBlock` is on the live path — `brainComposer.ts:
3339` and `brainRetrievalPlanner.ts:118` — so the fix reaches production on both. No second
identity-denial renderer to leave behind.

**2. Claims not supported by the diff**

- Build log: *"a NULL own-number is never cached: identity absence heals at the NEXT read
  instead of living for the 60s TTL."* **FALSE on the primary compose path.**
  `systemCapabilitiesService.ts:225` only guards this module's OWN cache. But
  `brainComposer.ts:3331` calls it through `getOrCompute(\`caps:${clientNumber}:${userId}\`,
  120, () => getSystemCapabilities(...))` — a SECOND Redis cache layer (`redisClient.ts:67`)
  that `JSON.stringify`s the WHOLE caps object, `brainNumber:null` included, stores it for
  `EX 120`s, and returns it on hit WITHOUT recomputing. So on the main reasoning path a
  transient empty read is served stale for up to **120 seconds** — longer than the 113-second
  incident window the fix cites. The module change heals-at-next-read only for the DIRECT
  caller `brainRetrievalPlanner.ts:115`. This is the codebase's dominant
  `protection-with-two-implementations` shape, in cache form: one cache guarded, the more
  binding one (the outer 120s) untouched. **Mitigation that saves the verdict:** the render fix
  is cache-independent, so even when the stale null-identity caps is served, the model now gets
  the honest "cannot confirm" statement, never the false denial — the user-facing HARM is fixed
  everywhere; only the "fresh number appears immediately" property fails on this path.
- The new `def315` suite tests the module cache guard "through the REAL getSystemCapabilities"
  — which is real — but nothing exercises the `brainComposer` outer `getOrCompute`, so the
  green suite does NOT validate the end-to-end heal the build log claims. Stated so the next
  reader does not read 4/4 green as proof of the primary-path behaviour.

**3. Correctness and regression risks (this diff)** — none dangerous-while-live.

- `systemCapabilitiesService.ts:225` — **the cache guard `brainNumber !== null` does not match
  the renderer's own condition `if (wa.brainNumber)` (`:252`).** `brainNumber` is normalised
  `?? null` at `:204`, so the normal domain is {truthy string, null} and the guard is fine —
  BUT if `connected_number` is ever the empty string during a number change (`'' ?? null` stays
  `''`), then `'' !== null` is TRUE → the module caches the empty read, while the renderer
  (`if ('')` is falsy) shows the fallback: the exact DEF-315 mechanism for the empty-string
  variant. LOW — it requires a literal `''`/whitespace DB value, and the render fix + the outer
  cache dominate anyway. The self-consistent guard is `if (caps.waIdentity.brainNumber)`.
  MEDIUM only in combination with the untouched outer cache above; on its own, LOW.

**3b. CARRIED FINDINGS — pre-existing, not this diff**

- **The real structural fix is event-driven invalidation, and it is absent.** The incident
  happened, and the outer 120s cache still serves stale identity, because nothing invalidates
  `caps:<tenant>:<user>` when the tenant's number CHANGES. `invalidate()` already exists
  (`redisClient.ts:90`, supports the exact key). Calling it on the number-change event would
  heal BOTH cache layers instantly and is strictly better than "don't cache null," which only
  touches the inner layer. Pre-existing; already live. The diff neither introduced nor worsened
  it — but it is why the shipped fix is partial.
- **Untracked root litter, unchanged** — `product_size_codex.md`, `product_size_grok.md`,
  `"Brain Evolution2.jpeg"`, untracked `server/docs/WHATSAPP_INTEGRATION_SPEC.md`, modified
  `WHATSAPP_QR_ARCHITECTURE.md`. Flagged since iteration 60; still a BLD-001 `git add` sweep
  hazard. Orchestrator/docs, not Builder code.
- **`deployed-sha` churn** — the build log flags it read `1d9f255` while prod HEAD was
  `e0053d8`; it now reads `561ce79` (this HEAD). The orchestrator moved it, consistent with
  reviewing live code — noted so the "corrupt state file" thread the last three build turns
  raised is not read as still-open here. Orchestrator-owned.

**4. AIM: MISAIMED** (relative to the Learn target). The diff moves **Accurate Communication /
self-knowledge** — it removes a fabricated identity denial — not Learn. There is no learning,
preference-adaptation, or feedback-incorporation mechanism anywhere in the diff. And it polishes
the ALREADY-STRONGEST capability: Accurate Communication is 91 against 94, the narrowest gap on
the card (3 points), while the widest gaps (Self-Pruning 36, Thinking 42, Learn 48) are
untouched. The build log honestly declares `CAPABILITY: Accurate Communication` — so the
attribution is right; it is the AIM against the assigned target that is off. Aim does not touch
the verdict; recorded so the next turn is pointed at a wide gap the benchmark actually reads.

**5. CAPABILITY ATTRIBUTION**
```
claimed:   Accurate Communication — "the false sentence becomes unreachable from an empty read
           on every path rendering this block"; no score claim
verdict:   SUPPORTED — the render change removes a false WORLD-claim source and replaces it with
           a statement about the read that cannot be false; that is squarely anti-fabrication /
           Accurate Communication, and "no score claim" is honest. One scope correction: "on
           every path" is true for the RENDER (which is what prevents the false answer) but NOT
           for the cache heal (§2). The capability label is right; the coverage claim is the
           overstated part.
reasoning: systemCapabilitiesService.ts:256-270 (render, live via brainComposer.ts:3339 +
           brainRetrievalPlanner.ts:118); the cache guard at :225 is bypassed by the outer
           getOrCompute at brainComposer.ts:3331.
```

**6. Directive for the next build turn** — ranked, most valuable first:

1. **The gate minimum is C4 @ 87.5 and the ENTIRE fixQueue is conversational — attack it, not
   another identity edge case.** C4 (naturalness) sits at 85-90 across nearly every case
   (`B02, B06, B07, B08, B09, B10, B11` …), the single most repeated drag on the gate. The
   sharpest individual failures are `B08-bad-news` (C6=75 — delivering bad news), `B12-reminder-
   referent` (C4=80, C1=85), `B07-compound-ask` (C5=80 — handling a multi-part instruction), and
   `B05-warmth` (C6=80). The highest-leverage single change is the standing register itself —
   the reflexive "Sir"/formality and clunky phrasing the C4 judge keeps citing — because it
   moves C4 across every case at once. This is measured directly by the benchmark, unlike the
   identity edge case just shipped.
2. **Finish DEF-315 structurally** (`redisClient.ts:90` + the number-change event): invalidate
   `caps:<clientNumber>:<userId>` when the tenant number changes, so BOTH cache layers heal
   instantly; and align the module guard to the renderer's truthiness
   (`if (caps.waIdentity.brainNumber)` at `systemCapabilitiesService.ts:225`). The shipped fix
   stops the false denial but leaves the fresh number invisible for up to 120s on the compose
   path.
3. **Orchestrator: fix the target-line contradiction** (header "Learn" vs table "Self-Pruning",
   now a FOURTH sighting) and **clean the untracked tree litter** before a `git add` sweeps it.

## Iteration 73 (build 3, DEF-311) — 2026-09-07

**LIVE RISK, FIRST.** `deployed-sha` = `2e243a4` (reviewed HEAD), so this is running now.
The dangerous fact this turn is NOT in the diff — it is in the measurement: case
`B04-outstanding-question-ignored` scored **0 on six criteria** (C1/C2/C3/C5/C6/C7). Brain,
asked to set a priority the owner had just supplied for an outstanding question, replied
*"Updated 'Obtain data access for Satori project': priority=high"* — a task the judge says
"was not provided in the current or previous turns," and it "reported a false success." **A
live path on which Brain applies the owner's instruction to the WRONG item and claims it did
it** is owner risk of the highest kind (wrong-action + fabricated completion). It is pre-
existing and unfixed (see §3b) — the diff did not cause it and does not fix it. **ROLLBACK:
no** — the diff itself is a scoped, correct addition; rolling it back removes a valid DEF-311
fix and does nothing for B04.

**1. Verdict: `SOUND`** — the change is correctly constructed and correctly aimed at its
declared defect. It reads a THIRD referent record (`brain_user_messages`, the DEF-108
chokepoint's audit table) tenant-scoped, capped, with the deferred `Promise.resolve().then().
catch(()=>null)` DEF-274 guard; renders it as its OWN labelled section so DEF-313's item-
referent invariant is untouched and the "never answer from here" background block is not
polluted; holds DEF-085 across all three sources; and it fixes a REAL latent bug in passing —
the unreadable-count branch was hardcoded `=== 2` and would have mis-rendered the moment a
third record joined, now generic `>= 2` naming whichever failed (`dispatchLedgerService.ts:
650`). The def293 suite was extended, not weakened: the mock asserts `(clientNumber, userId)`
scope and the `kind != brain_prompt` exclusion on every read, and the "neither" assertion was
updated with reasoning to the generic wording. No benchmark or forbidden path touched.

**I considered WEAK and rejected it, transparently** — because the measured regression cannot
be pinned on this diff: B04 OSCILLATES (0 two iterations ago → ~90 last iteration untouched →
0 now), so its failure is not evidence the diff worsened it; the new "newest-wins" rule is
SCOPED to *"what is this?"* questions (`dispatchLedgerService.ts:684`) while B04 is a bare
answer ("Priority high"), so that rule does not even fire on B04; and the ~5-point overall
drop (93.7 → 88.4) sits inside the judge-variance band already observed across three builds
(92.8 / 93.7 / 88.4). Ruling WEAK would force a ~$60-capped remediation on soundly-built,
correctly-aimed work for an unproven regression on a case the change did not target — exactly
the misfire the scoping rule exists to prevent.

**2. Claims not supported by the diff** — none material. The build log's technical claims all
hold against the tree (third read scoped/capped/deferred; separate section; `brain_prompt` the
lone exclusion; generic unreadable wording). The one honest gap is not a false claim but an
untested surface: the build log's "PREDICTED: 'what is this?' lands on the message he actually
received" is **not measured** — no benchmark case exercises a "what is this?" turn against a
just-sent draft-ask, so the fix's own falsifier is unverified and the suite's green does not
speak to it. Stated per the contract.

**3. Correctness and regression risks (this diff)** — all LOW.

- `dispatchLedgerService.ts:668-688` — **the "MESSAGES YOU SENT HIM" section renders on EVERY
  compose turn**, not only on message questions, adding a third record block + a multi-line
  referent rule to the always-on ledger the primary path injects (`brainComposer.ts:3339`).
  This is the same block that has grown across DEF-293/301/306/313 and now DEF-311. No
  correctness bug, but it is a real prompt-bloat surface, and this iteration's broad drop
  across C1/C2/C5/C6/C7 (−5 to −9 each) is CONSISTENT with (not proof of) the enlarged block
  crowding the conversation. Worth a measured with/without check (§6).
- `dispatchLedgerService.ts:684` — **the newest-wins referent rule** ("the referent is the
  NEWEST line across this section and the prompts above — never an older message when a newer
  one exists") is a strong directive. Scoped to "what is this?" so it does not explain B04, but
  it is the kind of rule that, on a genuine follow-up where the owner means an OLDER item, can
  push the model to the newest line. LOW and scoped, but the next referent turn should watch
  that it does not become a `guard-destroys-the-answer` for deliberately-older referents.

**3b. CARRIED FINDINGS — pre-existing, not this diff**

- **`B04-outstanding-question-ignored` — LIVE, unfixed for three iterations, and the loop's own
  standing directive #1.** The owner answers Brain's outstanding question with a bare value
  ("Priority high"); Brain binds it to the WRONG item and reports false success. It failed at
  C6=0 two iterations ago, recovered to ~90 last iteration on its own, and is back to 0 across
  six criteria now. The block keeps gaining referent DATA while the actual failure — BINDING a
  bare answer to the outstanding prompt rather than picking a distractor — is never addressed.
  Already live in production (`git show <deployed-sha>` of the compose path shows no
  outstanding-answer binding). This is the single most valuable thing to fix and it is NOT a
  ledger-rendering problem.
- **The benchmark is judge-variant.** Across three builds the overall has read 92.8 / 93.7 /
  88.4 with the same 12 cases; the gate-min criterion has jumped C4 → C4 → C6. Individual
  cases swing 90 → 0. The loop should treat single-run deltas under ~5 points as noise and read
  the CASE TEXT (as here), not the aggregate — the aggregate alone would have mis-attributed
  this turn.
- **Untracked root litter, unchanged** — `product_size_codex.md`, `product_size_grok.md`,
  `"Brain Evolution2.jpeg"`, untracked `WHATSAPP_INTEGRATION_SPEC.md`, modified
  `WHATSAPP_QR_ARCHITECTURE.md`. BLD-001 `git add` hazard, flagged since iteration 60.
  Orchestrator/docs.

**4. AIM: ON_TARGET** (Self Follow-Up). The diff surfaces Brain's OWN recently-sent outbound —
the delivery record of what it has said and is awaiting a reply to — as first-class referents,
which is squarely the Self Follow-Up capability (knowing what you have outstanding with the
owner). It is on a path the owner reaches (the ledger block both compose paths render). The
caveat is measurement, not aim: the deployed evaluation got WORSE on the conversational
criteria this run, so no capability GAIN can be asserted from the code — only that the code
plausibly targets Self Follow-Up.

**5. CAPABILITY ATTRIBUTION**
```
claimed:   Self Follow-Up — "what Brain sent and is awaiting is now in its own view"; no score
           claim
verdict:   SUPPORTED — the sends section genuinely brings Brain's own recent outbound (the
           chokepoint delivery record) into the model's view as follow-up referents, which is
           Self Follow-Up; "no score claim" is honest and, given the measured regression,
           correct to have withheld. Caveat recorded: the code supports the capability, the
           deployed measurement fell, so the change may be net-neutral-to-negative until the
           B04-family binding is fixed.
reasoning: dispatchLedgerService.ts:668-688 (sends read + MESSAGES YOU SENT HIM section),
           live via the block brainComposer.ts:3339 and brainRetrievalPlanner.ts:118 render.
```

**6. Directive for the next build turn** — ranked, most valuable first:

1. **STOP enriching the ledger block; FIX B04's binding mechanism — file it as its own DEF.**
   Three iterations of referent DATA (DEF-293/301/306/313/311) on the same block have not
   fixed the owner answering an outstanding question. The fix is BINDING, not more data: in the
   compose path, when the owner's incoming message is a bare answer (a short value/label with
   no new subject) AND an unanswered `brainPromptQueue` prompt exists, resolve that answer to
   THAT prompt's item authoritatively — do not let the model select a newer or ungrounded
   ledger line, and never emit an "Updated X" for an item the turn did not name. Add the exact
   B04 shape (outstanding question about item A, owner replies "Priority high", assert Brain
   acts on A and not on a distractor) to the def293 suite so it is regression-locked.
2. **Test the prompt-bloat hypothesis before adding anything else to this block.** Run the
   benchmark with the DEF-311 sends section gated to render only when the turn plausibly asks
   about a message, vs always-on. If C1/C2/C5/C6/C7 recover, gate it. The block is now the
   largest always-on section on the compose path.
3. **C6 is the gate minimum at 81.7 — its failures beyond B04 are the same family:**
   `B07-compound-ask` (C6=50 — dropping part of a multi-part instruction) and `B03/B06`
   (C6=80). C6 is "act on ALL of what the owner actually said, grounded in the conversation";
   B04 and B07 are one problem — instruction-grounding — not two.
4. **Orchestrator:** fix the target-line contradiction (header "Self Follow-Up" vs table
   "Self-Pruning", fifth sighting) and clean the untracked tree litter.

## Iteration 76 — 2026-09-08

**LEAD — the procedural risk that matters most this turn.** This range is 100% orchestrator-
owned (scorer prompt, score schema, one orchestrator test, docs) and contains ZERO Brain code.
But a `SOUND` verdict ships branch HEAD (`6d8f39b`) to production via `deploy.sh:137`, and
between the deployed SHA `2e243a4` and this range's base `36d7a45` sit **13 commits, 5 of them
touching `server/src`** — `DEF-322` (`a1031e2`, a MESSAGING-PATH fix: RFC-2822 7-bit subject),
`PRUNE-001` (`e00d959`, 3 files), `LEARN-001` (`f3c357c`), `LEARN-002` (`d8ef6b4`, 2 files),
`OPS-001` (`620cbda`) — **none of which appear in `review_log.md`** (no iteration-74/75 review
sections exist). So D-105, riding a SOUND on two orchestrator commits, would carry un-reviewed
Brain code — including a messaging-path change — to the owner's production. That is the loop's
sequencing to fix, not the Builder's, but it is the single most important thing on this turn.

**ROLLBACK: no** — the two reviewed commits are correct and are not even deployed (`deployed-sha`
is `2e243a4`, below this range); there is nothing Brain-facing to unwind here. The rollback
question that matters is about the un-reviewed wave above, and that is a review-before-D-105
question, not a revert.

**1. Verdict: `SOUND`** — both commits in `36d7a45..6d8f39b` are orchestrator machinery and both
are correct: `DEF-323` fixes a real gate defect without blinding the guard, and `BLD-019`
reconciles the scorer with a documented owner decision without moving any capability number.
I verified the tree is green (§ below). **Scope: this SOUND clears these two commits ONLY; it is
not a review of the DEF-322/PRUNE/LEARN/OPS wave below the base and must not be read as one.**

**Judged in its own section, because it is all orchestrator-owned:**
- `DEF-323` (`6d8f39b`, `orchestratorPulseRoute.test.ts:220`): the mean-rounding guard used
  `toBeCloseTo(x, 2)`, which passes only on `|diff| < 0.005`. An eight-capability mean landing
  exactly on `.xx5` (55.125 → banker's-round 55.12) is off by exactly `0.005`, so the guard
  fired on the CORRECT two-decimal rounding it exists to permit. The fix — `|diff| <= 0.005 +
  1e-9` (and `2×` for the gap, which compounds two half-roundings) — is boundary-inclusive by
  one ULP and **preserves the kill**: a genuine one-decimal slip (≥ 0.045) still dies. This is a
  dashboard-route contract test, not benchmark/judge/gate arithmetic. Legitimate.
- `BLD-019` (`f714d77`, `score.md` + `score-schema.json`): flips the scorer from nine
  capabilities to eight. **This is NOT a score-motivated edit** — it completes the documented
  2026-08-31 owner merge of *Simple & Smart* INTO *Self-Pruning* (`brain_evaluation_chart.md`
  D-78/D-79, commit `2be5478`, "nine become eight everywhere the machinery reads them"). The
  runtime `capability_scorecard.json` ALREADY holds exactly eight capabilities with the same
  numbers this review's own target table uses (Self-Pruning 36/92, etc.); the schema
  (`minItems/maxItems: 9`) and scorer prompt were the lagging copies that would REJECT a valid
  eight-item card at the ingest gate. It changes no capability's score — it stops the gate
  rejecting truthful output. Legitimate reconciliation.

**2. Claims not supported by the diff**

- Header vs tree: the review header reports tests **RED (1 failed)** with `3576 passed`; the
  build log claims **3556 passed | 0 failed**. **The build log is right and the header is
  stale.** I re-ran the full suite at HEAD: `Test Files 303 passed | 1 skipped`, `Tests 3556
  passed | 7 expected fail | 21 skipped | 1 todo (3585)` — 0 failed, matching the build log
  exactly. The changed test file alone passes 8/8. The header's RED was measured before
  `6d8f39b` (the DEF-323 fix) landed — i.e. at `f714d77`, where the guard was still firing.
  Stated so the loop does not treat HEAD as red.
- Everything else in the build log checks out against the diff (boundary-inclusive tolerance,
  kill preserved, eight-capability reconciliation, no migration in range).

**3. Correctness and regression risks (this diff)** — none. The range touches no Brain path, no
runtime behaviour, no `server/src`. `DEF-323`'s tolerance widening is bounded to one ULP at the
two-decimal boundary and cannot mask the one-decimal error class it hunts. Benchmark-integrity:
the in-repo benchmark files (`nexeoCapabilityBenchmark.ts`, `brainResponseEvaluator.ts`,
`calibrateResponseJudge.ts`) are untouched; the scorer edit is the capability-card machinery and
is a legitimate reconciliation as shown above. Forbidden paths: none in the diff or tree.

**3b. CARRIED FINDINGS — pre-existing, not this diff**

- **Five un-reviewed Brain commits in HEAD** (DEF-322, PRUNE-001, LEARN-001/002, OPS-001) — see
  the LEAD. DEF-322 is a messaging-path change; all are undeployed (above `deployed-sha`) and
  absent from `review_log.md`. They must be reviewed before D-105 ships them.
- **`B04` binding defect — still live, still directive #1.** The owner answers an outstanding
  `brainPromptQueue` prompt with a bare value and Brain binds it to the wrong/ungrounded item
  and reports false success. Untouched this turn (a gate-fix mandate). The build log itself names
  it "next build's first job." Live in the deployed `2e243a4`.
- **The benchmark aggregate is noise-dominated at this scale.** The DEPLOYED system is unchanged
  (`2e243a4`, DEF-311), yet its overall went **88.4 → 94** across consecutive runs and C6 jumped
  **81.7 → 88.3** with zero code change. Confirms last turn's finding: read case text, not the
  aggregate; a single-run delta under ~6 points is variance. `casesFailed: 0` this run.
- **Untracked root litter** — `product_size_codex.md`, `product_size_grok.md`, `"Brain
  Evolution2.jpeg"`, untracked `WHATSAPP_INTEGRATION_SPEC.md`, modified `WHATSAPP_QR_
  ARCHITECTURE.md`. BLD-001 hazard, flagged since iteration 60.

**4. AIM: UNVERIFIABLE** — by design. The diff is orchestrator scoring/test machinery; it cannot
be tied to any Brain capability from the code, moves no path the owner reaches, and the build log
correctly declares `RELIABILITY-ONLY (+0)`. This was a mandate gate-fix turn, not a Self-Pruning
build, so there is no on/off-target to report — the target (Self-Pruning) was explicitly
suspended by the mandate and carried forward untouched, which the build log states.

**5. CAPABILITY ATTRIBUTION**
```
claimed:   RELIABILITY-ONLY (+0) — "the release gate stops being red on a correct rounding"
verdict:   RELIABILITY-ONLY (correct) — affirmed. Both commits are gate/scorer machinery; no
           Brain runtime path is touched (0 server/src files in range); no capability moved and
           none is claimed. The +0 is honest.
reasoning: orchestratorPulseRoute.test.ts:220 (contract test) and scripts/orchestrator/{score.md,
           score-schema.json} (capability-card scorer) — none reachable from compose or send.
```

**6. Directive for the next build turn** — ranked, most valuable first:

1. **Before D-105 ships HEAD, route the un-reviewed Brain commits through review** — DEF-322
   (messaging path), PRUNE-001, LEARN-001/002, OPS-001 sit undeployed and unreviewed between
   `2e243a4` and HEAD; `deploy.sh` ships HEAD wholesale. Either give each its review turn or
   confirm prior review exists; do not let a gate-fix SOUND be the thing that ships a messaging-
   path change unreviewed.
2. **The B04 binding fix** (standing directive #1, three iterations): when the incoming message
   is a bare answer and an unanswered `brainPromptQueue` prompt exists, bind it to THAT prompt's
   item authoritatively — never select a newer/ungrounded ledger line, never emit "Updated X"
   for an item the turn did not name. Regression-lock the B04 shape in the def293 suite.
3. **The DEF-311 gating experiment** (directive #2 last turn): measure the benchmark with the
   always-on "MESSAGES YOU SENT HIM" sends section gated to message-questions vs always-on; gate
   it if C1/C2/C5/C6/C7 recover. The block is the largest always-on section on the compose path.
4. **Orchestrator:** the target-line contradiction is resolved this turn (header, table, and
   scorecard all agree on eight capabilities with Self-Pruning the target) — good; now clean the
   untracked tree litter so a `git add` cannot sweep it into D-105.

## Iteration 76 (build, DEF-327) — 2026-09-09

**LIVE STATUS.** `deployed-sha` is `788218d` (DEF-326), BELOW this range's base — so DEF-327 is
**not deployed**; the "reviewing live code" framing does not apply to it. Nothing here is
dangerous. **ROLLBACK: no** — it is undeployed, opt-in (switch defaults 0), fail-safe (held,
never dropped), and correctly scoped.

**1. Verdict: `SOUND`** — DEF-327 moves the one-per-day rollup from `digestPolicy.decideDigest`
(reached only by `enqueueBrainPrompt`) to `brainContactsUser` (the DEF-108 chokepoint every
producer passes), scoped to `HOUSEKEEPING_KINDS`, held via `record()` + the DEF-277 digest as
the single daily receipt, gated on the existing opt-in switch. It is the structural fix its
diagnosis calls for, it is not `protection-with-two-implementations` (verified below), it does
not touch the dangerous paths, and its tests are thorough and green.

**The high-yield checks, all cleared:**
- **Not `protection-with-two-implementations`.** The build log claims "moved, not copied." The
  `digestPolicy.ts` diff CONFIRMS it — the entire 76-line daily-rollup block is DELETED and
  replaced by a comment; only the per-ITEM digest (which needs item identity) remains. There is
  now exactly one daily-rollup implementation, at the chokepoint. Verified.
- **Correct scoping — the DEF-156 "dropped 9/10 real messages" danger is avoided.**
  `HOUSEKEEPING_KINDS = {open_item_draft_ask, brain_prompt, open_item_overdue}`
  (`brainOutboundService.ts:425`). `HUMAN_KINDS = {wa_counterpart_message}` and `day_brief` are
  NOT in it, and the gate also excludes `urgency high|emergency` and `bypassRateLimit`. So human
  messages, the day brief, escalations and diagnostics never hit the rollup — verified against
  the set, and pinned by the "Hamna" human-message and switch-off tests.
- **DEF-108 honesty preserved.** The hold writes `record({status:'suppressed', suppressReason:
  'daily_rollup'})`; the dispatch ledger records ONLY `sent|partial|failed`
  (`def108DispatchLedgerFed.test.ts`), so a held rollup message is correctly absent from the
  "did you send X?" ledger while remaining retrievable in `brain_user_messages`. No
  fabricated-status.
- **Placement is above the tier loop, below opt-in.** The opt-in suppression runs first, so the
  rollup never overrides opt-out; the gate then supersedes the housekeeping tier budget when the
  switch is on (a stricter cadence, no protection lost). No `guard-below-early-return` issue.

**2. Claims not supported by the diff**

- Header vs tree, THIRD time: the header reports tests **RED (1 failed, 3589 passed)**; the build
  log claims **3569 passed | 0 failed**. **The build log is right.** I re-ran the full suite at
  HEAD: `Test Files 305 passed | 1 skipped`, `Tests 3569 passed | 7 expected fail | 21 skipped |
  1 todo (3598)` — 0 failed, exactly the build log's numbers. The header's RED was measured
  before the final commit landed. This stale-RED-header pattern has now recurred three
  consecutive review turns and the orchestrator should fix the ordering (measure the header
  AFTER the reviewed commit), because a reviewer trusting it would raise a false incident.
- Every substantive build-log claim holds: the block is moved-not-copied, scoped to
  HOUSEKEEPING, held-not-dropped, opt-in, and the def108 pin re-anchor is legitimate — it moves
  the search anchor from `indexOf('DEF-108')` (which the new rollup comment now precedes) to the
  ledger block's own comment, with every assertion unchanged. Not a weakening.

**3. Correctness and regression risks (this diff)** — none material. One watch item:

- `brainOutboundService.ts:425` — **`brain_prompt` is in `HOUSEKEEPING_KINDS`**, so when the
  rollup switch is on, Brain's own QUESTIONS to the owner are also held into the once-daily
  digest rather than asked when generated. This is the opt-in behaviour the owner requested and
  the `brainPromptQueue` row is still created (so DEF-293/311 outstanding-question tracking is
  intact), but it interacts with the unfixed B04 family: a question surfaced only inside a daily
  "here's what I held" digest is one the owner is more likely to answer ambiguously. Not a
  defect this diff introduces — a watch item for whoever finally fixes B04. LOW.
- **The cost path this diff routes into was ALREADY hardened** — noted affirmatively, not as a
  finding: DEF-327 sends the 289/day `open_item_draft_ask` producer through
  `maybeSendSuppressionDigest`, which in iteration 62 I flagged for an LLM-call-per-hold. That is
  now fixed — `brainOutboundService.ts:1305-1315` short-circuits at an `alreadySent` check BEFORE
  the `callLLM`, and the dedupKey is constant over a rolling 24h window (both credited in-code to
  "Codex iteration-62 §3"). So the loud producer costs ~1 compose call per window, not 289. The
  loop acted on the prior directive; the routing is safe because of it.

**3b. CARRIED FINDINGS — pre-existing, not this diff**

- **`B04-outstanding-question-ignored` is STILL the top fixQueue item (C6=75), unfixed across
  five review turns.** The gate minimum is C4 @ 87.9 and the whole fixQueue is conversational
  (B04, B06-just-do-it, B01-did-you-send, B07-compound-ask). None of the capability-rotation
  builds (Self-Pruning rollup here, Self-Healing disconnect, identity) touch it, because it is
  Accurate Communication / instruction-grounding and keeps being ruled "off the current
  capability." Live in the deployed system. **This is the structural tension worth escalating:
  the capability-card rotation and the benchmark gate are pulling the builder in different
  directions, and the gate has not moved because the rotation never targets what it measures.**
- **DEF-327 is undeployed and rides a wave above `deployed-sha`** (`788218d`). The base `d604ebe`
  (CL-058 + the DEF-325-era rollup) sits between deployed and HEAD; its `digestPolicy` block is
  SUPERSEDED by this commit's deletion, so a deploy of HEAD nets to the reviewed version. Lower
  risk than iteration 76's five-commit wave, but the same "SOUND ships HEAD wholesale" mechanic
  applies — confirm the intervening commits are reviewed before D-107.
- **Untracked root litter** — `product_size_*.md`, `"Brain Evolution2.jpeg"`, untracked
  `WHATSAPP_INTEGRATION_SPEC.md`, modified `WHATSAPP_QR_ARCHITECTURE.md`. BLD-001 hazard, flagged
  since iteration 60.

**4. AIM: ON_TARGET** (Self-Pruning). The diff plausibly moves Self-Pruning on a path the owner
reaches: it withdraws the loudest producer's 289 draft-asks/day into one daily digest at the
chokepoint every producer passes, opt-in, held-not-dropped with a receipt — which is the
definition of the capability (manage volume AND account for it). The caveat is measurement: the
benchmark's C1–C8 are conversational and cannot exercise a daily email rollup, so the score will
not reflect this — only a live day settles it, which the build log honestly states ("no score
claim until a live day").

**5. CAPABILITY ATTRIBUTION**
```
claimed:   Self-Pruning — "the loud producer's noise withdraws into one daily digest without
           being asked"; no score claim until a live day
verdict:   SUPPORTED — the rollup at brainContactsUser genuinely reduces the loud producer's
           volume to one daily receipt, held-not-dropped, opt-in; that is Self-Pruning, not a
           reliability dressing. "No score claim" is honest and correct given the benchmark
           cannot exercise it.
reasoning: brainOutboundService.ts:434-484 (rollup gate, HOUSEKEEPING-scoped, record() +
           maybeSendSuppressionDigest receipt); digestPolicy.ts block deleted (single
           implementation); the switch defaults 0 so no cadence changes without opt-in.
```

**6. Directive for the next build turn** — ranked, most valuable first:

1. **Escalate the rotation-vs-gate tension, then fix B04.** The gate minimum (C4 @ 87.9) has not
   cleared 95 for five turns because the capability rotation keeps building surfaces the
   benchmark cannot measure (email rollup, disconnect alert) while the benchmark's actual
   blockers are conversational (B04 outstanding-question binding, B07 compound-ask, B06
   just-do-it). Either point the rotation at Accurate Communication until the gate clears, or
   accept the gate will not move. Then do the B04 binding fix: incoming bare answer + an
   unanswered `brainPromptQueue` prompt ⇒ bind to THAT item authoritatively; regression-lock the
   B04 shape.
2. **DEF-324** (the build log's named next item): the `[brain_prompt]` kind-tag leaking into the
   email subject — a Communicates defect, cheap, and directly owner-visible.
3. **Live-verify DEF-327** once a real day runs with the switch on: exactly one rollup email,
   `open_item_draft_ask` SENT → 0, humans/day-brief/escalations still immediate.
4. **Orchestrator:** fix the stale-RED-header timing (measure after the reviewed commit) and
   clean the untracked tree litter before D-107.
