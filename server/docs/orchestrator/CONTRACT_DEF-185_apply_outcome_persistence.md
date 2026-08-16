# CONTRACT · DEF-185 — apply-outcome persistence routes through `brainPromptQueueService`

**Status: RE-FROZEN 2026-08-16 (v4).** v1 (`92077f7`) was reviewed **WRONG /
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
| B-8 | a CAS failure is returned as failure and is **never** reported as a completed outcome | §4.4, §5 |

| B-9 | two concurrent claims for the same awaiting row produce **exactly one** successful `recordAnswer`; the loser applies no side effect and emits no acknowledgement | §4.2 |

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
| AC-1 | **No production code outside an owner allowlist reaches the `brainPromptQueue` Prisma model.** Repository-wide over `server/src`, allowlisting only `brainPromptQueueService`. AST/import-aware. **"Reaches" is defined in §6.1**, and the guard is proven by the **evasion matrix in §6.2** — a single direct-access mutant does not satisfy it | executable guard resolving real modules; evasion matrix per §6.2 |
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
| B-1..B-9 (§4.6) | the real invariants — **at the execution level fixed below**, because several are integration properties, not service return values |
| AC-1 / AC-4 | no seam bypass (AC-1, production-wide); no queue-model contact from the protected relevance suite (AC-4) |

Correctness rests on `chat18` and the B-cases; AC-3 guards against regression in
what already worked.

**Execution level per case — mandatory.** v3 described B-1..B-9 as "real service
behaviour", which would let an implementer assert on service return values while
never proving the handler and governor consequences the cases actually name:

| cases | must execute |
|---|---|
| B-1, B-2, B-7, B-8 | the **real queue-service implementation**, with the Prisma/model boundary controlled |
| B-3, B-4, B-5, B-9 | **real handler orchestration + real queue-service logic**; only the database and provider boundaries mocked. B-3 asserts ordering between persistence and side-effect invocation; B-4/B-5 assert that orchestration invokes **no** side effect; B-9 additionally asserts acknowledgement suppression for the losing claim |
| B-6 | **real governor/retry orchestration + real queue-service logic** |

A case executed below its stated level does not satisfy AC-5.

### 6.1 · What "reaches" means (AC-1)

**AC-1 is bounded to a static-analysis model, deliberately.** Arbitrary
reachability through helpers and dynamic JavaScript is undecidable, so a contract
that promises to detect it "however the client is obtained" promises more than
any fixture set can demonstrate. v3 made that promise; v4 withdraws it and states
what the guard actually guarantees.

**The guard's model — what it MUST detect** (over the module graph of
`server/src`):

- imports of the Prisma singleton, under any local name;
- local aliases established by direct assignment (`const db = prisma`);
- member access on such a binding, whether by property (`db.brainPromptQueue`),
  by literal bracket (`db['brainPromptQueue']`), or by a bracket whose key is a
  **statically resolvable** string constant;
- destructuring of the model off such a binding.

**Outside the static guarantee — prohibited by rule, enforced at review, and NOT
claimed as detected:** a client reached through `Reflect.get`, a computed key not
statically resolvable, or a client returned from an arbitrary helper. §6.1
forbids these outright; the guard is not asserted to catch them. Stating this is
the difference between a bounded guarantee and an unfalsifiable one.

**Excluded, explicitly:** generated `dist` output; type-only references
(`import type`, type positions); `server/tests`; and the allowlisted owning
service itself. **Indirect re-export of the Prisma client is prohibited** rather
than merely detected — a helper that returns the client, or a module that
re-exports it, is an AC-1 violation in its own right.

### 6.2 · The evasion matrix the guard must survive (AC-1)

Each row is a fixture the guard must flag. Passing one direct-access mutant while
missing these would satisfy a narrower reading of §7 while failing AC-1's actual
promise, so the matrix is named here:

| # | evasion form |
|---|---|
| E-1 | direct member access — `prisma.brainPromptQueue.findFirst(...)` |
| E-2 | bracket access — `prisma['brainPromptQueue']` |
| E-3 | destructured — `const { brainPromptQueue } = prisma` |
| E-4 | renamed import — `import db from '../db/prisma'` then `db.brainPromptQueue` |
| E-5 | namespace import — `import * as P from '../db/prisma'` |
| E-6 | client returned from a helper function |
| E-7 | client obtained via a re-exporting module |
| E-8 | access from a **different file** than `promptReplyHandler.ts` |
| E-9 | **local alias** — `const db = prisma; db.brainPromptQueue…` |
| E-10 | **computed property with a statically resolvable key** — `const m = 'brainPromptQueue'; prisma[m]…` |

E-9 and E-10 were added in v4: E-4 covered a renamed *import* but not a local
alias, and E-2 covered a *literal* bracket but not a computed one. An
implementation could have passed E-1..E-8 while violating AC-1.

**Not in the matrix, by design:** `Reflect.get(prisma, 'brainPromptQueue')` and
non-resolvable computed keys. They are prohibited by §6.1 and checked at review;
the guard does not claim to detect them.

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
| 2 | **HIGH** — AC-1 relocated the class: a grep in one handler proves only that today's six calls moved | AC-1 is now repository-wide, AST/import-aware, allowlist-based, and mutation-proven |
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
| 4 | **MEDIUM** — AC-3 safe only in combination; the division of labour was implicit | **§6.3** states it explicitly: AC-3 is preservation coverage only; correctness rests on `chat18` and B-1..B-9; new mock return values that bypass ordering, CAS failure or failure propagation are prohibited |
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
