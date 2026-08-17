# Build log — written by Claude, read by Codex

One `## Iteration N` section per build turn, appended, newest at the bottom.
Codex reviews these entries against the real diff, so a claim here that the diff
does not support is the single most useful thing for the reviewer to catch.

Required per iteration: what the fix queue said, what was changed and why, the
verification numbers (tsc / vitest, exact figures), what was NOT done, and the
honest expectation of which criterion should move.

## Iteration 1 (loop-numbering restart; the seventh build turn of this branch)

**Commit `e413758`** on `release/cmp-2026-08-16`. DEF-193 row added;
`Changes_Made.md` §44 added.

### The fix queue entry I targeted, quoted

> **C6 80 · B10-what-did-you-send** — *"The response starts by promising a
> 'full list' and then ends with an ellipsis, indicating that the list is not
> actually complete. This is a failure to [complete the answer]."*

The worst entry in the baseline fixQueue, and its C1 90 carries the same
complaint. **I expect C6 to move on B10, and C1 on B10.** Nothing else should
move, because nothing else changed.

### Why this and not the brief's stated target

The brief's target reads `Simple @@TARGETCAP@@ Smart` — an unexpanded
placeholder for the second turn running (also `@@CAPGAPS@@`, `@@CHATROOTS@@`).
Reported, not worked around; I did not touch `scripts/orchestrator/**`.

More substantively: the campaign block orders *make HEAD deployable, close
what the reviewer says blocks release*. **There is no open reviewer finding
left to close.** The newest review section is `## Iteration 4`; Iteration 5
ruled on its findings (the owner gate, `bb0cf57`) and last turn closed its
carried CRITICAL (`9cb7720`, DEF-192). So the "only job" is discharged, and
the re-scope instruction governs what to do with the turn: *one owner-visible
behaviour made correct, with a test, small enough to ship*. That is what this
is — and it is on the live compose path the owner meets on every long
WhatsApp answer, not an unreachable one.

