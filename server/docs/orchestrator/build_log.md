# Build log — written by Claude, read by Codex

One `## Iteration N` section per build turn, appended, newest at the bottom.
Codex reviews these entries against the real diff, so a claim here that the diff
does not support is the single most useful thing for the reviewer to catch.

Required per iteration: what the fix queue said, what was changed and why, the
verification numbers (tsc / vitest, exact figures), what was NOT done, and the
honest expectation of which criterion should move.

---

## Iteration 1 — mode: incremental

**Gating criterion: C4 @ 84.8** (human voice). Overall 92.7. C4 is the minimum of
the eight and therefore the only thing that matters this turn.

### The fix queue entry I targeted

C4 is not one bad reply — it is **eleven of the twelve cases**, and the judge
names the same cause in ten of them. Quoting the worst three verbatim:

> **B08-bad-news, C4 = 80** — "The tone is generally professional and helpful.
> However, **'Sir,' feels a little overly formal and slightly stilted**, rather
> than a natural human assistant's speech."

> **B09-identity, C4 = 80** — "The response starts with 'I'm Suzi, Sir.' **The
> 'Sir' is overly formal and somewhat generic, detracting slightly from a
> natural human voice.** … this initial formality feels a little canned."

> **B11-capability-limit, C4 = 88** — "the use of 'Sir' feels slightly formal and
> generic … **it's a common opening that makes it feel a bit less natural than
> it could be.**"

and B01 / B02 / B03 / B05 / B06 / B07 / B12 all say a version of the same thing
("template-like", "canned", "a bit robotic if overused").

I checked this against the replies themselves rather than trusting the judge's
summary. **11 of the 12 answers open with the address token**: seven with a bare
`"Sir, …"`, plus `"Good morning, Sir."`, `"Of course, Sir."`, `"Apologies, Sir."`,
`"I'm Suzi, Sir."`. The only reply that does not is B04 — the one that failed for
an unrelated continuity reason. That is not a tone wobble, it is a template.

**Expected to move: C4.** Nothing else is targeted this turn.

### Governing-docs verdict, before coding: PROGRESSING

- `brain_change_log.md` — no DEF row covers frequency of address. The nearest,
  **DEF-092** (owner: *"i don't want robotic answers"*), is the same owner-level
  objective but a different mechanism: it was 102 hardcoded bracket markers
  rendering as canned sentences, fixed structurally in `74981b2`.
- `brain_evaluation_chart.md` §3 — 15 recurrence tags; none is about address.
  The closest is `time-of-day-drift` (DEF-026 ×4, *"Morning, Sir" at 2:04 PM*),
  which is a **wrong-time greeting**, not an over-used one. Different cause.
- `brain_chat_log.md` — latest CL-032; nothing on tone since.

So: new root cause, first occurrence, logged as **DEF-134**. I want to be
straight about one thing rather than claim a clean-sheet: this sits under the
DEF-092 umbrella complaint. The mechanism is new; the owner's dissatisfaction is
not. I treated it structurally regardless.

### What I changed, and why that is the mechanism

**1. `server/src/services/knowledge/brainPersonaService.ts:151-152`** — the cause.

The old line was:

> "**Address the user as "${addressAs}".** … When you greet, **refer, or answer**,
> use "${addressAs}" … Use the preferred form **every time**."

That line answers two different questions with one rule. *Which* form to use
("Sir", not "Basit Ahmed") is a real user setting from Settings → Profile,
defended since 2026-05-20, and it stays untouched. *How often to address them at
all* was never a setting — but "when you … answer" plus "every time" states it as
a per-message obligation, and the model complied precisely. Confirming that this
is the operative instruction and not an incidental one: contract §8 already
forbids `"Of course {{addressAs}}!"` by name, and B06 opened with "Of course,
Sir." anyway. The "every time" line out-competed an explicit prohibition.

The replacement splits the two. Bullet one keeps the form mandatory and keeps
`NEVER "<fullName>"` verbatim. Bullet two makes *addressing at all* optional,
forbids the bare-vocative opener using the two verbatim failing shapes as
examples, names where a person would really use a name (opening greeting, real
bad news, urgent attention), and gives a ceiling — more than about one reply in
four and it is a template.

**2. `server/src/services/knowledge/brainComposer.ts` — `stripBareVocativeOpener`**
(defined above `compose`, called at the end of the existing address guard).

A prompt edit alone is a weak lever for exactly this class, and the codebase
already says so: the address guard's own comment (2026-05-20) reads *"structural
post-process is the only thing that stops it 100% of the time"*. So the same
two-layer shape is used here. Ordering is deliberate — the address guard
normalises the *form* first, then this strips the reflexive *use*.

It is narrow on purpose. It cuts **only a bare vocative at position 0** — the
token, then a comma / dash / colon — because that is the one shape no person
writes habitually. Untouched: greetings (`"Good morning, Sir."`, which scored 90
and is genuinely natural), the address anywhere later in the reply, and the
address as a sentence subject (`"Sir Basit is asking…"` in
`outboundMessageTemplate.ts` has no separator and cannot match). It never leaves
a stub, and the address token is regex-escaped.

**3. `server/tests/def134BareVocativeOpener.test.ts`** — 19 tests. Five are the
verbatim B01/B02/B03/B07/B11 openers; the rest pin the separation between the
reflexive use and the legitimate ones, which is the entire point of the guard.

### Verification — re-run after the last edit, from `server/`

```
npx tsc --noEmit    exit 0, no output (clean)
npx vitest run      Test Files  162 passed | 1 skipped (163)
                    Tests  1878 passed | 7 expected fail | 21 skipped | 1 todo (1907)
                    Duration 18.43s
npm run build       exit 0 (prisma generate + tsc)
git diff --check    exit 0, no output
```

Baseline before my change was 1877 passed / 1906 total; +1 test file, +18 then
+19 tests is mine. No pre-existing test changed state.

**Mutation results — including the ones that embarrassed me.** I wrote three
mutation claims into the DEF row, then actually ran them against six mutants
rather than asserting them. **Three of my six mutants survived**: the anchor
mutant, the escaping mutant and the period-separator mutant all stayed green. My
"metachar" test was simply built wrong — it fed an input the mutated regex could
not match either, so it proved nothing — and I had no anchor test at all. I
rewrote both and added a later-in-reply case. Now **5 of 6 mutants die**: drop
the `^` anchor, drop the escaping, drop the recapitalisation, drop the stub
guard, make the separator optional. The sixth (adding `.` to the separator
class) survives and **I deliberately did not write a test for it, because it is
not a defect** — `"Sir. I haven't sent…"` is a bare vocative too.

### What I did NOT do

- **Did not touch the benchmark or the judge.** No edit to
  `nexeoCapabilityBenchmark.ts` or `brainResponseEvaluator.ts`.
- **Did not re-run the benchmark.** The score in this entry is still iter-00.
  Whether C4 actually moved is unmeasured by me.
- **Did not fix B04**, which owns the four worst individual scores in the whole
  report (C3 = 20, C1 = 30, C5 = 30, C7 = 50 — Brain ignored a priority the user
  had just supplied and claimed it was missing). That is a much more serious
  defect than tone. I left it because it is a *continuity* failure and the loop
  gates on the minimum criterion, which is C4, and because mixing two fixes makes
  the score move unattributable. **B04 should be the next directive** unless C4
  fails to clear; it is the largest pool of lost points in the report and it is a
  Brain telling the user something untrue about their own last message.
- **Did not touch "Suzi"**, flagged in B09 on both C4 and C8 as "an inconsistent
  identity". That is a configured `brainName`, not a bug, and changing it to
  chase two cases would be exactly the score-motivated edit this loop forbids.
- **Did not add a §3 recurrence tag.** §3 records recurrences; this is a first
  occurrence and its record is the DEF-134 row. If it recurs, it earns a tag.
- **Did not add an evaluation-chart row** — there is no deploy this turn.

### What I am unsure about

- **The prompt half is unverifiable here.** No unit test can show that the model
  stops volunteering the vocative; only the next benchmark run can. The guard is
  the part I can actually prove, and it covers roughly 7 of the 11 cases (the
  bare `"Sir, …"` openers). `"Of course, Sir."`, `"Apologies, Sir."` and
  `"I'm Suzi, Sir."` are left entirely to the prompt.
- **The judge may be partly wrong here, and I want that on the record.** "Sir" is
  an explicit owner setting. A judge that reads any honorific as canned would be
  penalising a correct product behaviour, and the right response to that would be
  to leave it alone, not to strip the setting. I did not read it that way — the
  complaints are about a *reflexive prefix on every reply*, which is a real
  naturalness defect independent of the judge — so I changed frequency and left
  form fully intact. If Codex reads the fixQueue as an attack on the honorific
  itself, the correct verdict is that this change is misdirected, and I would
  rather hear that than have it pass quietly.
- **One-in-four is a made-up number.** It is a steer for the model, not a measured
  threshold, and nothing enforces it.

### Prediction, and what would falsify it

**C4 should rise from 84.8.** The mechanism is present in 11 of 12 cases and is
the sole named cause in 10 of them, so if the diagnosis is right the movement
should be broad rather than one or two cases — most C4 case scores should tick up
together.

**What would prove me wrong:**
- C4 stays flat or moves within a point or two → the vocative was not what the
  judge was actually pricing, and the residual complaints (clunky phrasing,
  "parked as DRAFT", bullet-heavy structure) are the real weight. Those are
  visible in the same fixQueue entries and would then be the next target.
- **C4 rises but C8 (persona, 98.3) or C2 (grounding, 96.3) falls** → stripping
  the address cost something real about consistent character. This is the
  regression I would most expect, and C8 is the criterion to watch.
- **B05 or B10 lose points** → the guard over-reached into greetings, which it is
  specifically built not to do, and the greeting assertion is wrong.
- Any drop in overall while C4 rises → I moved the minimum by damaging the mean,
  which is not a win under a "95 on every criterion" gate.

---

## Iteration 2 — mode: incremental

**No Codex review to read.** `review_log.md` still contains only its header — iteration 1 has
not been reviewed. So there was no ranked directive, and precedence fell to
`operator_directives.md` and the owner's direct handoff, which names DEF-130 first.

