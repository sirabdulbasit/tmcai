# The capability contract — standing instructions for every seat

**Owner ruling, 2026-08-12:** *"every change in codebase have impact of brain
capability and i think we have missed capturing it… can we build a standing
instructions for all agent?"*

He is right that it was missed. This document is the single place the rule lives,
and **all four seats read it: Builder, Reviewer, Scorer, Orchestrator.** It is
referenced from `prompts/build.md`, `prompts/review.md` and `prompts/score.md`
rather than copied into them — a rule that exists in three places has three
versions, and this codebase has eight recorded occurrences of exactly that
failure (`protection-with-two-implementations`).

---

## Why this exists

Ten iterations produced eleven shipped defects and **+0.6** total capability
movement. The work was largely sound — Codex ruled two iterations SOUND with zero
unsupported claims — but the capability effect of each change was never stated,
never checked, and never reconciled. What was measured instead:

- the Builder predicted **benchmark criteria** (C4, C6…), not capabilities;
- Codex checked **claims against the diff**, and capability was not among the
  claims;
- the Scorer read the **end state** of the codebase, with no per-change claim to
  confirm or refute.

So the chain lost the information at every hop. A change that genuinely improved
Memory could not be distinguished from one that improved nothing, because nobody
was required to say which it was.

## The nine capabilities

`BRAIN_VISION.md` order — never reordered, never abbreviated to a subset. The
professional-assistant benchmark for each, and the objective (95% of it):

| # | Capability | Professional | Objective | Today |
|---|---|---|---|---|
| 1 | Simple & Smart | 92 | 87.4 | 33 |
| 2 | Thinking | 94 | 89.3 | 36 |
| 3 | Memory | 92 | 87.4 | 60 |
| 4 | Accurate Communication | 94 | 89.3 | 73 |
| 5 | Authorized Action | 91 | 86.5 | 52 |
| 6 | Self Follow-Up | 96 | 91.2 | 43 |
| 7 | Learn | 90 | 85.5 | 42 |
| 8 | Self-Healing | 89 | 84.5 | 54 |
| 9 | Self-Pruning | 89 | 84.5 | 33 |

**340 of the 360 remaining points sit in capabilities 1, 2, 5, 6, 7, 8, 9 — none
of which the benchmark can currently measure.** Capability 4, the only one the
loop has been working on, is the *smallest* remaining gap.

---

## THE CONTRACT

### Every change declares its capability impact — BUILDER

No commit, no `DEF-NNN` row, and no build-log entry is complete without this
block. Four lines:

```
CAPABILITY: <one of the nine, by exact name>  |  RELIABILITY-ONLY
PREDICTED:  <+N, or "no capability movement">
MECHANISM:  <why this change moves that capability — the causal claim>
FALSIFIER:  <what observation would prove the prediction wrong>
```

Rules that make it honest rather than ceremonial:

- **`RELIABILITY-ONLY` is a first-class, respectable answer.** Most defect fixes
  are exactly that: they make an existing capability trustworthy without widening
  it. Declaring it costs nothing and keeps the card truthful. What is forbidden is
  claiming a capability movement to make a turn look productive.
- **One capability per change.** A change claiming to move three is a change whose
  effect cannot be attributed when the score moves.
- **The FALSIFIER is mandatory and must be observable.** "It should feel better"
  is not a falsifier. "A draft ask to a delegatee with no reply for 48h produces a
  chase without being asked" is.
- **A prediction of `+0` is fine and often correct.** A structural fix that closes
  a bypass may move nothing, and iteration 3 was scored 0 for exactly that after
  Codex ruled it SOUND. Predicting 0 and being right is a better turn than
  predicting +2 and being refuted.
- **Green tests never justify a capability claim.** Neither does a passing
  benchmark criterion on its own — the criteria measure twelve conversational
  replies and cannot see seven of the nine capabilities.

### Every review judges the capability claim — REVIEWER (Codex)

Add to the required review output, as its own numbered item:

```
CAPABILITY ATTRIBUTION
  claimed:   <what the build log declared>
  verdict:   SUPPORTED | OVERSTATED | MISATTRIBUTED | RELIABILITY-ONLY (correct)
  reasoning: <file:line evidence, as for any other claim>
```

- `MISATTRIBUTED` means the change does move a capability, but a different one.
  That is valuable, not pedantic: it is how the loop learns which surfaces map to
  which capability.
- `OVERSTATED` includes the common case of a real reliability fix dressed as
  capability growth.
- If the Builder declared `RELIABILITY-ONLY` and that is right, say so
  affirmatively. Silence reads as an unexamined claim.

### Every scoring reconciles claim against code — SCORER (Grok)

For each capability you score, when a claim exists for this iteration:

```
claimed:  <builder's declared movement>
verified: <what the code supports>
gap:      <why they differ, if they do>
```

- **Your number governs.** A Builder's `PREDICTED: +3` never becomes +3 because it
  was written down; it becomes whatever you can support from the code, including 0
  or negative.
- **Codex's verdict is evidence for you, not an instruction.** If Codex ruled
  WEAK on a truthfulness regression and you are raising that same capability, say
  explicitly why your reading survives that finding.
- `basis: "absent"` remains a real answer, and for capabilities 1, 2, 6, 7, 9 it
  is currently the expected one.

### Every iteration carries the claim through — ORCHESTRATOR

- The capability block goes into the ledger row alongside the benchmark numbers,
  so claim, review verdict and score sit on one line and can be read against each
  other later.
- **Where the Scorer and Reviewer disagree, the card shows it as disputed**
  rather than silently taking either side.
- A change whose capability block is missing is reported to the owner as an
  incomplete turn. Not blocked — reported.

---

## What this is expected to change

Not the rate of work; the *aim* of it. Right now every iteration lands on
capability 4 because that is what the benchmark gates on, and the other 340 points
are invisible. Once each change must name a capability and each review must judge
that naming, three things become impossible to hide:

1. **Iterations that improve nothing measurable** — they will read
   `RELIABILITY-ONLY, +0`, honestly, and the pattern will be obvious across rows.
2. **Capability drift** — a loop spending ten iterations on the smallest remaining
   gap will be visible as ten rows naming capability 4.
3. **Unmeasurable capabilities** — every `absent` and every missing falsifier is a
   direct argument for building the measurement surface (D-5), which is what
   actually unblocks the objective.

The contract does not make Brain better by itself. It makes the loop's aim
legible, which is the precondition for aiming it well.