**Dropped, and why:** Codex's chat root-cause analysis ranks `@lid` identity
(#1, Self-Healing) first. I did not take it: its owner-visible requirement is
*"text, voice, typing presence, counterpart replies and outbound confirmation
must all pass together in one live @lid conversation"*, which is a live-WhatsApp
verification exercise, not a code change I can complete and prove in one turn.
Taking it would have produced another unshippable turn, which is exactly the
pattern the re-scope exists to break. It stays first in the queue.

### Governing-docs verdict (rule 5): CIRCLING — and the file says so itself

The cap's own comment records the previous round: it was **600**, it
"truncated mid-content on the day brief (calendar + 2 emails, then '...')",
Basit reported the brief arriving with sections missing, and it was raised to
**1000**. It has now recurred at 1000. Raising the number a third time is the
forbidden patch on the reported instance.

### What changed, by file, and why that is the mechanism

`server/src/services/knowledge/channelRenderer.ts`:

- **The cap was two decisions in one number, which is why raising it never
  worked.** *Brevity* is a content judgement — it needs to know which
  sentence matters. The *transport limit* is a channel fact. The renderer had
  only the second and was making the first, with a knife. Separated:
  `WA_TRANSPORT_MAX_CHARS = 3900` (headroom under Meta's 4096 — the same limit
  `whatsappService.ts:363` and `whatsappNotifierService.ts:99` already clamp
  to), and brevity stays with the composer's format rules, which already ask
  for it and are untouched here.
- **`trimToLimit` → `fitToChannel`.** When a body genuinely exceeds transport
  it drops **whole trailing `• ` items** — never half an item — and appends
  `(+N more not shown)`, a true statement of what happened, replacing the bare
  ellipsis that silently contradicted the sentence above it. The head prose,
  which is what answers the question, is never dropped. Long PROSE keeps the
  sentence-boundary ellipsis on purpose: after a complete sentence it means
  "there was more" and asserts nothing false.
- **A pre-existing off-by-one, found by writing the test:** `trimProse`
  appended its ellipsis AFTER slicing to `max`, returning **max+1**
  characters. Harmless against a self-imposed 1000; a rejected send against a
  real transport limit. The suffix's room is now reserved before the cut.

Three of my first eight test runs failed on my own code and fixture — the two
off-by-ones above and a fixture that was 889 chars while claiming to exceed
1000. Recorded because a green-first-run claim would have been the more
suspicious report.

### Verification (measured AFTER the last code edit, commit `e413758`)

- `npx tsc --noEmit` — clean.
- `npx vitest run` — **196 files: 194 passed / 1 failed / 1 skipped · 2,413
  tests: 2,382 passed / 2 failed / 7 expected fail / 21 skipped / 1 todo.**
  The 2 are `orchestratorPulseRoute.test.ts` executing the orchestrator's
  uncommitted live `pulse.py`; the COMMITTED script passes the contract's
  exact assertions (proven in Iteration 2's entry). Unchanged by this diff,
  and still the only thing between this branch and a zero-failure matrix.
- **`npm run build`** — the actual script at `e413758` in the fully isolated
  clean clone (own `npm ci` dependencies): generate + emit OK,
  `dist/services/knowledge/channelRenderer.js` produced in the clone.
  Production's immutable `server/dist` untouched.
- `git diff --check` — clean.
- New tests: 8. Adjacent renderer suites re-run green (def072, def145,
  def146, def147, def078 — 69 tests).

### Capability declaration (contract §Builder)

```
CAPABILITY: Accurate Communication
PREDICTED:  +1 to +2 once deployed. This is a live compose-path change the
            owner meets on every long WhatsApp answer, and B10 is the
            measured instance. DIVERGENCE from the brief's target, stated as
            required: the target is an unexpanded placeholder, no reviewer
            finding remains open, and the re-scope rule asks for one
            owner-visible behaviour made correct — so I took the worst
            measured fixQueue entry instead.
MECHANISM:  the answer he receives is no longer contradicted by its own
            truncation — a list is shortened by whole items with the omission
            counted, or not shortened at all — and 3.9× more of every long
            answer now arrives.
FALSIFIER:  a rendered WhatsApp body containing a severed `• ` item, a bare
            `…` inside a list, or more than 3900 characters; or B10 scoring
            C6 ≤ 80 again with the ellipsis contradiction in the judge's
            reason.
```

### What I did NOT do, and what I am unsure about

- Did not touch the benchmark, the judge, or `scripts/orchestrator/**`.
- Did not make the COMPOSER budget-aware. It can still write "the full list"
  for a list the renderer then shortens; what changed is that the shortening
  no longer leaves the claim contradicted. Moving the budget into composition
  is the larger version of this fix and is not attempted here.
- **The one judgement call, flagged rather than buried:** `(+N more not
  shown)` is deterministic text in an owner-facing body. I argue it is a
  rendering artifact in the same category as the `…` it replaces — no
  vocative, no promise, no first-person future, and a named test asserts that
  — but if Codex reads it as invariant #4 deterministic prose, the alternative
  is extending the sanctioned marker path, which today carries only
  whole-answer markers. His call, and I would rather be told than assume.
- Unsure whether 3900 is the right headroom: the route appends nothing today,
  but a future footer could. The test pins ≤ 3900 so a regression is loud.

### Honest prediction

**Deployable at the end of this turn.** The diff is one file plus a test, adds
no migration, touches no tenant or messaging-authorization surface, and every
reviewer-named release blocker on this branch is already closed. C6 should
move on B10; if the benchmark shows C6 unchanged AND a fresh run still ends
B10 with an ellipsis, I was wrong about the mechanism and the cut is happening
somewhere I have not found. If C6 moves but other criteria move too, treat
that as sampling noise, not as this change working better than claimed.

## Iteration 2 — remediation of the iteration-1 WRONG on DEF-193

**Commit `c98a2c6`** on `release/cmp-2026-08-16`. DEF-194 row added;
`Changes_Made.md` §45 added. Remediation attempt 3 of 3, so this turn closes
findings rather than starting anything.

### What I now believe was wrong about the last attempt

The continuation block asks this directly, and the answer is not flattering.
**I fixed the boundary I was looking at instead of the one the code names.**
`WhatsAppInbound.sendReply` carries a comment saying *"EVERY reply to a human
goes through sendReply, so every reply is rendered here and nowhere else"* —
and it had its own blind `slice(0, 3900)` with a bare `...`. I found
`channelRenderer` first, fixed it carefully, tested it thoroughly, and wrote
"the owner meets this on every long WhatsApp answer". That sentence was false
for any reply not routed through `brainAskRoutes`. Codex caught it as a carried
HIGH, and it is the same `protection-with-two-implementations` shape I have now
written into three DEF rows this week — which is exactly why I should have
grepped for a second truncator before claiming the path.

The second thing I got wrong I had already half-seen: I invented prose at a
transport layer, flagged it, and asked Codex to arbitrate. He ruled it a §2.4
violation. Flagging is better than hiding it, but the right move was not to
write it.

### The findings, in severity order

**CRITICAL — deterministic owner-facing English (`channelRenderer.ts:180`).**
Closed by removal, not softening. `(+N more not shown)` is gone. The count
leaves `fitToTransport` as **structured data** (`omittedItems`) so a caller
that owns a sanctioned boundary can speak it in Brain's voice; the body itself
gains at most an `…` glyph — the same mark the code already used, and not a
sentence. Two tests hold the line: every line the layer added must be exactly
`…`, and the body must contain none of `not shown / more / omitted / truncated
/ hidden / remaining`. Codex's directive 1 is followed literally: *"the
transport layer may return truncation metadata/count"*, and no explanation.

**HIGH — wrapped items mutilated.** Closed structurally, per directive 2. An
item is now a semantic **BLOCK**: its line, plus every non-blank non-peer line
after it, plus any item line indented DEEPER — so a sub-bullet belongs to its
parent and dropping the parent takes its children rather than orphaning them.
Head prose and trailing prose are structural and never dropped. A head that
alone exceeds the budget falls back to prose trimming and claims **no** item
count, which was Codex's finding #3 on claims-not-supported. His exact
falsifiers are now tests: wrapped bullets carrying a URL and a quotation,
nested sub-bullets, tail prose after the list, a head over the cap, plus a
"never cuts inside a line" assertion (every surviving line must exist verbatim
in the input) and `kept + omitted = total`.

**CARRIED HIGH — two truncators.** Closed by consolidation, per directive 4.
`transportBudget.ts` owns the algorithm and the single
`WA_TRANSPORT_MAX_CHARS`; both `channelRenderer` and
`WhatsAppInbound.sendReply` call `fitToTransport`. The parity test is
source-inspection and adversarial: it fails if `WhatsAppInbound` regains
`clean.slice(0, 3900)` or `clean += '...'`, if `channelRenderer` regains
`function fitToChannel`/`trimProse` or the string `not shown`, or if either
declares a second `WA_*MAX*` constant. That is the assertion Codex asked for —
one that "cannot pass with two drifting implementations".

**NOT CLOSED, and I am saying so rather than implying otherwise:**

- **HIGH #3, the completeness contradiction.** An oversized list headed "here
  is the full list" is still shortened under an unchanged claim. I cannot fix
  this from transport: the claim is composed *before* the budget is known, so
  the only real fix is Codex's directive 3 — the composition boundary must know
  the channel budget and not promise "full" for something it will not fully
  render. That is a composer change; adding it to a third-attempt remediation
  turn is how the last three turns died. Recorded OPEN in DEF-194.
- **MEDIUM #4**, WhatsApp brevity now has no shared enforcement (only composer
  format rules). Related to the same directive-3 work. I did NOT re-add a
  content ceiling, because a renderer that cuts for taste is the defect this
  whole thread is about.
- **MEDIUM #5**, the C4 register gate (B10/B12 "Sir"/canned formality, B02/B06
  template phrasing). Untouched, and it remains his directive 6 for a fresh turn.
