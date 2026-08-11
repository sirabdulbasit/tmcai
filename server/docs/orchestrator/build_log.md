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