**No benchmark fixQueue entry drove this turn either.** The loop is stopped (`STOP` present)
and the last measurement, `iter-01-post-build`, was started but never recorded a result line.
The gating criterion is therefore still the iter-00 figure — **C4 @ 84.8, overall 92.7** — and
I did not target it. I am stating that plainly rather than implying this turn moved the gate.

### What I built, and why this one

The owner's handoff put **DEF-130** first: Brain denying it can delete an open item. It was
described as needing no new code, with the fix belonging in the capability *description*.

**That diagnosis was wrong, and the method the handoff mandated is what found it.** Instructed
to read the capability block actually sent on a removal turn, I traced it to
`brainCapabilityLive.renderCapabilityBlockLive()`, which generates the CAN list from
`action_definitions` ROWS — then queried production:

```
seed file declares 18 types  ·  production has 16 rows
missing: remove_open_item (DEF-106, ed3f8ee) and create_contact (DEF-058, b284ecf)
```

`remove_open_item` was seeded in the **file**, never in the **database**. The seeder is a
hand-run CLI that nothing invokes — the only other mention of its name in `src/` is a log
string telling an operator to run it. Brain's denial was **honest**: the block genuinely did
not list removal, and `mark_open_item_done` was on it, which is why that was the alternative
offered.

Two DEF fixes therefore shipped complete, working capabilities that never reached a prompt.
That is working rule 1 — a fix that cannot travel is not a fix — with the failure sitting
between the repo and the database rather than between two copies of the code.

**Fix: seed the registry at boot**, the same idempotent pattern `seedSystemRules`,
`bootstrapAllTenants` and `seedSystemRiskRules` already use in `server.ts`. The seed file
becomes the source of truth and reconciles itself. The deploy that ships this also performs the
data repair, so there is no manual insert to forget — and the next action added is live on
deploy rather than whenever someone remembers the script.

`create_contact` came with it unavoidably, so its stale `POST /entities` capability handle was
re-pointed onto the real action type; otherwise it would have rendered twice, once undescribed.

### Why the existing guard could not have caught this

`capabilityDiscovery.test.ts` compares the seed file with `COMPOSER_DISPATCHED_TYPES` — **file
against file. Nothing compared the file with the database.** The suite was green for the entire
period both capabilities were invisible. Worth Codex's attention: it is a whole category of
defect this repo's tests are structurally blind to.

### Verification — re-run after the last edit, from `server/`

```
npx tsc --noEmit    exit 0, no output
npx vitest run      Test Files  163 passed | 1 skipped (164)
                    Tests  1888 passed | 7 expected fail | 21 skipped | 1 todo (1917)
npm run build       exit 0
git diff --check    exit 0
```

**Delta reconciliation (D-3).** Baseline before my edits, measured this session: 162 files /
1878 passed / 1907 total. Now 163 / 1888 / 1917 — **+1 file, +10 passed, +10 total**. That is
9 tests in the new file plus 1 net in `capabilityDiscovery.test.ts` (one assertion removed from
an existing test, one new `it` added). Every number accounted for; no pre-existing test changed
state.

**Mutation: 5 of 5 killed** — drop `preApproved`, skip an action in the loop, remove the boot
wiring, revert the contact handle, stub the contact description.

### What I did NOT do

- **D-1 (benchmark teardown) — not built, and I owe the reason.** One coherent change per turn,
  and the owner's direct handoff ranked DEF-130 first. It is not currently causing harm: the
  loop is stopped, so nothing is minting rows right now. I confirmed the orchestrator's partial
  teardown attempt is **no longer in the tree** — it reverted its own edit, correctly, under the
  ruling that it does not implement. So D-1 is unbuilt and mine. **It is my next build**, and I
  accept the shape argued in the directive, including that a write to a pre-existing row is
  reported as unrevertable rather than cancelled.
- **`cmsotakwf0006rts1bdsrjjkj` — not touched.** The directive asks for a deliberate call on the
  row iter-00 created and iter-01 edited. I did not make it this turn because it needs the same
  read-back discipline as any live change and belongs with the teardown build.
- **Did not deploy.** D-2 holds `32ba427` for Codex review and the owner's word, and its
  migration `20260811b` is confirmed unapplied (`_prisma_migrations` queried). A restart would
  activate that code. DEF-130 is therefore **PARTIAL, not verified**.
- **Did not touch the benchmark or the judge.** No edit to `nexeoCapabilityBenchmark.ts` or
  `brainResponseEvaluator.ts`.
- **Did not add an evaluation-chart row** — no deploy this turn.

### What I am unsure about

- **Whether the boot hook is proven.** It is not, by behaviour. Every behaviour test here passes
  whether or not anything calls the seeder — the exact shape of the defect itself. `server.ts`
  calls `app.listen` and cannot be imported in a unit test, so the wiring rests on a source-text
  assertion, labelled weak in the test. If Codex sees a way to prove it properly, I want it.
- **Boot-time writes.** 18 upserts on every restart is small and matches three existing seeders,
  but it does mean a hand-edited `action_definitions` row is reverted to the file on restart.
  I consider that correct — the file is the source of truth — but it is a behaviour change for
  anyone who edited a row through the database, and it deserves a second opinion.

### Prediction, and what would falsify it

**C5 (authorized action) should rise once this is DEPLOYED; nothing should move before then.**
The mechanism is that two capabilities enter the truth-table, so any benchmark case asking for
a removal or a contact save should stop being refused.

**What would prove me wrong:**
- Deployed, and a removal request is still refused → the truth-table was not what suppressed it,
  and the next place to look is `reasoningCompose`'s action list versus the block for precedence.
- C5 rises but C2 (grounding) or C6 falls → advertising two more actions made Brain act where it
  should have asked. The removal path is destructive-ish, so over-eager removal is the
  regression I would most expect.
- The registry still shows 16 rows after a restart → the boot hook does not run in production,
  and the source-text supplement was worth exactly what the working rules say it is worth.

---

## Iteration 2 (loop restart) — mode: incremental

> **Heading numbers collide, and I am not renumbering someone else's entry.** The
> `## Iteration 2` section above is the out-of-band DEF-130 build, written before the
> orchestrator restarted and numbered 2 by the seat that wrote it. The loop's own counter
> also calls this turn 2 (`loop.log`: `──────── iteration 2 ────────`), and the ledger row
> for this turn will say 2, so renaming mine would desync it from the ledger. This is the
> loop's iteration 2; that one is not.

**Gating criterion: C6 @ 84.6** (completeness — the whole instruction handled).
Overall 90.1 at HEAD `6c5978b`. Note this is the RESTART baseline, re-measured
today; it is not comparable to iteration 1's post-build 95.6/89.6, which was
measured yesterday at `518475e`. C4 is now 85.8 and no longer the minimum.

### The fix queue entry I targeted

The queue is 31 entries, and **one case owns the top six**. Quoting them:

> **B12-reminder-referent, C6 = 0** — "The response completely fails to handle
> the user's instruction (a question). It pivots to a completely different,
> unasked-for topic about routing and then asks for a new task, ignoring the
> user's current need for an explanation."

> **B12, C3 = 0** — "Brain completely ignores the user's question, 'Why did you
> remind me about that one twice?', and instead provides an irrelevant
> explanation about routing and channels."

> **B12, C7 = 10** — "Brain does not truthfully explain its repeated reminder.
> Instead, it fabricates a reason about routing that has no basis in the
> conversation."

plus C1 = 20, C2 = 20 ("The mention of 'Nexeo' and 'channel' is ungrounded"),
C5 = 20. B12 scored **29 overall**. The next-worst C6 entry is B04 at 70.

**Expected to move: C6.** Nothing else is targeted.

### What the reply actually was, which is the whole story

The report only stores the final answer, so I read the benchmark's own log.
`docs/orchestrator/logs/iter-01-bench-baseline.log:196-201`:

```
[brain-chat] validateBeforeRender block {
  rules: [ 'fabricated_process' ],
  originalHead: "I can see that, Sir. My apologies. It looks like a bug caused the same overdue reminder job to run twice. I've logged th"
}
BELOW  B12-reminder-referent      overall= 29  worst=C3:0
```

Brain **answered the question, correctly, and owned the mistake.** The user got
none of it. The whole reply became `answerSanitizer.ts:82`, the curated meaning
of the fabricated-escalation marker: *"I can't route to a team like that — Nexeo
doesn't have that channel. What concrete task should I do instead?"* — 108
characters, which is that string's exact length. The judge's "invented Nexeo and
channels" is not a hallucination by the model; **it is our own hardcoded string**,
and the judge diagnosed it blind: *"a pre-programmed error message triggered by a
keyword that wasn't even present"*.

I could not recover the truncated tail, so I checked which half tripped the rule:
the logged head does **not** match `FABRICATED_PROCESS_RE`, so the match is in
the tail — almost certainly "logged this with the engineering team". **The guard
fired correctly.** There was a real fabrication. That single finding is what
changed the fix from "narrow the guard" to "change the remedy".

### Governing-docs verdict, before coding: CIRCLING

Not progressing, and the chart says so in its own words. §3 carries
**`guard-destroys-the-answer`, 4 occurrences in one day (2026-08-10)** — DEF-107
(×2 live), DEF-114, DEF-113 — described as: *"Brain reasoned CORRECTLY and the
answer was destroyed on the last hop … all replaced by a 107-character canned
denial — identified by `answerLen=107` matching the canned string's exact
length."* B12 is an apology destroyed on the last hop with `answerLen=108`. It is
**occurrence 5**, logged as **DEF-135**.

Per `CLAUDE.md` rule 5, circling requires a structural fix, never another patch
on the reported instance. The recorded containment failed for a specific,
checkable reason: it reads *"every **empty-promise** change must … fail CLOSED on
unknown intent"* — scoped to one rule. `fabricated_process` is the rule
immediately below `empty_promise` **in the same function** and inherited none of
it. DEF-107/113/114 each narrowed **eligibility**; that requires the intent
classifier to be right every time and has now failed five times.

### What I changed, and why that is the mechanism

The remedy, not the detector. `FABRICATED_PROCESS_RE` is byte-for-byte unchanged.

**1. `responseValidator.ts:43`** — `salvagedAnswer` on `ResponseViolation`,
preferred over `suggestedReplacement`. The old interface offered a `block` rule
exactly one remedy: replace everything. `brainAskRoutes.ts:180` is
`result.answer = validation.replacement`, so one bad clause costs every true
sentence beside it.

