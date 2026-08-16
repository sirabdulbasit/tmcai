# CONTRACT · DEF-185 — apply-outcome persistence routes through `brainPromptQueueService`

**Status: RE-FROZEN 2026-08-16 (v7).** v1 (`92077f7`) was reviewed **WRONG /
BLOCKED**: the direction was confirmed correct, the contract was not buildable.
All eight findings are resolved below, one with a documented dissent (§12).
No implementation exists yet; this document is the thing under review.

| field | value |
|---|---|
| DEF id | **DEF-185** (next after DEF-184) |
| Contract base SHA | `13e0dfb` — `feat/nexeo-one-brain` after the chunk-1 merge |
| Defect introduced at | `77471718e1b9d9757059bfc7f618730224776c35` (DEF-180) |
| Deployed? | **NO.** `7747171` is not an ancestor of `e356d42`; production is unaffected |
| Chosen repair | **Option 2** — route apply-outcome persistence through `brainPromptQueueService` |
| Symptom tag | `protection-with-two-implementations` (§3). A refinement tag is proposed in §9 for the owner to accept or fold |

## 1 · The defect, as established

`tests/promptReplyRelevance.test.ts` mocks at the **queue-service seam**: its
`arm()` helper `vi.doMock`s `brainPromptQueueService`, supplying a fake awaiting
row (`id: 42n`, `userId: 2`, `clientNumber: 'TMC-0001'`) and `recordAnswer` as a
stub. Before DEF-180 every persistence operation on the reply path went through
that service, so the test never touched a database.

DEF-180 added `applySideEffectRecorded`, called unconditionally at
`promptReplyHandler.ts:257`, which reaches the **prisma singleton directly** —
past the seam the test mocks.

```
PrismaClientInitializationError: Environment variable not found: DATABASE_URL
  → readPromptRow            promptReplyHandler.ts:351
  → applySideEffectRecorded  promptReplyHandler.ts:417
  → handlePromptReply        promptReplyHandler.ts:257
  → tests/promptReplyRelevance.test.ts:128
```

One of eleven tests in the file fails, because only that one takes the
*relevant → consumed* branch reaching step 2. Its assertions never execute.

**It fails closed by accident, not by design.** `DATABASE_URL` is absent from the
ambient environment and nothing on this path imports `dotenv`. Exported — a
developer shell, a CI job with env, any script sourcing `server/.env`, where the
variable **is** present — the same test executes `findFirst` and then
`writeSideEffectRecord` → `prisma.brainPromptQueue.updateMany`, **a write**,
against production identifiers (`id 42`, `userId 2`, `TMC-0001`). Whether that
write lands depends on whether row 42 exists in state `answered`, which was
deliberately **not** tested — establishing it would have required running the
suite against a real database.

## 2 · Decision — Option 2, and why the other two were rejected

**Chosen: move the queue-table persistence into `brainPromptQueueService`,** so
`promptReplyHandler` reaches `brain_prompt_queue` only through the service that
owns it. The existing seam then covers the new path and the first ten tests
regain their meaning.

| option | rejected because |
|---|---|
| 1 · mock the prisma singleton in the test | Ratifies that the messaging path writes through two layers and that every future test must know about both. It makes the symptom green while leaving the seam broken — the shape this project keeps paying for. |
| 3 · inject the client into `applySideEffectRecorded` | Most testable in isolation, but the widest blast radius, and it still leaves two places that know how to write the queue table. |

**Accepted cost, stated:** this edits a protocol Codex reviewed as SOUND on its
own terms (DEF-180). The protocol's *semantics* are preserved (§4); only the
layer that executes them moves. That is a deliberate change to reviewed code and
is why this contract exists rather than a patch.

## 3 · Scope — by table ownership, not by file

**IN SCOPE — the six `brain_prompt_queue` call sites in `promptReplyHandler.ts`:**

| line | call | owning function |
|---|---|---|
| 351 | `prisma.brainPromptQueue.findFirst` | `readPromptRow` |
| 377 | `prisma.brainPromptQueue.findFirst` | `writeSideEffectRecord` |
| 383 | `prisma.brainPromptQueue.updateMany` | `writeSideEffectRecord` |
| 535 | `prisma.brainPromptQueue.findMany` | `retryFailedPromptSideEffects` |
| 544 | `prisma.brainPromptQueue.findMany` | `retryFailedPromptSideEffects` |
| 556 | `prisma.brainPromptQueue.findMany` | `retryFailedPromptSideEffects` |

**EXPLICITLY OUT OF SCOPE — the six `open_item` call sites** (lines 158, 683,
693, 720, 771, 822). `brainPromptQueueService` does not own `open_item`; moving
them there would trade one layering violation for another. They remain direct
and are recorded here so the boundary is deliberate rather than overlooked. If
they need the same treatment it is a separate contract against the open-item
service.

