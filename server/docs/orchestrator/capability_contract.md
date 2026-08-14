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

## OWNER RULING, 2026-08-13 — fixing and product work are BOTH capability

Verbatim: *"fixing defects and product work both is improving the capability. for
example if my english is weak, so teaching me english is fixing. and if i don't know
spanish language so giving me this skills is product work. both above definitely
improving my capabilities of communication. so don't take fixing and product work
separately for me both are part of improvment."*

**This overrides the framing this document shipped with**, which treated
`RELIABILITY-ONLY` as `+0` by default and reserved capability movement for new
behaviour. That was a builder's distinction — depth versus breadth — imported into a
scorecard that measures what Nexeo can DO for its owner. From where he sits, a Brain
that finally names the sender correctly communicates better, exactly as a Brain that
learns a new language would.

### The test is not "fix or feature". It is: DID WHAT THE OWNER RECEIVES CHANGE?

Credit capability when the change alters what actually reaches him — whether by making
something work that was failing, or by making something possible that was absent.
Both are learning; both count.

Do NOT credit when nothing observable changes for him:

- the change is on a path that never fires in production;
- it is internal hygiene — a refactor, a rename, a test-only change;
- a reviewer has shown the claimed mechanism does not reach the live surface (the
  `guard-below-early-return` and `protection-with-two-implementations` shapes);
- **it has not been deployed.** A fix sitting in the branch has changed nothing for
  him, however good it is. This is the honest reason twenty defects produced +0.6:
  not that repair work is worth less, but that it never arrived.

`RELIABILITY-ONLY` therefore no longer means `+0`. It means *"this improves an
existing capability rather than adding a new one"* — and it is scored on the same
evidence as anything else. The declaration still matters, because knowing WHICH
capability a change serves is what makes the card readable; what changes is that
choosing it no longer forfeits the score.

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

- **`RELIABILITY-ONLY` names WHICH KIND of improvement, not a zero.** Per the owner's
  2026-08-13 ruling, a fix that makes an existing capability work is capability
  improvement — so declare the capability it serves and predict a real movement if
  what the owner receives changes. Predict `+0` only when nothing reaching him
  changes: an unreachable path, internal hygiene, or work that is not deployed.
  What remains forbidden is claiming movement to make a turn look productive.
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

---

## OWNER RULING, 2026-08-14 — what SELF-HEALING means

*"in product vision there is self healing (it means to deploy itself automatically)"*

Until now this capability had a number (54) and no definition anywhere in the contract,
the score prompt or the campaign file — so the scorer has been rating it against its own
idea of the word, and the Builder had nothing to build toward. It is defined here, in
the owner's terms, and all three seats read it from this file.

**Self-Healing is Brain keeping itself running and current without being asked, and its
full form is that Brain ships its own repair to production.**

Scored as a ladder, because the rungs are separable and the top one is the goal:

| rung | what it means | evidence that it exists |
|---|---|---|
| 1 · detect | Brain notices its own failure — a dead worker, a failed send, a job not ticking | a health finding written without a human asking |
| 2 · recover | it restores service itself — restart, retry, re-lease, reconnect | the incident closes with no human command |
| 3 · repair | it fixes the underlying defect, not just the symptom | a defect closed by Brain's own change |
| 4 · **deploy itself** | **it puts that repair on production without being asked** | a production deploy whose author is Brain |

**Rung 4 is the owner's stated meaning and is where the remaining points are.**

### The one constraint, and it is not a hedge

A Brain that can deploy itself must refuse to deploy what a human deployer would refuse:
**a CRITICAL finding or an AGENTS.md §2 product-invariant violation never ships**, by its
hand any more than by ours (D-22). Iteration 13 shipped silent data loss and iteration
43 would have told the owner an answer was handled while writing nothing — a self-healer
without that refusal is a self-harmer with a faster loop. Self-deployment is therefore
built ON the deploy gate, never around it: same dirty-tree refusal, same idempotent
migrations, same probe, same evaluation-chart row, and the same one line it will not
cross.

**Today the orchestrator holds rung 4 by hand** (D-22, owner ruling the same day). That
is the human-held version of a capability Brain is meant to own, which makes it the
clearest target on the board: every mechanic is already written and exercised — what is
missing is Brain deciding, and being trusted, to run it.