**2. `responseValidator.ts:106`** — `exciseSentencesMatching(answer, re)` removes
only the sentences that trip the rule. Line structure is preserved, so a bullet
list survives losing one bullet and no blank gap is left behind.

**3. `responseValidator.ts:307-334`** — rule 2 attaches the salvage.

**4. `responseValidator.ts:477`** — the salvage is used **only when its rule is
the sole block**. Two blocking defects means the remainder still carries the
second one, and the marker is right.

**5. `brainAskRoutes.ts:183`** — log `salvaged:`. The `originalHead` line is the
only reason this defect was diagnosable; which remedy ran should be visible too.

**Why this is structural rather than a patch:** the excision primitive is
rule-agnostic and fail-closed in four ways — nothing matched, under 40 chars
survive, the remainder still trips the rule, or a second block fired. The third
exit earns its place: `\s` in these rules matches a **newline**, so "engineering"
ending one line and "team" opening the next matches the rule while neither line
matches alone. Per-sentence filtering provably cannot see that; the recheck can.

**`FABRICATED_PROCESS_RE` is now exported** so the tests drive the real rule. A
copy in the test file would have been an eighth instance of
`protection-with-two-implementations` — the tag with 7 occurrences, one of them
authored inside a change whose stated purpose was consolidation.

### Verification — re-run after the last edit, from `server/`

```
npx tsc --noEmit    exit 0, no output (clean)
npx vitest run      Test Files  164 passed | 1 skipped (165)
                    Tests  1905 passed | 7 expected fail | 21 skipped | 1 todo (1934)
                    Duration 20.73s
npm run build       exit 0 (prisma generate + tsc)
git diff --check    exit 0, no output
```

**Accounting, reconciled — directive D-3 and Codex finding #4.** I measured the
baseline instead of asserting a delta. Existing suite with my source changes in
place, my new file excluded: **163 passed | 1 skipped (164) files; 1888 passed, 7
expected fail, 21 skipped, 1 todo (1917 collected)** — zero failures, so no
pre-existing test changed state. My file alone: **1 file, 17 tests, 17 passed.**
163 + 1 = 164 files ✓ · 1888 + 17 = 1905 passed ✓ · 1917 + 17 = 1934 collected ✓.
17 source `it(...)` declarations, 17 collected, +17 to the suite — no collection
expansion, and I am reporting the three numbers separately as directed.

**Mutation results: 6 of 6 mutants die.** Drop the salvage from the outcome; drop
the sole-block guard; drop the fail-closed recheck; drop the length floor; drop
the global-regex guard; keep a line whose every sentence was cut. **Two of my
tests were wrong on the first pass and I only found out by running the mutants** —
the recheck test was being satisfied by the length floor, and the length test by
the two-block fallback. Both passed while proving nothing, which is exactly the
failure Codex flagged in iteration 1. Rewritten until the mutants actually died;
the newline-boundary case is the test that now kills the recheck mutant. The file
was restored byte-identical after each mutation (`diff -q`, verified).

### Codex's directive — followed in part, and where not, why

Codex's ranked directive #1 was to unify answer finalisation into one chokepoint
so the reasoning early return at `brainComposer.ts:2496` cannot bypass DEF-134.
**I did not do that this turn.** The reason is the loop's own gating rule, not
disagreement: the score was re-measured at a new HEAD and **C4 is no longer the
minimum** (85.8); C6 at 84.6 gates, and directive #1 targets C4. Codex's own
directive #3 says to re-run the benchmark before broadening style work and then
take residual mechanisms in priority order — the re-run happened, and it moved
the gate. Directive #1 remains, in my judgement, the highest-value **C4** work
and it is still owed; B07/B08/B10/B11 keep their bare openers until it is done.
I judged one C6=0 case worth more than four C4=85 cases this turn.

Directive #2 (test the real path, not the helper; include a mutation proving the
integration test fails) I did follow, on this change: every user-visible
assertion goes through `validateBeforeRender`, and mutant M1 proves it.
Directive #4 (verification accounting) is done above.

**Operator directives.** **D-1 (benchmark writes to the live backlog) — not done
this turn**, deliberately: it is a change to the measurement harness while I am
being measured, and it is unrelated to C6. It is real and I am not dismissing it;
`openItemsBefore/After` was **283 → 283** this run, so nothing new was minted,
consistent with the self-limiting effect D-1 predicts. **D-2 (Codex review owed
on `32ba427`, and applying `20260811b`) — not mine to close**: it asks for a
review and a deploy, and this seat does neither. **D-3 — done**, above.

### What I did NOT do

- **Did not touch the benchmark or the judge.** No edit to
  `nexeoCapabilityBenchmark.ts`, `brainResponseEvaluator.ts`, or the gate
  arithmetic. The 12 cases and the rubric are as they were.
- **Did not weaken any detection rule.** No regex changed. Every sentence that
  tripped `fabricated_process` before still trips it and is still removed from
  what the user sees.
- **Did not opt `empty_promise` into salvage**, though the same mechanism would
  fit it and it is the rule behind three of the five occurrences. It is the most
  heavily-tested rule in the file, invariant §5 names it explicitly, and DEF-041
  — a false statement sent to a real person — is its incident. It deserves its
  own turn with its own evidence, not a ride on this one. **So the class is not
  closed**, and I have written that into §3 rather than claiming the tag shut.
- **Did not fix B04** (C6 = 70, the second-worst C6): Brain set the priority and
  never mentioned the deadline it was also asked for. Different mechanism —
  nothing was destroyed, the answer was genuinely half-done. It is the next C6
  target if DEF-135 does not clear the gate.
- **No `brain_chat_log.md` CL row and no `brain_chat_archive.md` entry.** B12 is
  a benchmark case, not a chat the owner sent, so there is no chat to log and no
  `chatN` scenario to pair. The archive-sync meta-test is unaffected (green).
- **No evaluation-chart deploy row** — there is no deploy this turn.

### What I am unsure about

- **Whether C6 moves as much as the arithmetic suggests.** B12's C6 = 0 across 12
  cases is ~7 points of the 84.6. If the salvaged answer scores like the head
  reads, C6 should land near 91. But the salvage is three sentences with the tail
  cut, and the judge may mark it incomplete for stopping abruptly — the fix
  removes a fabrication, it does not add the honest ending the model should have
  written. A partial recovery is the outcome I would actually bet on.
- **The tail is inferred, not read.** The log truncates at 120 characters. I
  verified the head does not match the rule, so the match is in the tail, and my
  test restores it as "I've logged this with the engineering team to investigate."
  That reconstruction is a reasonable inference, **not** evidence. If the real
  tail matched via `escalating this to` instead, the diagnosis is unchanged but my
  test's B12 string is not the production string.
- **40 characters is a made-up floor.** It is a judgement about when a remainder
  stops being an answer, not a measured threshold.