**Also out of scope:** the DEF-180 protocol's semantics, the CAS in
`recordAnswer`, the relevance gate, and the 41-script artifact split.

## 4 · Invariants that must survive — each already paid for

The implementation must preserve all of these, and the reviewer should treat any
regression as release-blocking:

1. **Tenant + user scoping on every query (DEF-176/178).** Every moved call
   carries `userId` **and** `clientNumber`. A service signature that lets a
   caller omit either is a defect, not a convenience.
2. **CLAIM is exactly-once (DEF-178).** `recordAnswer`'s CAS must still transition
   exactly one row. Moving the APPLY leg must not widen it.
3. **APPLY is observable before it runs (DEF-180).** `{phase:'applying', attempts}`
   is stamped **before** the side effect executes, so an interruption between
   apply and outcome stays visible rather than silent.
4. **Retry cannot double-mutate (DEF-180).** An `applied` outcome refuses replay;
   a `failed` outcome is retryable by the governor sweep. The `expectSeq` CAS on
   the outcome record is part of this and must move intact.
5. **Metadata is not clobbered.** The existing read-then-merge of `metadata`
   must not become a blind overwrite of unrelated keys. The read and the merge
   must stay coupled to the **same sequence predicate** — relocating both
   statements across a layer does not by itself prove against a lost update.

### 4.6 · The behavioural cases that falsify them (AC-5)

"A named assertion exists" can pass with a weak or irrelevant assertion, so the
following cases are required by name. Each must fail if its invariant is broken:

| # | case | falsifies |
|---|---|---|
| B-1 | every read **and** every write rejects a mismatched `clientNumber`, with `userId` correct | §4.1 |
| B-2 | every read **and** every write rejects a mismatched `userId`, with `clientNumber` correct | §4.1 |
| B-3 | the `applying` stamp is persisted **before** the side effect is invoked (assert ordering, not just presence) | §4.3 |
| B-4 | a lost `expectSeq` CAS invokes **no** side effect | §4.4 |
| B-5 | an already-`applied` record invokes **no** side effect on replay | §4.4 |
| B-6 | a `failed` record remains retryable by the governor sweep | §4.4 |
| B-7 | unrelated `metadata` written between the initial read and the outcome write **survives** | §4.5 |
| B-8 | a CAS failure is returned as failure and is **never** translated into a completed outcome **by the handler** | §4.4, §5 |
| B-9 | two concurrent claims for the same awaiting row produce **exactly one** successful `recordAnswer`; the loser applies no side effect and emits no acknowledgement | §4.2 |
| B-10 | the **governor/retry sweep** never translates a lost outcome CAS into a completed outcome | §4.4, §5 |

B-1 and B-2 are separate cases deliberately: a guard that checks the pair jointly
can pass while either half is unenforced. **They must be instantiated against
every new read, write and list operation in §5** — not once against a
representative operation. "Every" in §4.1 is satisfied only by a case per
operation.

**B-9 covers §4.2, which v2 left unfalsified.** It must mutation-prove for the
claimed reason: removing the `state: 'awaiting_reply'` predicate, or ignoring
`updateMany.count`, has to fail B-9 specifically.

## 5 · Required service API

`brainPromptQueueService` gains these; `promptReplyHandler` imports them and
retains no `brainPromptQueue` prisma access. Names are illustrative, the
obligations are not:

```ts
getPromptForScope(promptId: bigint, scope: PromptScope): Promise<PromptRow | null>
writeSideEffectOutcome(
  promptId: bigint, scope: PromptScope,
  record: SideEffectRecord, expectSeq?: number,
): Promise<boolean>                       // false on lost CAS, never throws-to-success
listRetryableSideEffects(args): Promise<PromptRow[]>
```

`PromptScope` remains `{ userId: number; clientNumber: string }` and is
**required**, not optional, on every one.

## 6 · Acceptance criteria

| # | criterion | how it is checked |
|---|---|---|
| AC-1 | **`promptReplyHandler.ts` contains zero access to the `brainPromptQueue` Prisma model**, and cannot reacquire one. Bound to that file — **not repository-wide**; see §6.4 for why and for the measured remainder. AST/import-aware, "reaches" defined in §6.1, proven by the **evasion matrix in §6.2** — a single direct-access mutant does not satisfy it | executable guard resolving real modules; evasion matrix per §6.2 |
| AC-2 | The six `open_item` calls are unchanged; the handler may retain its Prisma import | diff review |
| AC-3 | **Preservation coverage only — see §6.3.** `tests/promptReplyRelevance.test.ts` keeps its **existing assertions and scenario arrangement unchanged**. Its `vi.doMock` factory **may** gain the new service operations, because a factory mock replaces the whole module and an absent export throws "not a function" | diff review: the `it(...)` bodies and expectations are untouched; only the mock surface grows |
| AC-4 | The protected relevance suite makes **zero `brainPromptQueue` model calls** — this is the claim, and it is narrower than "no database contact"; the production ownership boundary is AC-1's job, not AC-4's. Not "DATABASE_URL is unset" — an explicit fail-on-access Prisma proxy at the suite boundary that throws on any model access, asserting zero calls | `unshare -n` isolated run with the proxy installed; command and output recorded |
| AC-5 | Each invariant in §4 is falsified by a **behavioural** case, enumerated in §4.6 — not merely "an assertion exists" | test review against the §4.6 list |
| AC-6 | `chat18` scenario exists, paired, and is demonstrated **RED for the defect's own reason** | §7 |
| AC-7 | Full matrix green at the implementation SHA | `tsc --noEmit`, `vitest run`, `npm run build`, `git diff --check` |
| AC-8 | Live acceptance observed on production | §8 |