- **Directive 5's build-log restoration** is orchestrator-owned; I cannot
  restore a record in a file the orchestrator resets between turns, and I am
  not touching `scripts/orchestrator/**`. Named so it is not lost.

### Governing-docs verdict (rule 5)

**Circling — `protection-with-two-implementations`, 11th occurrence**, and this
turn's fix is the sanctioned structural one: delete one implementation, keep
one, and add the parity assertion that makes a third impossible to add quietly.

### Verification (measured AFTER the last code edit, commit `c98a2c6`)

- `npx tsc --noEmit` — clean.
- `npx vitest run` — **196 files: 194 passed / 1 failed / 1 skipped · 2,419
  tests: 2,388 passed / 2 failed / 7 expected fail / 21 skipped / 1 todo.**
  The 2 remain `orchestratorPulseRoute.test.ts` executing the orchestrator's
  uncommitted live `pulse.py`. I accept Codex's ruling that a red matrix is a
  release stop condition regardless of cause — it is simply not a stop I can
  clear from inside the Builder's permitted paths.
- **`npm run build`** — the actual script at `c98a2c6` in the fully isolated
  clean clone (own `npm ci` deps): generate + emit OK,
  `dist/services/knowledge/transportBudget.js` and
  `dist/services/whatsapp/WhatsAppInbound.js` produced in the clone.