- **Sentence splitting is naive.** "Dr. Khan" or "e.g." will split mid-sentence.
  The consequence is bounded — a fragment gets dropped or kept as its own unit —
  but it is not linguistically correct, and a decimal in an answer ("increase of
  4.5%") splits too. I chose the simple splitter over a dependency; if that shows
  up in a real answer it will need revisiting.
- **This may reveal the fabrication rate rather than fix it.** If Brain often
  appends invented escalations, salvaging makes the honest part visible while the
  underlying habit continues. The prompt-side question — why does it reach for a
  nonexistent engineering team at all — is untouched, and it is the more
  interesting defect.

### Prediction, and what would falsify it

**C6 should rise from 84.6, and C3/C7/C1/C2/C5 should rise with it**, because all
six were scored down on the same destroyed reply. That coupling is the strongest
prediction here: this change either moves six criteria on one case or it moves
nothing, and a scattered result means I am wrong about the mechanism.

**What would prove me wrong:**
- **C6 flat and B12 still ~29** → the block is not what produced the reply I
  think it produced; the marker path is not the only way that answer could arise,
  and I would need the untruncated answer before touching this again.
- **B12 recovers but C6 stays under 90** → B04's half-answered instruction is the
  real weight in C6, not B12, and the arithmetic above over-credited one case.
- **B12's C6 rises while C7 (truthfulness) does not** → the salvaged answer reads
  as evasive rather than honest, which would argue for regenerating the answer
  instead of excising from it.
- **Any case that previously passed now scores lower on C1/C7** → salvage shipped
  prose it should not have, and the sole-block guard is too permissive.
- **A `salvaged: true` log line on a turn whose answer reads truncated** → the
  excision is cutting load-bearing sentences and the floor is too low.

---

## Iteration 3 — mode: incremental

**Gating criterion: C4 @ 85.4** (human voice). Overall 94.8. C4 has now gated
**three consecutive measurements — 84.8, 85.8, 85.4** — and Codex's chokepoint
directive was owed for the second time. Another patch on one call site would be
circling, and the recurrence table already says so in as many words.

### The directive and fixQueue entries I targeted

Codex, iteration 2, directive #1 — quoted in full because it is the whole brief:

> Execute the still-owed Iteration 1 directive in
> `server/src/services/knowledge/brainComposer.ts`: create one user-visible prose
> finalisation chokepoint and route both the reasoning return near line 2496 and
> the legacy tail return through it. Add compose-level tests for both
> implementations. Required outcome: B06/B07/B08 and every other reasoning answer
> can no longer bypass preferred-address frequency handling; do not solve this by
> deleting the user's configured honorific globally.

The matching fixQueue entries, verbatim:

> **B07-compound-ask, C4 = 85** — "the opening **'Sir,'** feels a little formal and
> template-like in an otherwise conversational interaction."

> **B06-just-do-it, C4 = 90** — "'Sir' is a bit formal, but acceptable within a
> professional assistant context."

> **B08-bad-news, C4 = 90** — "The use of 'Sir' is a small detail that could be
> more natural if omitted."

Ten of the twelve C4 entries name the honorific. **But I read the answers rather
than the summaries, and the fixQueue does not say what it looks like it says** —
see the prediction section. Most of those ten are NOT bare openers.

### On D-4, which argues it should have gone first

D-4 says the measurement cannot yet distinguish a gain from noise, and it is
right. I did not reorder it ahead of this turn, for three reasons stated so the
choice is reviewable: the operator file itself ranks Codex's directive first;
D-4's own text defers to the owner (*"Ranked FIRST once the owner confirms"*) and
requires D-1 to land before it, so it is a two-turn job I cannot start and finish;
and this iteration's change is one whose value does **not** depend on the score
moving — it closes a bypass that is demonstrable from a test, not from a
measurement. If the owner confirms D-4, it should take the next turn, and I would
argue it should take it before directive #2.

### Governing-docs verdict, before coding: CIRCLING

Not a judgement call this time. `guard-below-early-return` is already in chart §3
with two occurrences (DEF-035, DEF-039, plus DEF-041 in spirit), and its recorded
containment reads *"no further patch in this class is acceptable — the
decomposition is the fix."* DEF-134 then put a guard in the legacy tail, ~1,820
lines below the reasoning gate's early return, and reasoning is the default path.
So the guard was dead on arrival. I logged this as **DEF-136** and updated the
tag to 3, with the row marked CIRCLING rather than progress.

The part of the shape worth adding to the record: **the tests were written against
the helper the live path skips.** `def134BareVocativeOpener.test.ts` had 19 green
tests across three benchmark runs and zero coverage of the exit that actually
returns. Codex made exactly this point about DEF-135 one iteration later — *"every
test invokes `validateBeforeRender` directly; none calls `answerAsBrain`"* — while
the same weakness had already shipped here one iteration earlier.

### What I changed, and why that is the mechanism

**1. `brainComposer.ts:2083` — `finaliseUserVisibleProse(answer, persona)`, new.**
Holds both address rules in one place: WHICH form of address (the 2026-05-20
greeting normaliser) and how OFTEN (`stripBareVocativeOpener`, DEF-134). Takes a
structural `AddressPersona` (`:2046`) so both of compose's persona values satisfy
it without a cast.

**2. `brainComposer.ts:4374` — the legacy tail calls it.** The ~46 lines of inline
guard are deleted, not duplicated. Position is unchanged: still above the
empty-promise guard, which must see the text the model actually produced.

**3. `brainComposer.ts:2592` — the reasoning exit calls it.** This is the bypass.

**All four of compose's prose-carrying exits are accounted for**, because "how many
exits are there?" is the question this class punishes you for not asking:

| Exit | Carries | Finalised? |
|---|---|---|
| reasoning ask/answer/decline (`:2592`) | persona prose | **yes — new** |
| legacy / final return (`:4374`) | persona prose | yes |
| completion intercept (`:2573`) | bracketed marker by construction | no, deliberately — not prose; `answerSanitizer` renders it |
| action preview (`:3421`, text built at `:3329`) | `renderActionPreview` output | no, deliberately — a deterministic rendered artifact. **This is where B04's `priority=high` comes from**, and it is Codex's directive #3, not this turn |

**4. `tests/def136ProseFinalisationChokepoint.test.ts` — 19 tests, 8 of which drive
the real `compose()`.** Reasoning is reached by mocking `reasoningCompose` +
`reasoningCompose.applyDispatch`; legacy by mocking `callLLM`. The question is >60
chars on purpose, so compose's early-confirm pending lookup (short replies only) is
skipped and the test stays on the path under test.

### Verification — re-run AFTER the last edit, from `server/`

```
npx tsc --noEmit    exit 0, no output (clean)
npx vitest run      Test Files  165 passed | 1 skipped (166)
                    Tests  1924 passed | 7 expected fail | 21 skipped | 1 todo (1953)
                    Duration 17.79s
npm run build       exit 0 (prisma generate + tsc)
git diff --check    exit 0, no output
```

**Delta, measured rather than asserted** (D-3). I ran the suite three ways:

| Tree | Files | Tests |
|---|---|---|
| HEAD `f4d9ec5`, clean | 164 passed / 165 | 1905 passed / 1934 |
| my source edits, my test file removed | 164 passed / 165 | 1905 passed / 1934 |
| everything | 165 passed / 166 | 1924 passed / 1953 |

So: **+1 file, +19 tests, all mine, and no pre-existing test changed state** — the
middle row is the evidence for that second claim, not an assumption. The baseline
was measured by `git show HEAD:…` into place and restored afterwards.

### Mutation — 4 mutants, 3 die, and the survivor changed the source

- **Remove the reasoning-exit call → 5 tests fail.** The bypass is real and covered.
- **Remove the legacy-exit call → 2 tests fail.** This mutant **survived my first
  version**: with only the reasoning live-tests written, all 35 tests stayed green
  with the legacy call deleted. That is the same helper-vs-live-path hole one layer
  over, so I added the three legacy `compose()` tests and re-ran it. Recorded
  because it was a real gap in my own work, found by mutation and not by reading.
- **Remove the first-name fallback → 1 test fails.**
- **Swap the two rules' order → NOTHING fails, and the mutant is correct.** I had
  written that form-before-frequency was load-bearing. It is not: the form rule
  anchors on a greeting followed by the user's NAME, the frequency rule on the
  PREFERRED TOKEN at position 0, and the form rule always emits
  `<greeting><sep><address>`, which is never a bare opener. Neither can create or
  destroy the other's match. **I removed the false rationale from the docblock and
  replaced the ordering test with an interference test**, rather than inventing an
  assertion to defend a claim that was wrong.

### What I did NOT do

- **Did not touch the benchmark or the judge.** No edit to
  `nexeoCapabilityBenchmark.ts`, `brainResponseEvaluator.ts`, or
  `calibrateResponseJudge.ts`.
- **Did not touch `scripts/orchestrator/**`.** Codex's directive #5 and the
  orchestrator's own instruction. This commit is two files: one source, one test,
  plus the two governing docs. `server/docs/orchestrator/state/capability_scorecard.json`
  is modified in the tree by the orchestrator, not by me, and is **not staged**.
- **Did not touch the persona examples** — `Anytime, ${addressAs}`,
  `Morning, ${addressAs}` and the apology/identity shapes at
  `brainPersonaService.ts:210-219` still teach frequent address, and they are
  Codex's directive #2. That is deliberate sequencing, not an oversight: #2 is
  where most of the remaining C4 address loss actually is (below), but mixing it
  with #1 would make the score move unattributable, which is the one thing this
  loop cannot afford.
- **Did not touch B11's canned capability denial or B04's `priority=high`** —
  directive #3, and the preview exit above is where the second one enters.
- **Did not deploy.** The loop owns `pm2 restart`.
- **Did not add an evaluation-chart §2 deploy row** — there is no deploy this turn.
  §3 is updated because a recurrence is a recurrence whether or not it ships.
- **Did not add a `brain_chat_log.md` row.** No owner chat arrived this session;
  this defect came from the fixQueue. A CL row for a benchmark finding would be a
  fabricated observation.
- **Did not fix an unrelated defect I found while investigating** (below).

### Prediction, and what would falsify it

**I predict C4 moves very little — possibly not at all beyond noise — and I want
that on the record BEFORE the measurement rather than after.**

Here is why, and it is the thing the fixQueue hides behind a word count. DEF-134
had two halves, and **only the guard half was dead. The prompt half was live all
along** — reasoning builds its system prompt from
`personaForReasoning.systemPreamble` (`:2420`), so the persona rewrite reached
production on 08-11 and is most likely what moved C4 from 84.8 to 85.8. What this
turn restores is the structural backstop for the cases the prompt does not
suppress. Reading the twelve C4 answers rather than the ten summaries: **B07 is the
only clear bare-vocative opener left.** The rest are non-opener honorifics —
`"Sorry, Sir"` (B02), `"My apologies, Sir"` (B12), `"I'm Suzi, Sir."` (B09),
`"…referring to, Sir?"` (B01) — and `stripBareVocativeOpener` is anchored at
position 0 by design, so it does not touch a single one of them. Those are
directive #2's, at the generation mechanism.

So the honest claim for this turn is **structural, not numerical**: a protection
that could not run now runs on both prose exits, and it is pinned by tests that
fail when either call site is removed. If C4 moves 1–2 points I will not call that
a win, per the standing rule.

**What would prove me wrong, in either direction:**
- **C4 jumps 5+.** Then bare openers were far more common in the live answers than
  the twelve benchmark replies show, and the guard was carrying more weight than I
  credit it with. Good news, wrongly predicted.
- **C4 falls.** Most likely cause: the guard now fires on reasoning answers where
  the leading vocative was doing real work — softening bad news (B08) or opening
  the day (B05/B10) — and stripping it reads as curt. C8 (persona, 98.8) and C5
  (proactivity, 93.3) are where that would surface first.
- **C4 flat AND the residual reasons stop mentioning openers.** That is the
  outcome I actually expect, and it is the one that hands directive #2 a clean
  target: whatever `Sir` complaints remain would then be provably non-opener, so
  the persona-example fix can be attributed on its own.
- **Any case's answer comes back mangled** — a stub, a lost capital, a stripped
  greeting. Then the chokepoint is over-reaching on real traffic in a way 19 tests
  did not catch, and it should be reverted rather than tuned.

### One unrelated finding, logged and NOT acted on

While reading the capability block before this iteration (owner's DEF-130 method:
read what is actually sent before changing anything) I found that
**`remove_open_item` and `create_contact` have no rows in the production
`action_definitions` table** — 16 rows against 18 seeded types. `classifyCapability`
fails closed, so both are absent from the CAN list *and* the degraded list, which
means Brain's *"I don't have the capability to delete open items directly"* is not
a description defect at all: **it is Brain correctly reading a capability block
that does not contain the capability.** DEF-106 edited the prompt text and the
registry description, so it could never have worked. `create_contact` is the same
row that was reported missing on 2026-07-07 as *"I can't add contacts"*, cited in
`brainCapabilityLive.ts:6`, still absent 36 days later. The seed pre-approves
(`registerAction(..., preApproved: true)`), so re-running it on production is
plausibly the whole fix — but it is a production data change on a live registry,
it is not C4, and it is not mine to ship inside a C4 attribution window. Flagged
here and to the owner; it needs its own turn.

---

## Iteration 4 — mode: incremental

**Gating criterion: C4 @ 86.3** (human voice). Overall 95.5 — every other
criterion is at or above 94.6, so C4 alone is the gate. Two changes this turn,
both on address, in Codex's order: **DEF-137** (the correctness regression my own
DEF-136 exposed) and **DEF-138** (the generation mechanism).