### 6.3 · Division of labour — what each criterion is and is not for

AC-3 alone could pass with a broken service implementation, since a mock can be
made to return anything. It is **not** load-bearing on correctness and must not
be read as such. The split:

| criterion | proves |
|---|---|
| AC-3 | the existing relevance scenarios still hold — **preservation only** |
| `chat18` (§7) | the handler actually calls the service outcome writer |
| B-1..B-10 (§4.6) | the real invariants — **at the execution level fixed below**, because several are integration properties, not service return values |
| AC-1 / AC-4 | no seam bypass **in the repaired handler** (AC-1 — handler-bound, see §6.4); no queue-model contact from the protected relevance suite (AC-4). Neither claims a repository-wide ownership boundary |

Correctness rests on `chat18` and B-1..B-10; AC-3 guards against regression in
what already worked.

**Execution level per case — mandatory.** v3 described B-1..B-10 as "real service
behaviour", which would let an implementer assert on service return values while
never proving the handler and governor consequences the cases actually name:

| cases | must execute |
|---|---|
| B-1, B-2, B-7 | the **real queue-service implementation**, with the Prisma/model boundary controlled |
| B-3, B-4, B-5, B-8, B-9 | **real handler orchestration + real queue-service logic**; only the database and provider boundaries mocked. B-3 asserts ordering between persistence and side-effect invocation; B-4/B-5 assert that orchestration invokes **no** side effect; **B-8 asserts that a CAS failure is never translated into a completed outcome by the handler** — a service test can prove the `false` return but not that consequence. The governor half is B-10, at governor level; B-9 additionally asserts acknowledgement suppression for the losing claim |
| B-6, B-10 | **real governor/retry orchestration + real queue-service logic**. B-6 proves failed records stay retryable; **B-10 proves the governor does not complete a lost CAS** — which B-6 does not cover and handler-level B-8 cannot reach |

A case executed below its stated level does not satisfy AC-5.

### 6.1 · What "reaches" means (AC-1) — scoped to the handler

**AC-1 is bounded twice over, deliberately: by SUBJECT and by MODEL.**

**Subject.** The guard's subject is **`promptReplyHandler.ts` alone** (§6.4). It
asks one question: *does this file obtain the `brainPromptQueue` model?* It makes
no claim about any other file. Other production accessors exist — 10 shipping
files, 13 sites, enumerated in §6.4 — and are out of scope by owner ruling.

**Model.** Arbitrary reachability through helpers and dynamic JavaScript is
undecidable, so the guard states what it can decide.

**MUST detect, within the handler's own source:**

- an import of the Prisma singleton, under any local name;
- a local alias by direct assignment (`const db = prisma`);
- member access on such a binding — by property (`db.brainPromptQueue`), by
  literal bracket (`db['brainPromptQueue']`), or by a bracket key **statically
  resolvable** under the grammar below;
- destructuring the model off such a binding;
- `Reflect.get(<binding>, 'brainPromptQueue')` with a **literal** key.

**"Statically resolvable" — the grammar.** A bracket key qualifies iff it is:

- a string literal; **or**
- an identifier bound by a **same-file `const`** whose initializer is exactly a
  string literal, with **zero reassignment**, optionally reached through **any
  finite acyclic chain of same-file direct `const` aliases**, resolved lexically
  with **cycle detection**. No depth number: acyclic-and-same-file is decidable,
  which is what bounds it.

Concatenation, template interpolation, imported constants, conditional
expressions and function returns are outside the grammar by definition.

**Outside the static guarantee — prohibited by rule for the handler, checked at
review, NOT claimed as detected** (R-1..R-3 in §6.2): a computed key outside the
grammar; a client the handler obtains from an **arbitrary helper**; a client the
handler obtains through a **re-exporting module**. These are ways *the handler*
could reacquire the model, which is the only thing AC-1 governs.

**Excluded from the subject:** generated `dist`; type-only references
(`import type`, type positions); `server/tests`; every file other than the
handler.

### 6.2 · The evasion matrix the guard must survive (AC-1)

Each row is a fixture the guard must flag **in the handler's source under test**.
A single direct-access mutant does not satisfy AC-1.

