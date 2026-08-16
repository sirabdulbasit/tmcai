# CONTRACT · DEF-185 — apply-outcome persistence routes through `brainPromptQueueService`

**Status: FROZEN 2026-08-16.** Changes to this contract require an explicit
re-freeze by the owner. No implementation exists yet; this document is the thing
under review.

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
   must not become a blind overwrite of unrelated keys.

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
| AC-1 | `promptReplyHandler.ts` contains **zero** `prisma.brainPromptQueue.*` calls | grep, and a guard test asserting it |
| AC-2 | The six `open_item` calls are unchanged | diff review |
| AC-3 | `tests/promptReplyRelevance.test.ts` passes **unmodified** — its existing queue-service mock now covers the path | `npx vitest run tests/promptReplyRelevance.test.ts` → 11 passed |
| AC-4 | The suite passes with `DATABASE_URL` **unset**, and reaches no database | full run in a network-isolated clone |
| AC-5 | Invariants §4.1–§4.5 each have a named assertion | test review |
| AC-6 | `chat18` scenario exists, paired, and **fails without the fix** | §7 |
| AC-7 | Full matrix green at the implementation SHA | `tsc --noEmit`, `vitest run`, `npm run build`, `git diff --check` |
| AC-8 | Live acceptance passed on production | §8 |

**AC-4 is the one that matters most.** The current failure is environmental
accident; the fix must make the test independent of `DATABASE_URL` rather than
merely green where it happens to be unset.

## 7 · Paired scenario — mandatory, and it must fail without the fix

Per the regression discipline, **both** artefacts land in the same commit as the
fix. `tests/brainRegression.test.ts` enforces the pairing and goes red if either
is missing.

- `## Chat 18` in `server/docs/brain_chat_archive.md` — next after Chat 17.
- `chat18` in `server/tests/brainScenarios.ts`, carrying all four required
  fields: `id: 'chat18'`, an executable `assert()`, `fixCommits` with the
  implementation SHA, and `symptomTags` including
  `protection-with-two-implementations`.

**The assertion runs against the real path** — import `handlePromptReply` and
drive the *relevant → consumed* branch with the queue service mocked and **no
database available**, asserting that the reply is consumed and the side-effect
outcome is recorded through the service. It must **not** assert against a
reimplementation.

**Mutation requirement:** before the commit lands, restore a direct
`prisma.brainPromptQueue` call in the apply path and confirm `chat18` goes
**red**. A scenario that passes against the unfixed code is a permanent green
light over a live bug, and this contract is not satisfied without that
demonstration recorded.

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
3. the exchange is quoted back to the owner from production data.

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
- Not modifying `tests/promptReplyRelevance.test.ts` — AC-3 requires it pass
  **unmodified**, because editing the test to accommodate the code is the failure
  mode this contract exists to prevent.

## 11 · What "done" means

All eight acceptance criteria met, the mutation demonstration recorded, the DEF-185
row updated with root cause + fix commit + executable scenario, a Codex verdict of
SOUND on the implementation range, and live acceptance observed. Anything short of
that is reported as **NOT VERIFIED**, never assumed.