### The fixQueue entries I targeted

Nine of twelve cases score 80–85 on C4, and eight name the honorific. Verbatim:

> **B07-compound-ask, C4 = 80** — "the opening **'Good afternoon, Sir'** and the
> slightly formal phrasing … make it lean a bit towards a template."

> **B06-just-do-it, C4 = 85** — "The phrase **'Certainly, Sir'** is a bit overly
> formal and template-like for a human assistant."

> **B05-warmth, C4 = 85** — "The greeting **'Morning, Sir.'** is a little stiff and
> overly formal … It could be more natural, e.g. 'Good morning, sir,' or simply
> **'Morning.'**"

> **B12-reminder-referent, C4 = 85** — "The phrase **'My apologies, Sir.'** is a
> little formal."

I traced these to their source rather than treating them as tone. **Two of them are
persona style examples coming back almost verbatim.** `"thanks"` → *"Anytime,
${addressAs}."* is B06's parent; `"how's my day looking?"` → *"Morning,
${addressAs}. …"* is B05's, and the judge's proposed repair (*"or simply
'Morning.'"*) is now literally what the example says.

### Governing-docs verdict, before coding: CIRCLING, and I can name why

Third iteration on the same criterion with the same complaint. DEF-134 wrote the
correct rule; DEF-136 made its backstop reachable; **C4 moved 84.8 → 86.3 across
both, about 1.5 points.** The reason is not that either fix was wrong — it is that
neither touched the thing the model actually imitates.

The persona says *"addressing them is OPTIONAL, most replies should skip it …
more than about one reply in four reads as a template."* Sixty lines below it,
**four of eight style examples addressed the user — 50%, exactly twice the stated
ceiling** — two of them on wholly ordinary turns. In a prompt, examples are the
strongest instruction in the file. The rule was outvoted by its own
demonstrations, and it read as satisfied during review because the prose said the
right thing.

New chart §3 tag: **`examples-outvote-the-instruction`**, and its containment is
the part I actually care about — *any prompt rule stating a frequency or a ceiling
must have that ceiling asserted over its own examples in CI.* Prose loses to
demonstrations; a counted ratio does not.

I also checked the third address source before touching anything: the DB
`communication_contract` block mentions the address **once**, as a prohibition
(*"never open with 'Of course {{addressAs}}!'"*). Not part of the budget, left
alone — and worth noting that B06's *"Certainly, Sir"* is that prohibition's exact
shape with a different adverb, so a literal blocklist would not have caught it.

### What I changed, and why that is the mechanism

**DEF-137 — `brainComposer.ts:2119-2145`.** The form normaliser matched
`greeting + name` **anywhere**, with the `g` flag, while its own comment claimed it
only touched *"direct ADDRESS in an opener"*. The comment described an anchor the
code never had. Harmless for 12 weeks because it only ran on the legacy tail —
**DEF-136 pointed the default reasoning path at it and made it reachable**, so a
reasoning answer quoting `Hamna wrote: "Hi Basit Ahmed, the repository is ready"`
had the QUOTE rewritten and Brain misquoted evidence it was citing. Now anchored
at position 0, non-global.

Worth recording as a shape: **a change that correctly widens a guard's reach also
widens the reach of every bug inside it.** The precision has to be re-earned at
the new blast radius, not inherited.

This also inverted the rule order, and that part is a straight correction of my
own last entry. DEF-136 tested and recorded that form/frequency were
order-independent — true of an unanchored regex. **Anchoring creates the
dependency:** `"Sir, hi Basit Ahmed — your 3pm moved"` only exposes its greeting at
position 0 once the bare vocative is gone. Frequency runs first now, the docblock
says why, and a mutant proves it.

**DEF-138 — `brainPersonaService.ts:52-146` and `:243-244`.** `STYLE_EXAMPLES` is
data. Each example declares *why* it addresses the user (`AddressWarrant`), and
`renderStyleExamples` emits the identical `User:`/`You:` shape — **the format is
unchanged, only the rate.** `"thanks"` → *"Anytime."*; the day brief keeps its
greeting and drops the honorific.

**Two examples keep the address deliberately** — pushing back on shipping
untested, and a cross-user data leak. Those are two of the three contexts the rule
names, and Codex's constraint was explicit: preserve the configured form where
address is genuinely useful, not purge it. 2/8 is the stated ceiling exactly.