| # | evasion form |
|---|---|
| E-1 | direct member access — `prisma.brainPromptQueue.findFirst(...)` |
| E-2 | literal bracket — `prisma['brainPromptQueue']` |
| E-3 | destructured — `const { brainPromptQueue } = prisma` |
| E-4 | renamed import — `import db from '../db/prisma'` then `db.brainPromptQueue` |
| E-5 | namespace import, **executable form** — `import * as P from '../db/prisma'` then `P.default.brainPromptQueue` (the module default-exports the client, so a bare namespace import is not access and is not a valid fixture) |
| E-6 | **local alias** — `const db = prisma; db.brainPromptQueue…` |
| E-7 | **computed key exercising the alias chain**, not a single binding — `const a = 'brainPromptQueue'; const b = a; prisma[b]…` |
| E-8 | **`Reflect.get`** with a literal key — `Reflect.get(prisma, 'brainPromptQueue')` |

*(v6 defect: the matrix carried an "access from a different file" fixture, which
could not coexist with the handler-bound subject — flagging another production
file would recreate the repository-wide obligation §6.4 rejects, and would go red
immediately against the 10 existing accessors. Removed, and the matrix renumbered
E-1..E-8 with no gaps.)*

**Review-only prohibitions — deliberately NOT in the matrix**, because §6.1 does
not claim the guard detects them:

| # | form | status |
|---|---|---|
| R-1 | client returned from an arbitrary helper | prohibited by §6.1, checked at review |
| R-2 | client obtained via a re-exporting module | prohibited by §6.1, checked at review |
| R-3 | computed key outside the §6.1 grammar | prohibited by §6.1, checked at review |

*(v4 defect: these three were E-6/E-7 in the must-detect matrix while §6.1 said
they were outside the guarantee — the two sections contradicted each other and
could not both govern an implementation. Third instance in this document of
fixing one place and leaving another; recorded, not quietly patched.)*

### 6.4 · Why AC-1 is bound to the handler, and what remains

v1–v5 wrote AC-1 as repository-wide, allowlisting only the owning service. That
criterion **the specified implementation cannot pass**: `prisma.brainPromptQueue.*`
appears at **75 access sites across 34 files** today, and excluding the owning
service and the handler under repair, **16 files** access the model directly. A
repository-wide guard would go red the moment DEF-185's six calls landed. §3's
scope and §6's promise contradicted each other, and five rounds of tightening the
wording never touched it.

Owner ruling: **narrow AC-1 to the handler and name the remainder.** DEF-185
exists to close one seam and un-red one test; converting it into a 34-file
ownership refactor is a different piece of work with its own review surface.

**The measured remainder — recorded, NOT claimed safe.** Six of the sixteen are
operator scripts already excluded from the shipped artifact by CMP-2026-08-16
chunk 1, so the follow-up that actually ships is **10 files / 13 sites**:

| file | sites |
|---|---:|
| `services/triage/starCadenceService.ts` | 2 |
| `services/knowledge/systemCapabilitiesService.ts` | 2 |
| `services/brain/preactiveEngine.ts` | 2 |
| `services/whatsapp/WhatsAppInbound.ts` | 1 |
| `services/selfpruning/inboundNoiseLedger.ts` | 1 |
| `services/selfpruning/digestPolicy.ts` | 1 |
| `services/delegation/delegationCaptureService.ts` | 1 |
| `services/brainPrompts/negativeFeedbackHandler.ts` | 1 |
| `services/actions/handlers/brain/notifyUserRisk.ts` | 1 |
| `jobs/actionLifecycleWorker.ts` | 1 |

Already out of the artifact (chunk 1), still direct accessors:
`smokeBrainPromptProducer` (11), `smokeBrainPromptQueue` (7),
`smokeWhatsappVoiceCall` (5), `smokeOpsManualRetrieval` (5),
`smokeBrainPromptReplyFlow` (5), `smokeBrainPromptDelegateeEmail` (5).

This inventory is stated so nobody reads AC-1 as a repository-wide ownership
guarantee it does not make — the same discipline applied to the 38 untriaged
scripts in chunk 1. Extending the boundary to those 10 files is **follow-up
work**, not part of DEF-185.

**AC-1 and AC-4 are the load-bearing pair.** v1 proposed a grep for
`prisma.brainPromptQueue.*` in one file, which proves only that today's six calls
moved — the reviewer correctly named that as the same assert-on-a-description
weakness that made two earlier submissions in this campaign WEAK. And an unset
`DATABASE_URL` proves neither "no database call" nor safety from a reachable
local socket. Both must assert the property, not a proxy for it.

## 7 · Paired scenario — mandatory, and it must fail without the fix

Per the regression discipline, **both** artefacts land in the same commit as the
fix. `tests/brainRegression.test.ts` enforces the pairing and goes red if either
is missing.