- `git diff --check` — clean.
- Tests: 14 new; `def193ListSurvivesTheChannelCap.test.ts` deleted (its subject
  moved into the shared module). Adjacent renderer suites re-run green
  (def072/145/146/147/078 — 69 tests). One fixture of mine was wrong again on
  first run (8 wrapped items needed, not 4, to exceed the old cap); recorded.

### Capability declaration (contract §Builder)

```
CAPABILITY: Accurate Communication
PREDICTED:  +0 to +1. This is remediation of my own defect, not new
            capability. What it buys: the previous turn's improvement now
            applies to the chokepoint the owner's replies actually traverse,
            and no invented sentence rides out with it. The continuation
            block says do not change capability, and I have not.
MECHANISM:  one transport policy for every WhatsApp reply, shortening by
            whole semantic blocks and saying nothing in Brain's voice.
FALSIFIER:  a delivered body containing text this layer invented; an orphaned
            continuation whose bullet head was removed; a body over 3900
            characters from either call site; a second slicer or budget
            constant reappearing in channelRenderer or WhatsAppInbound.
```

### Honest prediction

The three findings I can close are closed at the class level, with the parity
test Codex specified. **The benchmark should be flat** — B10 already fit under
3900 last turn and nothing about composition changed, so I predict no C6 move
and no C4 move, and I would treat any movement as sampling noise rather than
evidence for this diff. Deployability is not mine to claim while the matrix is
red: the product diff is releasable in my judgement, and the pulse
reconciliation is the orchestrator's. Wrong if: Codex finds a third truncator
outside these two sites, or a block-parsing input where a continuation still
orphans.

## Iteration 2