**`brainPersonaService.ts:151-152`** — the form rule stopped demonstrating the
address three times while claiming only to settle which form ("Hi X", "Morning, X",
"Anytime, X" → one example, plus *"This rule settles WHICH form to use if you use
one. It is not a suggestion to use one."*). The frequency rule now names the reflex
shapes the judge flagged — apology-, identity-, thanks- and agreement-plus-title —
so **frequency is the model's judgement, not a regex's.** No new stripping.

### Verification — re-run AFTER the last edit, from `server/`

```
npx tsc --noEmit    exit 0, no output (clean)
npx vitest run      Test Files  166 passed | 1 skipped (167)
                    Tests  1947 passed | 7 expected fail | 21 skipped | 1 todo (1976)
                    Duration 17.89s
npm run build       exit 0 (prisma generate + tsc)
git diff --check    exit 0, no output
```

Delta against iteration 3's 165 files / 1924 passed (1953): **+1 file, +23 tests**
— `def136` grew 19 → 24 (DEF-137's five), `def138` is 18 new. No pre-existing test
changed state.

### Mutation — 4 mutants, all 4 die

- **Restore the unanchored global regex** → the 3 quoted-evidence tests fail. That
  is the bug itself, reproduced on demand.
- **Run form before frequency** → the ordering test fails. This is the assertion
  DEF-136 could not make honestly and now can.
- **Re-add an address example on an ordinary turn, declared warranted** → 4 fail:
  the ratio, the warrant set, the retired shape, and the count over the RENDERED
  preamble.
- **Mislabel an addressing example as `none`** → 3 fail. The classification cannot
  lie about itself.

### What I did NOT do

- **Did not touch the benchmark, the judge, or the gate.** No change to
  `nexeoCapabilityBenchmark.ts`, `brainResponseEvaluator.ts`,
  `calibrateResponseJudge.ts`.
- **Did not touch `scripts/orchestrator/**`.**
- **Did not add a broader destructive regex.** Codex's constraint, and the reason
  DEF-138 is a prompt change with a CI-enforced budget rather than a second
  stripper. `stripBareVocativeOpener` is untouched and still anchored at position 0.
- **Did not take directives #3 or #4** (B04's `priority=high` renderer; B12's
  unverified duplicate-reminder cause). They were not smaller than expected — #1
  turned out to have a third prompt source to audit and a data refactor, and #2 was
  a correctness bug in my own previous change. #4 is the highest truthfulness risk
  in the report (C1 = 80) and I would take it next over more tone work.
- **Did not reorder D-4 ahead of this turn** — same reasoning as iteration 3, and
  it still needs owner confirmation plus D-1 first. **But the owner's chat log this
  session has overtaken it as evidence** (see below), and I would now argue D-4
  matters more than any remaining C4 point.
- **Did not deploy.**

### Prediction, and what would falsify it

**C4 should move more than it did in either of the last two turns, because this is
the first change aimed at the thing the model imitates rather than the thing it is
told.** B05 and B06 are the two clearest tests: their offending phrases were
demonstrations, and the demonstrations are gone.

**What would prove me wrong:**
- **C4 moves ≤ 2 again.** Then the honorific was never the dominant cost and the
  judge's repeated mention of it is incidental to phrasing it dislikes for other
  reasons — B08's *"a reply came in from an unknown number that was not surfaced to
  you"*, B12's *"flagged the item at the same time"*, B01's *"items delegated to
  her"*. Those are passive/technical register, not address, and they would then be
  the target.
- **C4 rises and C8 (persona, 99.2) falls.** Reducing demonstrated address cost
  something real about consistent character. C8 is the criterion to watch.
- **B05 or B10 lose points.** The day-brief greeting was kept on purpose; if
  removing only the honorific reads as curt, the example needs the full
  *"Good morning"* rather than *"Morning."*
- **Any case quotes an inbound message and the quote is wrong.** DEF-137 would
  have failed at exactly the thing it claims to fix.

### The owner's chat log arrived mid-turn, and it changes what I think matters

Logged as **CL-033** with four defects (DEF-139…142). I am not folding it into this
commit — different surface, and attribution stays clean — but the loop should know
what it says, because one line of it outweighs this iteration:

**Nexeo's own self-evaluation reported a live reply scoring 29/100, worst C3 = 0,
while this benchmark reports 95.5 overall.** The benchmark's twelve cases are not
representative of live traffic. Related: **14 of the 19 owner-facing messages in
that log are proactive notifications that never pass through `compose` at all** —
so DEF-134, DEF-136, DEF-137 and DEF-138, every C4 fix in this loop, cannot reach
the text the owner actually reads most of. One of those notifications addresses him
as *"Basit,"* — ignoring the preferred form this loop has spent four iterations
refining — which is direct evidence that `finaliseUserVisibleProse` is a chokepoint
for `compose`'s prose only, not for user-visible prose.

---

## Iteration 5 — mode: incremental

**Target: DEF-140**, Codex's ranked directive #1 — the live proactive surface,
not the compose gate. C4 stands at 89.6 from iteration 4 and I did not touch the
compose path this turn, so **I predict the twelve-case benchmark barely moves.**
That is the intended outcome, not a miss; see the prediction section.

### The directive, and the one place I deviated from it

> Start DEF-140 with an inventory, not a patch … Then introduce one
> provenance-aware owner-message rendering boundary that receives the resolved
> preferred address once and applies address policy only to Brain-authored
> prose. Do not add `finaliseUserVisibleProse` independently to each producer or
> blindly to `sendTenantWhatsAppText`.

I did the inventory first, and **the inventory changed the diagnosis**, so I built
the boundary *plus* something Codex did not ask for and put it first. Stating the
deviation plainly so it can be judged:

**The root cause is not "the rules live in `compose`". It is that there were TWO
resolvers for how to address this person.** `brainPersonaService` honours
Settings → Profile → preferredTitle. `brainHumanComm.addressUser` read
`user.name` and took the first token. The owner has "Sir" set; his draft ask said
"Basit,". That is `protection-with-two-implementations`, **8th occurrence**, and
the 2026-05-20 fix for this precise complaint landed in the resolver his phone
does not use.

So the first change is at **composition** time: `addressUser` delegates to
`persona.addressAs`. Supplying the right token when the message is BUILT cannot
corrupt anything. Rewriting finished text can, and we have the receipt — DEF-137
was a cosmetic rewrite that misquoted evidence, found in review by luck. A
rendering boundary is the right second layer and the wrong only layer.

### The inventory

Owner-visible text comes from **66 producer call sites** (21 × `brainContactsUser`,
45 × `enqueueBrainPrompt`) across 33 files, over **two** dispatch routes.

| Producer | Content class | Reaches the owner via |
|---|---|---|
| `compose` replies | Brain prose | `brainAskRoutes` → `finaliseUserVisibleProse` (already) |
| `phraseDraftAsk` — `openItemDraftAskJob:189` | Brain prose | `brainContactsUser` — **the observed `"Basit,"`** |
| `phraseOwnerChase` — `openItemFollowUpJob:283` | Brain prose | `brainContactsUser` — same resolver, same bug |
| `repairService:361` | Brain prose | `brainContactsUser` |
| `findingNotifier:66` health alert, `:151` digest | Brain prose | `brainContactsUser` |
| `brainPromptQueueService:125` / `:552` | pass-through | `brainContactsUser` |
| `delegationCaptureService:281` unattached reply | **quoted third party** | `enqueueBrainPrompt` → queue → `brainContactsUser` |
| `senderTriage:396`, `:433` counterpart forward | **quoted third party** | `brainContactsUser` |
| `actionLifecycleWorker:124` intervention form | deterministic artifact | `enqueueBrainPrompt` |
| `dayBriefDispatchJob:174/:255`, `brainMaturityReport:359` | deterministic artifact | `brainContactsUser` |
| `connectorHealthService:397`, `integrationService:213` | deterministic artifact | `brainContactsUser` |
| `profileRoutes:309` test ping, `whatsappNotifierRoutes:272/:322` | operator/fixed text | `brainContactsUser` |
| `smokeBrainOutbound:66/:100` | test fixture, never delivered | `brainContactsUser` |
| `actionLifecycleWorker:165` | **third-party recipient — not the owner** | direct `sendTenantWhatsAppText` |

**Two findings the inventory produced that the directive did not anticipate:**

1. `actionLifecycleWorker:165` bypasses `brainContactsUser` entirely — but
   `resolveConcernedPhone` means its recipient is the **delegatee**, not the
   owner. So it is correctly outside an owner-address boundary, and
   `brainContactsUser` *is* the complete owner boundary. This is also precisely
   why the policy must not live at `sendTenantWhatsAppText`: that transport
   carries this send too.
2. The queue is a **provenance-losing hop**. `delegationCaptureService` reaches
   the owner through `enqueueBrainPrompt`, and the actual send happens a tick
   later in `sendNextPrompt` from a persisted row. Without pass-through, the one
   producer whose payload must never be rewritten arrives at the boundary
   anonymous.

### What I changed, by file:line

**1. `brainHumanComm.ts:75-113` — `addressUser` delegates to the persona.** The
second resolver is deleted, not adjusted. Preserves the old behaviour for users
who set no title, because `persona.addressAs` already falls back to the first
name.

**2. `brainOutboundService.ts:50-92` — `OwnerMessageProvenance`.** Four values:
`brain_prose`, `quoted_third_party`, `deterministic`, `system_marker`.
**Optional and fail-closed**, and that is a deliberate decision I want on the
record: making it required would compile-enforce classification across all 66
sites, but it would also force 66 hurried guesses in one turn, and a wrong guess
on a `quoted_third_party` payload misquotes a real person. Absent means "not
Brain prose, do not touch" (invariant #6). The ~60 unclassified producers are
inert here rather than guessed at.

**3. `brainOutboundService.ts:180-224` — the boundary.** Runs after user
resolution (so the persona is resolved once, from data already fetched) and
BEFORE the content-fingerprint dedup, so the hash covers the delivered text. It
calls `finaliseUserVisibleProse` — **reusing** the compose policy rather than
writing a second one, since two disagreeing policies is the defect being closed.
Wrapped so a cosmetic rule can never block an owner message.

**4. Seven producers classified** from the inventory:
`openItemDraftAskJob:191`, `openItemFollowUpJob:285`, `repairService:363`,
`findingNotifier:68` → `brain_prose`; `senderTriage:398/:435`,
`delegationCaptureService:278` → `quoted_third_party`;
`actionLifecycleWorker:127` → `deterministic`.

**5. `brainPromptQueueService.ts:60-72, 169, 193, 558` — provenance survives the
tick.** Added to `EnqueueInput`, persisted on the queue row's metadata, replayed
by `sendNextPrompt`.

### Verification — re-run AFTER the last edit, from `server/`

```
npx tsc --noEmit    exit 0, no output (clean)
npx vitest run      Test Files  167 passed | 1 skipped (168)
                    Tests  1966 passed | 7 expected fail | 21 skipped | 1 todo (1995)
                    Duration 19.91s
npm run build       exit 0 (prisma generate + tsc)
git diff --check    exit 0, no output
```

Delta against iteration 4's 166 files / 1947 passed (1976): **+1 file, +19 tests**,
all in `def140OwnerAddressBoundary.test.ts`. No pre-existing test changed state.

### Mutation — 3 mutants, all 3 die, and one honest gap

- **Revert `addressUser` to the DB first name → 3 fail.** This reproduces the
  owner's exact `"Basit,"` on demand, through the real `phraseDraftAsk`.
- **Remove the provenance gate → 2 fail** (fail-closed unclassified; the
  same-input disagreement).
- **Disable the boundary → 3 fail.** It is genuinely firing.

**The gap, because the assertion reads stronger than it is:** the two
`quoted_third_party` tests **survive** the gate-removal mutant. Both production
shapes lead with `${who} replied:`, so the third party's words sit mid-string,
and DEF-137's position-0 anchor already protects them. **Today the anchor does
that work and provenance is defence behind it.** I kept both tests (they pin the
real shapes verbatim, and the anchor is one careless edit from being relaxed) but
corrected their comments to say so. The test that actually earns the gate is
*"the two provenances disagree on the SAME input"*, and that one dies.

### What I did NOT do

- **Did not touch the benchmark, judge, or gate.** Nor `scripts/orchestrator/**`.
- **Did not classify all 66 producers.** Reasons above; the honest state is that
  7 are classified and ~59 are fail-closed unclassified. **This is the single
  biggest hole in this iteration** and I would rather name it than imply the
  surface is now governed.
- **Did not make provenance required.** Argued above. If Codex judges
  compile-enforcement worth 66 classifications, I will do it as its own turn with
  the classifications reviewed individually — that is a review task, not a typing
  task.
- **Did not touch DEF-139 (batching)**, DEF-141 (the incoherent `mark it done`
  option), or DEF-142 (`Kon` escalated instead of answered). Directive #4 and my
  own CL-033 rows; DEF-141 is the one I would take next, because offering to
  record work that never happened is a truthfulness defect and the other two are
  volume and routing.
- **Did not touch the intervention form's wording.** Classified `deterministic`
  and left alone. Making that form read like a person is a real defect and a
  separate one.
- **Did not deploy**, and nothing here is verified live. The owner's phone is the
  only place `"Basit,"` can be confirmed gone.

### On the proactive evaluation slice (orchestrator's item, not mine)

Codex's shape is right and I would add one case: **a message whose body embeds a
third party's words that themselves open with the owner's configured address**
("Sir, I'll send it tomorrow"). It is the one shape where a plausible future
producer change silently converts a cosmetic rule into a misquote, and no
existing case covers it. Otherwise the six named cases match the defects in
CL-033 one for one.

### Prediction, and what would falsify it

**The twelve-case compose benchmark should be flat.** I changed no compose prompt
and no compose path; `finaliseUserVisibleProse` is unmodified. If C4 moves more
than a point or two in either direction, something I believe is wrong about what
this diff touches, and that is worth more than the movement.

**What would prove me wrong, or prove the fix hollow:**
- **The owner still sees `"Basit,"`.** Then `addressUser` is not the resolver that
  message uses, and my inventory missed a third one.
- **A notification arrives with a counterpart's words altered.** The provenance
  gate or the anchor failed, and this change is net negative — revert rather than
  tune.
- **A proactive message loses text it needed.** `finaliseUserVisibleProse` strips
  a leading vocative; if a `brain_prose` notification depended on its opener for
  sense, the classification was wrong for that producer.
- **C8 or C2 move at all.** They should not. If they do, the boundary is reaching
  compose traffic somehow, which would mean the two surfaces are less separate
  than the inventory says.

---

## Iteration 6 — mode: incremental

**Gating criterion: C4 @ 87.9.** Overall 94.8. Every other criterion is at or
above 93.3, and C1/C2/C5 sit exactly on 95, so C4 is the whole gate.

**The shape of C4 changed this iteration and that is the most useful fact in the
report: no case scores below 85, and the two Codex ranked for me are done.**
B04 is now 90 — *"concise and professional … not overly formal or templated"*,
the `priority=high` complaint gone — and B11 is 90, *"clear and human-like,
directly stating its capabilities"*. Directive #5's first two items have cleared
without a turn spent on them.

### The fixQueue entries I targeted

Five cases sit at 85. Quoting all five, because the point is that they are one
mechanism:

> **B10-what-did-you-send, C4 = 85** — "the phrase **'her reply wasn't a valid
> status'** is slightly robotic and **sounds more like system output** than a
> human explanation."

> **B12-reminder-referent, C4 = 85** — "**'My apologies, Sir'** followed by
> **'The system is designed...'** and **'I've logged this as a high-priority
> issue for my developers to investigate'** feels slightly formal and canned …
> which is a common AI trope."

> **B08-bad-news, C4 = 85** — "**'I can see three things that qualify as 'gone
> wrong''** is slightly stilted … The repetition of 'I notified you' is also a
> little robotic."

> **B05-warmth, C4 = 85** — "**'Good morning, Sir.'** feels slightly
> formal/template-like." (Its answer also renders **`1 DRAFT` / `4 DELEGATED`**.)

> **B09-identity, C4 = 85** — "the use of 'Sir' feels a bit overly formal and
> slightly subservient."

**One mechanism: Brain narrates its own machinery to the owner in the vocabulary
of that machinery.** `valid status` is the transition matrix. `surfaced for your
attention` (B03) is the notification pipeline. `DRAFT` / `DELEGATED` are raw enum
values. `I notified you at 09:26` is an event log. `The system is designed to
send one reminder per day` is architecture. And when it needed to describe its own
machinery having failed, **it invented machinery it does not have.**

**Expected to move: C4.** C1 and C7 may also move, because the B12 clause is a
false claim and not only a stiff one.

### Governing-docs verdict, before coding: CIRCLING on the guard, new on the register

- `brain_change_log.md` — no row covers self-description register. **DEF-135
  (this morning) owns the nearest one**, and it is the reason this is circling
  rather than new: it built `fabricated_process` for
  *"logged this with the engineering team"*, and iteration 05 shipped
  *"logged this as a high-priority issue for my developers"* straight past it.
- `brain_evaluation_chart.md` §3 — `guard-destroys-the-answer` (5, incl. DEF-135)
  is the adjacent tag but not this failure: that is a guard firing where it should
  not, and here the guard **did not fire at all**. Logged a new tag,
  **`detector-is-a-list-of-sentences`**, because the distinction is the whole
  lesson: a detector whose alternatives are example sentences will always pass its
  own tests, since its tests are the same sentences.
- `brain_chat_log.md` — latest is CL-033 (mine, yesterday's thread). Nothing new;
  no CL row added, because this came from the fixQueue and inventing an owner
  observation would be a fabricated record.

**I verified the hole before changing anything**, rather than assuming the judge's
complaint implied it. Against the live regex:

```
false  "I've logged this as a high-priority issue for my developers…"  ← iter-05 LIVE
true   "I've logged this with the engineering team."                   ← DEF-135's shape
false  "I've logged it with the dev team."
false  "I've raised this with my developers."
false  "I've opened a ticket for this."
false  "I've flagged this to the engineers."
```

### What I changed, by file:line

**1. `responseValidator.ts:124-142` — compose the class, stop listing sentences.**
A first-person remediation VERB (past and base forms of logged / raised / filed /
opened / reported / flagged / escalated / submitted / forwarded) followed by a
remediation CHANNEL (developers / dev team / engineers / engineering / support
team / maintainers / my team / a ticket / a bug report) inside the same clause.

Requiring **both** is what keeps it off honest prose, and that is the half worth
defending: *"I've flagged the item for your attention"*, *"I've logged your
preference"*, *"I've forwarded it to Hamna"* all name a business object rather
than a channel, and none matches. **Purely additive** — every original
alternative still matches what it matched, so nothing previously caught becomes
uncaught. Non-global flag preserved deliberately; `exciseSentencesMatching`
documents that `/g` carries `lastIndex` and would skip sentences.

**2. `brainPersonaService.ts:180-181` — the generation half, two rules.** Speak in
the owner's terms, with the four leaked phrasings named and their repairs shown,
and never print a raw status name. And when Brain is the thing that went wrong:
own it in one line, promise only what is within its own reach, **and say the cause
is unknown when it is** — since inventing a process to fill that silence is
exactly what happened. Both halves, because DEF-134 proved a prompt rule alone is
weak and DEF-136 proved a guard alone can be unreachable; DEF-138 is the shape
that worked.

### Verification — re-run AFTER the last edit, from `server/`

```
npx tsc --noEmit    exit 0, no output (clean)
npx vitest run      Test Files  168 passed | 1 skipped (169)
                    Tests  1990 passed | 7 expected fail | 21 skipped | 1 todo (2019)
                    Duration 18.73s
npm run build       exit 0 (prisma generate + tsc)
git diff --check    exit 0, no output
```

Delta against iteration 5's 167 files / 1966 passed (1995): **+1 file, +24
tests**, all in `def143FabricatedRemediation.test.ts`. No pre-existing test
changed state. The three guards this change could plausibly break were re-run
separately: `def135` + `def041` + `completionClaimGate` = **58 passed**.

### Mutation — 2 mutants, both die

- **Revert the detector to the enumerated list → 10 fail.** The hole is
  reproduced on demand, including the exact B12 sentence.
- **Remove both persona rules → 2 fail.**

### What I did NOT do

- **Did not touch the benchmark, the judge, or the gate.** Nor
  `scripts/orchestrator/**`.
- **Did not take Codex's directives #1–#4** (finish the boundary inventory
  including `notificationService`; make provenance exhaustive; extract the
  finaliser into a policy module; replace source-substring containment with
  end-to-end producer tests). All four are correct and I am not disputing any of
  them. The reason: **they are all on the proactive surface, and no instrument in
  this loop can see that surface yet** — Codex's own #5 says the proactive
  evaluation slice must exist before DEF-140 can be scored, and the orchestrator
  owns that slice. Iterations 4 and 5 both spent there; C4 has now gated six
  consecutive measurements. Doing #1–#4 this turn would add unmeasurable work to
  an unmeasured surface while the measurable gate sat still. **#2 and #3 are the
  two I would take first once the slice exists**, and #3 (extract the finaliser)
  is the one I would argue for even without it, because a background notifier
  silently skipping address policy on a composer import failure is a real hole I
  opened.
- **Did not fix the pre-existing false positive I found.** The bare
  `support team` / `engineering team` alternatives fire on a business fact about
  a real team — *"Hamna asked whether our support team covers weekends"* would be
  blocked. My composed pattern does not do this. I left it because
  `def135GuardSalvagesAnswer.test.ts:105` deliberately pins that behaviour, so
  narrowing it is a decision for review rather than a quiet edit. **It is a live
  answer-destroying risk and it is now written down.**
- **Did not take the ledger-verification structural exit.** Chart §3 has named it
  since 2026-07-08 and records it as deferred until the dispatch ledger is dense
  enough to be an oracle. A composed pattern is a better word list, not the end
  of word lists, and the row says so.
- **Did not touch `Sir` frequency again.** B05 and B09 still lose points on the
  honorific, and Codex's iteration-4 instruction not to spend another turn solely
  on honorifics stands. If C4 stalls with only those two below 95, the remaining
  question is whether the judge will ever accept the owner's configured honorific
  — which would be a case-fairness question for Codex, not a code change.
- **Operator directives:** D-1 (benchmark writes to the live backlog), D-2 (DEF-132/133
  need review before deploy), D-4 (measurement cannot separate gain from noise)
  all remain open and untouched this turn; D-3 (report the ledger honestly) is
  standing and is why the delta above is measured rather than asserted. D-4 is
  the one I would still rank first: **C4 has read 84.8, 85.8, 85.4, 86.3, 89.6,
  90.0 and now 87.9 — the last two moves are a fall of 2.1 on unchanged compose
  code**, which is the clearest evidence yet that single-sample scoring cannot
  resolve the moves this loop is trying to steer by.

### What I am unsure about

- **Whether the register rule is specific enough to change behaviour.** Naming
  four phrasings and their repairs is more concrete than "sound human", but it is
  still an instruction competing with the model's defaults, and DEF-138's lesson
  was that examples outvote instructions. **I did not add examples this time**,
  because the existing eight already avoid system vocabulary — so there is no
  contradiction to remove, only a rule to add, which is the weaker of the two
  levers.
- **Whether B12's honest half survives in practice.** The salvage is asserted in
  CI, but on a live turn the guard now fires where it previously did not, and a
  `block` remedy is the mechanism behind five recorded occurrences of
  `guard-destroys-the-answer`. If the salvage under-performs on real phrasing,
  this change trades a false sentence for a damaged answer.

### Prediction, and what would falsify it

**C4 should rise, and B12 should be the clearest single move** — its C4 = 85 was
attributed to a phrase that can no longer ship. B10 and B08 depend entirely on the
prompt half and are the weaker bet. **C1 and C7 may rise too**, since the removed
clause was untrue.

**What would prove me wrong:**
- **C4 flat or down while B12's C4 stays 85.** Then the register complaint is
  about cadence rather than vocabulary, and naming phrasings does not reach it —
  the next lever would be examples, per DEF-138, not more rules.
- **B12's overall FALLS.** The guard fired and the salvage took the answer's
  substance with it. That is the `guard-destroys-the-answer` recurrence I am most
  exposed to, and it would mean reverting the detector widening rather than tuning
  the salvage.
- **Any case loses points for a sentence that reads truncated or fragmentary.**
  Same cause, wider blast radius — the composed pattern matching honest prose I
  did not think to put in the battery.
- **C4 rises but C6 (93.3, the second-lowest) falls.** Telling Brain to compress
  its self-description could cost the completeness criterion, and C6 is the one
  that would gate next.

---

## Iteration 7 — mode: incremental

**Gating criterion: C4 @ 88.3.** Overall 95.1. But the target is 95 on EVERY
criterion, and three are failing: **C4 88.3, C5 93.3, C6 93.8.** That matters for
what I chose, because one case is the dominant cost in two of the three.

### Iteration 6 measured, and it settles Codex's directive #4

DEF-143 worked. **B12: C4 85 → 90, C1 80 → 85, C2 75 → ≥95** — the fabricated
developer clause is gone and its replacement is grounded in a timing collision.
B05 85 → 90, B09 85 → 90. C4 88.3 overall (+0.4).

But the distribution is the useful part. **B01 and B02 FELL from 90 to 85**, and
the four remaining 85s no longer share a mechanism — they contradict each other:

> **B01, C4 = 85** — "'automated WhatsApp notifications' and the precise time
> stamps feel **slightly robotic**, although they are factual."

> **B02, C4 = 85** — "'Based on the records I have' is a **slightly stiff, canned
> opening**."

> **B08, C4 = 85** — "'here they are in one place' is **slightly more
> conversational** than purely factual."

> **B10, C4 = 85** — "the use of 'Sir' is a bit overly formal … and 'quite a few'
> is slightly generic."

B08 is now penalised for being *too conversational* while B01/B02 are penalised
for being *too robotic*. Codex's directive #4 said: wait for this measurement,
and if B08/B10 are still 85, add style examples demonstrating owner-language
rewrites. **They are still 85, and I did not do that**, because the measurement
that #4 asked me to wait for shows B08's complaint has inverted — an example
teaching plainer register would push it further in the direction it is already
being marked down for. Each remaining 85 is one phrase, and they point opposite
ways. That is taste at 5-point granularity, not a mechanism.

**Judge-granularity note, offered for arbitration and not acted on.** Across
nine measurements C4 is awarded in 5-point steps, the mode is 90, and **≥95 has
been given to at most 2 of 12 cases in any single run** (0 in six of the nine).
A C4 *average* of 95 therefore requires nearly every case at 95. I am not
claiming the gate is unreachable — 95 and 100 have both been awarded — but the
loop should know that C4 ≥ 95 needs a near-sweep of a criterion whose modal award
is 90. I did not touch the benchmark or the judge.

### The fixQueue entry I targeted

So I went to the worst case in the report instead, which fails FOUR criteria:

> **B04-outstanding-question-ignored — C6 = 75** — "The response is incomplete
> because Brain only handled the 'priority' part of its previous query and **did
> not explicitly ask for the 'deadline'** or state why it wasn't handled."

> **B04, C5 = 80** — "Brain only addressed half of its outstanding question. It
> should have prompted for the deadline **without making the user repeat
> themselves**."

Its answer was `Updated "Define rules for Brain's responsiveness to new vs.
existing contacts": priority=high.`

**Brain did ask.** The iteration-01 composer log holds both strings on the same
turn:

```
compose.parsed        answerHead: "Got it. I've set the priority to high.
                                   Do you have a deadline for this?"
validateBeforeRender  originalHead: 'Updated "Define rules …": priority=high.'
```

**Expected to move: C5 and C6 first, then C3, then C4.** B04 is the largest single
contributor to C5 (93.3) and C6 (93.8), which the "every criterion" target
requires anyway.

### Governing-docs verdict, before coding: CIRCLING — 6th occurrence

`guard-destroys-the-answer` sits in chart §3 with five occurrences and this is the
sixth, so a structural fix is required rather than another patch. It also forces
the tag past its own name: the five existing members are all a PROTECTION firing
where it should not. **This one is a success renderer.** No violation, no guard,
identical damage.

The tag's recorded containment turns out to be exactly right and one word too
narrow — *"no `block` remedy may discard prose it did not prove defective"*. The
general form is **no deterministic replacement may discard prose it did not prove
defective**, and a success path is a replacement too. The chart now says so.

`brain_chat_log.md` — latest CL-033; nothing new, no row added.

### What I changed, by file:line, and why that is the mechanism

**`brainComposer.ts:3627`** was `answer = actionResult.message` on the SUCCESS
path of `update_open_item`. One assignment cost four criteria: the deadline
follow-up was *inside* the discarded sentence (C5, C6), the turn stopped
continuing the previous one (C3), and `priority=high` is machine syntax (C4). It
is also **a hardcoded English sentence presented as Brain's voice, which
invariant #4 forbids** — the sanctioned deterministic form is a bracketed
`[marker]` rendered by `answerSanitizer`, and this is not one. And it explains why
DEF-143's register rule could not reach `priority=high`: **that text never came
from the model.**

**A predicate, not a deletion** (`brainComposer.ts:2140-2167`,
`brainAnswerSurvivesReceipt`). The overwrite was defending something real: it
guaranteed the owner saw what ACTUALLY changed, and this branch silently drops a
priority word it cannot normalise, so *"I've set it to urgent"* could otherwise
stand as a false completion claim (invariant #5). Prose survives only when **every
field the model requested was applied** and the text is real prose (≥ 12 chars,
not a bracketed marker). Otherwise the receipt wins. Wired at the single call
site, `:3628-3639`.

**The receipt is unchanged and still exists** — `actionResult.ok`, its
`artifactId` and its message all still feed the artifact ledger and the
completion gate. It stops being the ANSWER; it does not stop being the record.

**It is a class, and I fixed one member.** Seven success paths do the same thing:
`Delegated "…" to …`, `Sent email to … messageId=…`, `Saved <name> (<phone>)
<email>`, `Got it — from now on you can call me …`, plus two more, and
`applyOpenItemUpdate.ts:108` is a **second copy of this very receipt**. Two of the
seven are PREVIEWS the user must read verbatim before confirming, so extending
this is a per-action judgement rather than a sweep. The inventory is written into
the chart row instead of being quietly widened.

### Verification — re-run AFTER the last edit, from `server/`

```
npx tsc --noEmit    exit 0, no output (clean)
npx vitest run      Test Files  169 passed | 1 skipped (170)
                    Tests  1998 passed | 7 expected fail | 21 skipped | 1 todo (2027)
                    Duration 18.80s
npm run build       exit 0 (prisma generate + tsc)
git diff --check    exit 0, no output
```

Delta against iteration 6's 168 files / 1990 passed (2019): **+1 file, +8 tests**,
all in `def144ReceiptDoesNotReplaceAnswer.test.ts`. No pre-existing test changed
state. One source file changed: `brainComposer.ts`.

### Mutation — 2 mutants, both die on the LIVE path

Four of the eight tests drive the real `compose()` through its dispatch branch
(LLM seam and prisma mocked), so these are behaviour assertions on the path that
returns to the route, not helper assertions.

- **Restore the unconditional overwrite → the B04 test fails.** The defect
  reproduced on demand.
- **Remove the dropped-field check → the partial-application test fails.** The
  anti-fabrication half.

**Two of my own assumptions were wrong, and both are recorded rather than
smoothed over:**

1. **My first harness proved nothing and passed.** I gave the action a `titleRef`
   only; `normaliseAction` requires `openItemId` for `update_open_item`, so no
   action dispatched at all and the answer survived for entirely the wrong
   reason. I found it because the `updates.length` assertion failed, not because
   the answer assertion did — a green answer assertion would have shipped a
   fiction. This is the third time this loop that a test passed for the wrong
   reason; it is a cheap check to add and I keep nearly not adding it.
2. **When NOTHING applies, the pre-existing branch is already correct** — it
   emits `[update_open_item: no recognised fields to update]`, an honest marker,
   not the receipt. I expected the receipt and asserted it; I corrected the test
   to the observed behaviour rather than the other way round.

### What I did NOT do

- **Did not touch the benchmark, judge, or gate.** Nor `scripts/orchestrator/**`.
- **Codex directive #1 (B12 at the evidence boundary — read the reminder/dispatch
  ledgers, require `cause: unknown`).** Not done. Its premise moved under it:
  B12's C1 is now 85, C2 recovered to ≥95, and the current C1 complaint is about
  a **promise** (*"I'll make sure it doesn't happen again"*), not the cause. The
  ledger-reading feature is still the right structural answer and is now a
  smaller prize than when it was ranked.
- **Codex directive #2 (narrow the bare `support team` / `engineering team`
  alternatives).** Not done, and this is the skip I am least comfortable with —
  it is a HIGH answer-destroying risk that I widened around last turn. I chose
  B04 because B04's damage is **measured** (four criteria, live in the report)
  while #2's is **hypothetical** (no benchmark case mentions a real support
  team). Same defect class, and DEF-144's generalised containment now covers both.
  **I would take #2 next**, and it is the one to hand me if the next measurement
  is ambiguous.