- `## Chat 18` in `server/docs/brain_chat_archive.md` — next after Chat 17.
- `chat18` in `server/tests/brainScenarios.ts`, carrying all four required
  fields: `id: 'chat18'`, an executable `assert()`, `fixCommits`, and
  `symptomTags` including `protection-with-two-implementations`.

**`fixCommits` uses the repository's `'this-commit'` convention** (in use at
`brainScenarios.ts:182,214,242`). v1 required the scenario to carry the SHA of
the commit containing it, which a commit cannot do. `['this-commit']` is the
established resolution; a later docs-only commit may substitute the literal SHA.

**The assertion runs against the real path** — import `handlePromptReply` and
drive the *relevant → consumed* branch with the queue service mocked and **no
database available**, asserting that the reply is consumed and the side-effect
outcome is recorded through the service. It must **not** assert against a
reimplementation.

**Mutation requirement — RED for the defect's own reason.** "Restore a direct
call and see it fail" is insufficient: an arbitrary edit fails for incidental
reasons and proves nothing. The demonstration must run the **same `chat18`
assertion** against either (a) the exact unfixed base implementation, or (b) a
precise mutation that replaces the service call with the former direct
`readPromptRow` / `writeSideEffectRecord` path — and the RED must specifically
show **forbidden Prisma model access, or failure to call the service outcome
writer**, not a crash of another kind.

Recorded evidence must include: the command, the tested SHA or the mutation diff,
the failing assertion by name, and the error. The same requirement applies to
AC-1's guard: mutate one access back and show the guard, not the suite, goes red.

**Note on provenance, stated honestly:** DEF-185 was found by bisecting a red
branch, not reported from a real WhatsApp conversation. The `## Chat 18` entry
must say so plainly rather than inventing an owner report. The pairing is
required because the enforcement is structural, not because a chat exists.

## 8 · Live acceptance — this is a messaging path

`promptReplyHandler` is on the inbound reply path, so per the release-status
semantics the change is **PARTIAL** until live acceptance passes on production,
regardless of how green the suite is. Unit tests alone never establish success
here.

Live acceptance = a real inbound reply to a real awaiting prompt on production,
where:

1. the reply is consumed (prompt leaves `awaiting_reply`),
2. the side-effect outcome is recorded on the row with `phase` and `attempts`,
3. the correlation to the inbound path is confirmed.

**Evidence is bounded by AUDIENCE, and the two must not be conflated:**

| audience | may contain |
|---|---|
| **a direct, private response to the owner** — not retained in any repository or scorer artifact | verbatim quotation of his own conversation, with send times — his data, his standard |
| **any repository record, log, scored artifact, evidence pack, mutation/acceptance command output, or third-party prompt** | bounded metadata ONLY: scoped prompt id, pre/post state, outcome `phase`, `attempts`, timestamps, inbound correlation. Never a name, phone number, email, or message body |

Until all three are observed the DEF row reads **BUILT, NOT VERIFIED**, and
`DEPLOYED` is never written as `VERIFIED`.

## 9 · Tagging

Primary: `protection-with-two-implementations` — the queue table is written from
two places and only one is covered by the seam, which is the established §3
mechanism and the same one DEF-181 carries.

Proposed refinement, for the owner to accept or fold:
**`seam-bypassed-by-new-write`** — the existing tag describes a *protection*
implemented twice; this is a *test seam* that new code routed around. Minted
separately so §3 counts are not inflated by a mislabel, following the precedent
DEF-182 set with `one-concept-many-definitions`.

## 10 · Non-goals

- Not fixing the `open_item` direct access.
- Not changing the DEF-180 protocol's semantics.
- Not deploying. Deploy is approval #7 and remains absent; `deployed-sha` is
  `e356d42` and this defect is not in it.
- Not rewriting `tests/promptReplyRelevance.test.ts`'s **scenarios**. Per AC-3
  the `it(...)` bodies, inputs and expectations are frozen; **only** the
  `vi.doMock` factory's export surface may grow, and only to add the new service
  operations. New mock return values that bypass ordering, CAS failure or failure
  propagation in the existing scenarios are prohibited.
  *(v2 defect: this bullet still carried v1's "must pass unmodified" and
  contradicted AC-3 — the same fix-one-place-miss-the-other shape this contract
  exists to close. Recorded rather than quietly corrected.)*

## 11 · What "done" means

All eight acceptance criteria met, the mutation demonstration recorded, the DEF-185
row updated with root cause + fix commit + executable scenario, a Codex verdict of
SOUND on the implementation range, and live acceptance observed. Anything short of
that is reported as **NOT VERIFIED**, never assumed.

## 12 · Review record — v1 `92077f7` ruled WRONG / BLOCKED

Codex confirmed **Option 2 is the correct architectural direction** and that the
`open_item` exclusion is correct, then ruled the contract not buildable. All
eight findings and their resolution:

| # | finding | resolved |
|---|---|---|
| 1 | **BLOCKER** — AC-3 internally impossible: the `vi.doMock` factory exports only `getAnswerableQuestions`, `reviveExpiredPrompt`, `recordAnswer`, `sendNextPrompt`; a factory mock replaces the module, so any new service export is `undefined` and throws "not a function". v1 demanded new calls AND forbade the mock update | AC-3 rewritten: assertions and arrangement unchanged, **mock surface may grow**. Verified against `promptReplyRelevance.test.ts:98-107` |
| 2 | **HIGH** — AC-1 relocated the class: a grep in one handler proves only that today's six calls moved | AC-1 became repository-wide, AST/import-aware, allowlist-based and mutation-proven. **SUPERSEDED at v6** — repository-wide proved unachievable at this scope; see §6.4 and §16. The AST/import-aware and mutation-proven parts survive, scoped to the handler |
| 3 | `open_item` boundary correct; handler may keep the Prisma import | recorded in AC-2 — which makes AC-1's model-specific guard more important, not less |
| 4 | **HIGH** — §4 invariants not falsified by AC-5 | §4.6 adds eight named behavioural cases, B-1/B-2 split deliberately |
| 5 | **HIGH** — AC-4 not checkable: unset `DATABASE_URL` proves neither zero calls nor safety from a local socket | AC-4 now requires a fail-on-access Prisma proxy asserting zero calls, with command and evidence recorded |
| 6 | **HIGH** — mutation underspecified, could fail incidentally | §7 requires RED **for the defect's own reason**, against the exact base or a precise mutation, with command / SHA-or-diff / assertion name / error recorded |
| 7 | **MEDIUM** — `fixCommits` contradictory: a commit cannot contain its own SHA | uses the repository's `'this-commit'` convention. **I initially doubted this convention existed** — my first grep matched only literal SHAs. It is real, at `brainScenarios.ts:182,214,242`. Codex was right and I was wrong |
| 8 | **BLOCKER** — live acceptance conflicts with the evidence policy | **partially accepted — see dissent below** |

### Dissent on finding 8, with evidence

The prohibition Codex cites is real but **scoped to a different audience**.
`scripts/orchestrator/evidence-pack.sh:13-14` reads: *"it carries counts, dates
and rates — never a name, a phone number, an email address or a message body …
The scorer needs to know THAT the capability fires and how often"* — and
`campaign.json` states its reason plainly: *"this text goes to a third-party
model."* It governs evidence leaving the system to the scorer, not what the owner
is shown about his own conversation.

The opposite standard governs owner-facing acceptance. `campaign.json` C-2
increment 1 is `done_when`: *"A real chase reaches Hamna without the owner
asking, **quoted verbatim with its send time**, from production"*, and the owner
ruling of 2026-08-13 requires behaviour *"OBSERVED ON HIS LIVE WHATSAPP and the
evidence **quoted back to him**"*. Verbatim quotation to the owner is the
required standard, not a violation of policy.

**What I accept:** v1 said "quoted back to the owner from production data"
without naming the audience, so it could be read as licensing message bodies in a
scored artifact or evidence pack. That ambiguity was a real defect. §8 now splits
the two audiences explicitly.

**What I do not accept:** replacing owner-facing verbatim evidence with metadata
only. That would weaken the acceptance bar the owner set, in the name of a rule
written for a third-party scorer. If the owner rules otherwise, this contract
gets re-frozen against that ruling — but it should be his call, not an inference
from a mis-scoped policy.

## 13 · Review record — v2 `cfa8d29` ruled WRONG / BLOCKED

| # | finding | resolved |
|---|---|---|
| 1 | **BLOCKER** — §10 still carried v1's "must pass unmodified", contradicting the corrected AC-3 | §10 rewritten to freeze `it(...)` bodies/inputs/expectations while permitting only the mock's export surface to grow. **Mine, and ironic:** I corrected AC-3 and left the same claim standing elsewhere in the document — the fix-one-place-miss-the-other shape this contract exists to close. Recorded, not quietly patched |
| 2 | **HIGH** — §4.2 (CLAIM exactly-once) had no falsifier among B-1..B-8 | **B-9** added: two concurrent claims yield exactly one successful `recordAnswer`, loser applies no side effect and emits no acknowledgement; mutation-proven by removing the `state` predicate or ignoring `updateMany.count` |
| 3 | **HIGH** — AC-1's mutation proof narrower than AC-1's promise; a guard could pass one direct-access mutant and still miss re-exports, namespace imports, destructured aliases and helper-returned clients | **§6.2 evasion matrix E-1..E-8**, including access from a foreign file, plus **§6.1** defining what "reaches" excludes (generated `dist`, type-only references, test code) and prohibiting indirect re-export outright |
| 4 | **MEDIUM** — AC-3 safe only in combination; the division of labour was implicit | **§6.3** states it explicitly: AC-3 is preservation coverage only; correctness rests on `chat18` and the B-cases (B-1..B-9 at v3; **B-1..B-10 from v6**, after B-10 was added for the governor); new mock return values that bypass ordering, CAS failure or failure propagation are prohibited |
| 5 | wording — "the owner, in his own report" could describe a persisted file | §8 now reads "a direct, private response to the owner — not retained in any repository or scorer artifact", and the metadata-only row now enumerates repository records, logs, and mutation/acceptance command output |
| 6 | B-1/B-2 instantiated once against a representative operation | §4.6 now requires them **per operation** across every new read, write and list in §5 |