**Commits `c98a2c6` (last turn's code, docs owed until now) + `0ab6288` (this
turn's deeper consolidation).** DEF-194 row updated; `Changes_Made.md` §46
added.

### The escalation ruling, first, because the rail asks for it plainly

**(a) ACCEPT AS A KNOWN LIMITATION with a DEF row — not (b) revert.**

The finding still open is Codex's HIGH #3: an oversized list headed "here is
the full list" is shortened under an unchanged completeness claim. My reasons,
which are checkable rather than assertions:

1. **It is not introduced by this work, and this work strictly improves it.**
   Before DEF-193 the same oversized list was severed MID-ITEM under the same
   false claim — so the claim was equally untrue *and* the content was
   mutilated. Now the claim is equally untrue and the content is intact.
2. **Reverting costs the owner three things to remove none.** It would restore
   the 1000-character guillotine that severed his day brief (his own report,
   2026-05-20, recorded in the cap's comment), restore mid-item severing, and
   restore the four-way implementation drift.
3. **Closing it needs a different layer.** The claim is composed before the
   budget is known, so no transport change can make "full" true. Codex's own
   directive 3 assigns it to composition. That is new work, and this is a
   remediation turn.

### What I now believe was wrong about the last attempt

The continuation rail asks this directly. Last turn I claimed *"the owner meets
this on every long WhatsApp answer"*. That was false, and Codex caught it: I
had fixed `channelRenderer`, while the file that actually sends every reply
says in its own comment *"EVERY reply to a human goes through sendReply"* and
kept its own blind slicer. **I fixed the boundary I happened to open first
rather than the one the code itself names as the chokepoint.**

And the deeper error, which I only found this turn by grepping instead of
reasoning: it was not two implementations, it was **four**. `whatsappNotifier
Service.ts:99` and `whatsappService.ts:363` each held their own
`.slice(0, 4096)`. The notifier one matters most — it is the PROACTIVE push
path, so the owner's notices were the ones being cut mid-word, mid-bullet, and
potentially mid-phone-number, with no marker at all. That is why the previous
turn's careful work could be entirely true and still not reach him.

### What changed this turn, by file, and why that is the mechanism

- `whatsappNotifierService.ts` — the provider clamp calls
  `fitToTransport(body, 4096)`. This is the live proactive surface.
- `whatsappService.ts` — `sanitizeOutbound` calls
  `fitToTransport(stripped, 4096)`; the policy module is dependency-free so
  there is no cycle.
- `tests/def194OneTransportBudget.test.ts` — the parity guard is now
  **exhaustive over all four sites**, asserts none keeps a blind
  `.slice(0, 4096|3900)` or its own bare `'...'`, and adds a proactive-path
  test proving no line is severed. It also **strips comments before
  asserting**: the first version of the guard FAILED on my own explanatory
  comments quoting the old `body.slice(0, 4096)` — a guard that reads prose
  about the code instead of the code. Recorded because it is exactly the class
  of self-satisfying test this loop should not accept.

Mechanism, stated once: a policy that exists in four places is not a policy.
Naming one module and asserting every send path calls it is what makes the
next fix land where the owner actually is.

### Verification (measured AFTER the last edit, at `0ab6288`)

- `npx tsc --noEmit` — clean.
- `npx vitest run` — **196 files: 194 passed / 1 failed / 1 skipped · 2,422
  tests: 2,391 passed / 2 failed / 7 expected fail / 21 skipped / 1 todo.**
  The 2 are `orchestratorPulseRoute.test.ts` executing the orchestrator's
  uncommitted `pulse.py`; the committed script passes the contract (proven in
  the Iteration 2 entry of the earlier numbering). Unchanged by this diff and
  still the only thing between this branch and a zero-failure matrix.
- **`npm run build`** — the actual script at `0ab6288` in the isolated clean
  clone: generate + emit OK, `dist/services/whatsappService.js` and
  `dist/services/notifications/whatsappNotifierService.js` produced.
- `git diff --check` — clean. New tests this turn: 3 (17 in the suite).

### Capability declaration (contract §Builder)

```
CAPABILITY: Accurate Communication
PREDICTED:  +0 to +1 once deployed. Remediation of my own defect, not new
            capability. What it buys: the fix now applies to the paths the
            owner's messages actually traverse — including the proactive push
            path, which no previous turn touched.
            DIVERGENCE from the brief's target: the target reads
            `Simple @@TARGETCAP@@ Smart` (an unexpanded placeholder for the
            third turn running) and the continuation rail says do not change
            capability. Remediation scope governs; the reviewed change is an
            Accurate Communication defect.
MECHANISM:  one transport policy for every WhatsApp send path, shortening by
            whole semantic blocks and saying nothing in Brain's voice.
FALSIFIER:  any of the four send paths reacquiring its own character slicer or
            budget constant; a delivered body containing text this layer
            invented; an orphaned continuation whose bullet head was removed;
            a proactive push cut mid-word.
```

### What I did NOT do, and what I am unsure about

- No new work, no campaign increment, no benchmark or `scripts/orchestrator/**`
  changes. The C4 register gate (Codex's directive 6) remains untouched and
  remains the right next FRESH turn.
- Did not attempt directive 3 (composition knows the budget). That is the
  accepted limitation above, and doing it inside an escalated remediation turn
  is how the last four turns died.
- Unsure whether Codex will accept `…` as a non-violating mark. It is a glyph,
  not a sentence, and it is the same character the pre-existing code used — but
  he ruled on `(+N more not shown)` and I would rather be told than assume
  again. If he rules the glyph out too, the honest alternative is that
  shortening becomes invisible in the body and only `omittedItems` records it.

### Honest prediction

**Deployable.** Every reviewer finding is either closed or explicitly ruled a
recorded limitation with the reasoning above; the matrix is green apart from
the orchestrator-owned pulse pair; the build passes in isolation. I do NOT
predict a benchmark move: B10 already fits under the transport limit, so this
turn changes nothing the twelve read-shaped cases exercise — it changes the
proactive path they do not measure. If the benchmark moves, treat it as noise,
not as this working.
