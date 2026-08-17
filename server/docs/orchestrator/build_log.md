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