### The dissent was upheld

Codex ruled: *"Your audience scoping is substantively correct … I do not uphold
finding 8 as a blocker after this clarification."* The later explicit owner
ruling controls the owner-facing acceptance report under AGENTS.md's precedence
clause, and `evidence-pack.sh`'s aggregate-only rule is expressly justified by
transmission to a third-party scorer. The one wording correction it asked for is
applied above.

Recorded because the pushback was the right call: complying with a mis-scoped
policy would have lowered the owner's own acceptance bar, and the resolution came
from citing the governing text rather than deferring.

## 14 · Review record — v3 `b3b75aa` ruled WRONG / BLOCKED

| # | finding | resolved |
|---|---|---|
| 1 | **HIGH** — AC-1's proof narrower than its promise: E-4 covered a renamed import but not a local alias (`const db = prisma`), E-2 a literal bracket but not a computed key; `Reflect.get` uncovered | **E-9** (local alias) and **E-10** (statically resolvable computed key) added, and — more importantly — **§6.1 now bounds the promise**. See below |
| 2 | **HIGH** — §6.3 misassigned B-3/4/5/6/9 to "service behaviour" when they are integration properties, letting an implementer assert service return values without proving handler/governor consequences | §6.3 fixes the **execution level per case**: real service with controlled model boundary (B-1/2/7/8); real handler orchestration + real service (B-3/4/5/9); real governor + real service (B-6). A case executed below its level does not satisfy AC-5 |
| 3 | **MEDIUM** — AC-4 overclaimed "no database contact" | AC-4 now claims exactly "zero `brainPromptQueue` model calls from the protected relevance suite", and §6.3 records that the production boundary is AC-1's job |

### The real correction: a bounded guarantee replaces an unfalsifiable one

The reviewer's sharpest point was not any single evasion form:

> *"Arbitrary reachability through helpers/dynamic JavaScript is unfalsifiable
> unless AC-1 defines a bounded static-analysis model. The contract currently
> promises more than its fixtures demonstrate."*

v3 said AC-1 detects access "however the client is obtained" and then proved it
with a finite matrix — an absolute promise with a finite proof, which is the same
overclaim shape as `b3a213d`'s exclude-array assertion and this contract's own
earlier "no write reachable anywhere". Adding E-9 and E-10 alone would have
repeated it one rung higher.

So §6.1 now states the guard's **model** — imports under any local name, local
aliases by direct assignment, member/literal-bracket/statically-resolvable-computed
access, destructuring — and states plainly what falls **outside** it:
`Reflect.get`, non-resolvable computed keys, and clients returned from arbitrary
helpers. Those are **prohibited by rule and checked at review**, not claimed as
detected.

A bounded guarantee that is true beats an absolute one that cannot be tested.
That is the lesson this campaign has now produced four times, and it is recorded
here so the implementation is built against the honest version.

## 15 · Review record — v4 `23fa274` ruled WRONG / BLOCKED

| # | finding | resolved |
|---|---|---|
| 1 | **HIGH** — §6.1 and §6.2 contradicted each other: §6.1 placed helper-returned and re-exported clients outside the guarantee while §6.2 still required the guard to flag them as E-6/E-7. Both cannot govern an implementation | E-6/E-7 removed from the must-detect matrix and restated as **R-1/R-2 review-only prohibitions**. Matrix renumbered E-1..E-9 with no gaps |
| 2 | **HIGH** — "statically resolvable" had no bounded grammar | §6.1 now defines it mechanically: a string literal, or a **same-file `const`** initialized to exactly a string literal with **zero reassignment**, optionally through a bounded chain of direct `const` aliases. Concatenation, templates, imported constants, conditionals and function returns are outside it by definition. **E-8 must use exactly that grammar** |
| 3 | **MEDIUM** — B-8 assigned to service-only execution while asserting an orchestration consequence | B-8 moved to **real handler orchestration + real service logic**. A service test can prove the `false` return; it cannot prove the handler or governor never translates it into a completed outcome |
| — | assessment: `Reflect.get` with a literal key is cheap and deterministic to detect and should preferably be guarded | accepted — added as **E-9** inside the guarantee, rather than left review-only as v4 had it |

### Third instance of the same shape, and the self-check that finally caught it

Finding 1 was mine, and it is the third time in this contract that fixing one
section left a contradicting claim standing in another — AC-3 vs §10 in v2, then
§6.1 vs §6.2 here. That is precisely the defect class DEF-185 exists to close,
reproduced inside the document that governs it.