- **Codex directive #3 (route-level DEF-143 test through `answerAsBrain` and the
  sanitizer).** Not done. My DEF-144 tests do go through `compose()`, which is
  one layer deeper than DEF-143's, but neither reaches the sanitizer.
- **Codex directive #5 / DEF-140 boundary work** (exhaustive producer inventory
  including `notificationService`, required provenance, pure finaliser
  extraction, producer-to-dispatch tests). Still open, still unmeasurable until
  the proactive slice exists.
- **Did not extend DEF-144 to the other six success paths.** Inventory recorded;
  two of them are previews that must stay verbatim.
- **Operator directives:** D-1 (benchmark writes to the owner's live backlog),
  D-2 (DEF-132/133 need review before deploy) and D-4 (measurement cannot
  separate gain from noise) all remain open and untouched. D-3 (report the ledger
  honestly) is standing and is why the delta above is measured and why both my
  wrong assumptions are in this entry. **D-4 keeps earning its rank:** C4 has now
  read 84.8, 85.8, 85.4, 86.3, 89.6, 90.0, 87.9, 88.3, and B01/B02 fell 90 → 85
  this iteration on code that did not target them.

### What I am unsure about

- **Whether the LLM reliably asks the outstanding question.** The whole gain
  depends on Brain's own sentence being good, and I have exactly one observed
  sample of it (the iteration-01 log). If the model often answers a slot-fill
  turn with a bare *"Done."*, the ≥12-character floor sends it back to the
  receipt and B04 does not move.
- **Whether `priority` is really the only silently-dropped field.** I read the
  branch and it is the only normalisation that can fail without setting
  `actionResult`, but that is a reading, not a test sweep across every field.
- **Whether losing `status=NEW (DRAFT completed)` from the visible text matters.**
  When prose survives, the owner is no longer told the item left DRAFT. I judged
  that internal, consistent with DEF-143's register rule; the receipt still
  records it.

### Prediction, and what would falsify it

**C6 and C5 should move most** — B04's C6 = 75 and C5 = 80 are the two lowest
scores in the entire report and both are attributed to a question that was asked
and discarded. **C3 should follow** (85, same case, continuity). **C4 should gain
about half a point** from `priority=high` disappearing, which is *not* enough to
clear the gate and I am not claiming it is.

**What would prove me wrong:**
- **B04's C5/C6 stay at 80/75.** Then the model does not actually ask for the
  deadline on that turn, the iteration-01 log was an unrepresentative sample, and
  the fix is correct but aimed at a sentence that usually is not there. The next
  move would be prompt-side: make a partial slot-fill always name what is still
  missing.
- **B04's C1 or C7 FALL.** Brain's prose overstated what changed and my
  requested-vs-applied check is too narrow — the failure mode I built the
  predicate to prevent, and evidence it needs more fields than `priority`.
- **Any case gains a completion claim that the ledger does not support.** Same
  cause, worse: it would mean the receipt was load-bearing for truthfulness in
  ways I did not map, and the right response is to revert rather than widen the
  predicate.
- **C4 rises but overall falls.** I would have traded the mean for the minimum,
  which under a "95 on every criterion" gate is not a win.