So v5 was checked **against itself** before submission, not only against the
findings: matrix rows enumerated for gaps and duplicates, every B-case confirmed
assigned exactly once in §6.3, §6.1's exclusion list diffed against R-1..R-3, and
the document grepped for the withdrawn absolute promise. The two surviving
occurrences of *"however the client is obtained"* are historical quotations in
§6.1's preamble and §14 describing what v3 claimed — not live promises. That
check is now part of freezing a version, because reviewer-found internal
contradictions have cost this contract two rounds.

## 16 · Review record — v5 `74d921d` ruled WRONG / BLOCKED

| # | finding | resolved |
|---|---|---|
| 1 | **AC-1 contradicted the declared implementation scope** — repository-wide with only the service allowlisted, while 16 other production files already access the model. The guard would fail immediately after the specified fix | **§6.4**: AC-1 bound to `promptReplyHandler.ts` by owner ruling, with the remainder measured and named — 75 sites / 34 files total, 16 direct accessors, of which 10 ship and 6 are already out of the artifact via chunk 1 |
| 2 | **B-8 could not prove its full claim** — assigned to handler execution while asserting the governor also never completes a lost CAS | B-8 narrowed to **the handler**; **B-10** added for the **governor/retry sweep**, executed at governor level. B-6 proves retryability, which is not the same property |
| 3 | **alias chain unbounded, fixtures under-exercised** | §6.1 now specifies **any finite acyclic same-file `const` chain, resolved lexically with cycle detection** — decidable without an arbitrary depth number. **E-8** now exercises a real two-hop chain; **E-5** is made executable as `P.default.brainPromptQueue`, since a bare namespace import is not access |

### What five rounds of wording could not fix

Finding 1 is the one worth keeping. It was not a phrasing defect — it was a
contradiction between §3's scope and §6's promise, present since v1 and untouched
by four rounds of tightening AC-1's language. Each round made the *guarantee*
sharper while leaving it aimed at a target the implementation could never hit.

The measurement is what exposed it: 16 files, not zero. No amount of re-reading
the contract would have produced that number, and the reviewer found it by
checking the claim against the tree rather than against the document. That is the
same lesson this campaign has produced at every level — check the object, not the
description of it.

## 17 · Review record — v6 `e9257b0` ruled WRONG / BLOCKED

Every finding was an internal contradiction or a structural defect in this
document. **No substantive disagreement remains** — the reviewer confirmed the
alias-chain rule is decidable, E-5/E-8 exercise their stated forms, and B-10's
governor execution level is correct.

| # | finding | resolved |
|---|---|---|
| 1 | AC-1 bound to the handler by §6/§6.4, while §6.1 still defined the guard over the whole `server/src` module graph, the matrix still required flagging access **from another file**, and §6.1 still called helper/re-export "an AC-1 violation in its own right". The different-file fixture could not coexist with the narrowed boundary — it recreates the repository-wide obligation §6.4 rejects and would go red against the 10 existing accessors | §6.1 and §6.2 **rewritten wholesale**, not patched. §6.1 now bounds AC-1 twice — by **subject** (the handler's source alone) and by **model** (what a static guard can decide). The different-file fixture is removed, the matrix renumbered **E-1..E-8**, and R-1..R-3 restated as ways *the handler* could reacquire the model |
| 2 | §6.3 still said B-8 covers "the handler **or governor**", contradicting the narrowed B-8 and the B-10 split | corrected to the handler; the governor half is named as B-10 |
| 3 | §6.3 said `B-1..B-9` in two places, omitting B-10 | both corrected to B-1..B-10; the one surviving `B-1..B-9` is an annotated historical note in §13 |
| 4 | a blank line after B-8 terminated the §4.6 Markdown table, leaving B-9 and B-10 outside it — so the "B-1..B-10" enumeration was not structurally one table | blank line removed; table verified as **10 contiguous rows** |

### The method was the defect, not the wording

Rounds 6 and 7 produced no substantive findings at all — only contradictions I
introduced while fixing the previous round. The cause is identifiable: I had been
editing a long governing document by targeted string replacement, section by
section, which reliably updates one statement of a claim and leaves its restatements
standing. Narrowing AC-1 in §6 and §6.4 left three contradicting sentences in §6.1
and §6.2 and one stale range in §6.3.

v7 changed the method: §6.1 and §6.2 were **rewritten whole** rather than patched,
and the self-check now verifies structure as well as content — matrix rows
enumerated for gaps, every B-case checked as defined once and assigned once,
cross-references to B-ranges grepped, §6.1's exclusions diffed against R-1..R-3,
and the Markdown tables checked for contiguity, which is how finding 4 hid.

Recorded because it is the same lesson at a different altitude: for four rounds I
verified what the contract *said* and never verified the document *as an object*.
