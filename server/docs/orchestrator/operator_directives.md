# Operator directives — owner → Builder, through the orchestrator

Owner ruling, 2026-08-11: **"you will not do any implementation, you are
orchestrator engineer or bridger"** and **"this Brain Builder's task to build and
Codex to review"**.

So the orchestrator never edits Brain code. Anything it or the owner wants built
is written HERE, and the build prompt reads this file every iteration. This is
the only channel from outside the loop into it — the orchestrator does not write
into `build_log.md` (the Builder's voice) or `review_log.md` (Codex's voice),
because a bridge that speaks in either agent's name destroys the record of who
actually claimed what.

**Precedence:** Codex's ranked directive in `review_log.md` comes first. These are
standing items that persist until done, and a Builder turn that skips one must say
why in its build entry rather than ignore it silently.

---

## D-1 · OPEN · The benchmark writes to the owner's live backlog

**Observed, twice, in the harness's own output:**

```
iter-00  B04-outstanding-question-ignored dispatched add_open_item
         (cmsotakwf0006rts1bdsrjjkj) — live data was written
         open_items 282 → 283 across the run — the suite wrote rows
iter-01  B04-outstanding-question-ignored dispatched update_open_item
         (cmsotakwf0006rts1bdsrjjkj) — live data was written
```

`nexeoCapabilityBenchmark.ts` measures through `answerAsBrain`, the real entry
point, so a case that provokes a dispatch writes a real row in TMC-0001. Across a
40-iteration loop that is tens of junk rows in the backlog Nexeo is supposed to be
managing — and on `open_items`, the table DEF-129/132 just finished repairing.

**Do NOT fix this by adding a non-dispatching "benchmark mode".** A second path
that answers without acting would measure something other than production, which
is `protection-with-two-implementations` — the shape with seven recorded
occurrences in the chart, and the reason DEF-118 sat broken for 21 hours. The
measurement must keep going through the real composer.

Suggested shape, but the decision is the Builder's to argue:

1. Record every dispatched artifact (`kind` + `artifactId`) during the run.
2. **After all scoring is complete** — so teardown can never influence a score —
   withdraw the rows the suite CREATED via `transitionStatus(..., 'CANCELLED')`.
   CANCELLED, not CLOSED, and not a raw delete: benchmark noise was never
   completed work (DEF-129), and going through the matrix leaves a ledger row
   naming who removed it and why.
3. A write to a **pre-existing** row (`update_open_item`, `delegate_open_item`)
   is NOT undoable this way — cancelling it would destroy a real item of the
   owner's. Report those explicitly as unrevertable; never quietly imply clean.
4. Re-count afterwards and report whether the tenant actually returned to
   baseline. A teardown that *ran* is not a teardown that *worked* — BLD-007.

**Already-written rows:** `cmsotakwf0006rts1bdsrjjkj` was created by iter-00 and
edited by iter-01. Decide deliberately whether it is now junk to withdraw or a
real item that must be left alone, and say which.

**Note the self-limiting effect:** as C3 improves, B04 stops minting rows on its
own — iter-01 already downgraded from `add` to `update`. That is evidence the
defect is closing, not a reason to leave the teardown unbuilt.

---

## D-2 · OPEN · DEF-132 / DEF-133 need Codex review before any deploy

Commit `32ba427` was written before the build/review split existed, so it has had
**no Codex review**. It is committed and **not deployed**. Two live-affecting
parts:

- **DEF-133** — `changeStatus` passed `actor: 'system'` while still accepting an
  `actor` argument, so the ledger DEF-127 restored recorded `system` for every
  human and agent status change, and `is_owner_or_agent` (which treats `system`
  as always authorised) could let a non-owner move another user's item within the
  tenant. Shipped live in D-22; fixed in `32ba427`, mutation-verified.
- **DEF-132** — three writers (`cleanupDuplicateOpenItems`, the backlog pruner,
  the `archive` handler) were minting statuses outside the v15 set, which
  `transitionStatus` refuses, making every row they touched permanently
  unmovable. Fixed, plus migration `20260811b_…` repairing by shape.

**Owed:** a Codex review of `32ba427`, and — separately, on the owner's word, not
the loop's — applying `20260811b` and restarting before those fixes are live.

---

## D-4 · OPEN · The measurement cannot yet tell a gain from noise

**Evidence, from `scripts/orchestrator/progress.py` across the first three
measurements:**

```
C1 Truthfulness       ▁█▁   89.6 → 90.0    +0.4
C2 Grounding          ▆█▁   96.3 → 91.3    -5.0
C3 Continuity         ▄█▁   92.5 → 89.2    -3.3
C4 Human voice        ▁█▂   84.8 → 85.8    +1.0
C6 Completeness       █▇▁   94.6 → 84.6   -10.0   ← now gating
OVERALL               ▄█▁   92.7 → 90.1    -2.6
```

Every criterion shows the same middling-high-low shape, and six of eight are below
where they started. **One code change cannot depress eight independent criteria
uniformly** — that is the signature of run-to-run variance, not of Brain getting
worse. The harness's own docblock already says a case score is one sample from a
non-deterministic model.

The consequence is not cosmetic. The gating criterion moved **C4 → C6 on a single
sample**, so the loop re-aimed at a different target for no demonstrated reason. A
loop that re-picks its target from noise can run its full 40 iterations producing
motion and no progress, and the capability scorecard cannot honestly credit a gain
it cannot distinguish from variance.

**Sample each case more than once and score the median** (2–3 runs). Report the
spread per criterion so the loop — and the reviewer — can see how large a move has
to be before it means anything. If a criterion's run-to-run spread is ±5, then a
+3 "improvement" is not one, and saying so is more valuable than the +3.

Two constraints:

- **Do not lower the judge or soften a case to reduce variance.** The calibration
  gate exists precisely because that is the one failure this loop cannot see from
  the inside.
- Repeated runs multiply the live-data writes in **D-1**, so D-1 lands first or
  the two directives fight each other.

Ranked FIRST once the owner confirms: until the measurement is stable, every
iteration after it aims with a shaking sight.

## D-5 · RANKED FIRST from iteration 8 · Build the measurement surfaces

**The loop has run out of things its instrument can see.** Six iterations, and the
capability card reads:

```
iter 1  +0.9   iter 3   0.0   iter 5   0.0
iter 2  +0.1   iter 4  +0.1   iter 6   0.0
```

Every one landed on Accurate Communication, because it is the only capability
twelve conversational replies can exercise. Meanwhile the owner's objective is 95%
of a professional assistant — 87.3 overall against 46.9 — and **five capabilities
that account for +205 of that gap are invisible to the benchmark**: Self-Pruning
(needs +51.5), Self Follow-Up (+48.2), Learn (+43.5), Authorized Action (+34.5),
Memory (+27.4). Nothing in the suite touches any of them.

So more iterations of compose-defect hunting cannot reach the objective, however
well executed. The instrument has to grow.

### A restriction of mine that was wrong, and is hereby lifted

I told the Builder the benchmark is mine and not to modify it. For **existing
cases, the judge's rubric, and the gate arithmetic that stands** — those must never
be edited to move a score, and that rule is absolute. But it also blocked the
Builder from ADDING the slices Codex asked for, on a file the owner's ruling makes
its responsibility to build. Both things cannot be true. Resolution:

- **ADDING new cases and new scored surfaces: the Builder's job, and now asked for.**
- **CHANGING the twelve existing cases, `brainResponseEvaluator.ts`, or the gate:
  still forbidden.** Report new surfaces SEPARATELY; never fold them into the
  existing average, which would move the headline number without improving Brain.

### What to build, in order

1. **The proactive slice**, exactly as Codex specified in `review_log.md` §Iteration
   4 directive 3: draft ask, lifecycle intervention, unattached unknown reply,
   duplicate messages in one polling cycle, delegatee "no progress" option
   generation, and the Roman-Urdu identity question `Kon`. Report compose and
   proactive scores separately plus a traffic-weighted verdict. This is the surface
   that produced 14 of 19 messages in CL-033 and is currently unmeasured.
2. **Memory recall.** Something that asks Brain a question whose answer exists only
   in the wiki/embedding store and scores whether it retrieves rather than guesses.
   DEF-118 sat broken for 21 hours with 63% of memory on meaningless vectors and no
   test could see it — that is what an unmeasured capability costs.
3. **Self Follow-Up.** A scenario where a commitment's deadline passes and the score
   depends on whether Brain chases it unprompted.
4. **Self-Pruning.** Junk arrives; the score depends on whether it is withdrawn
   without being asked. The backlog pruner exists (DEF-132) and is unmeasured.

Each slice may start small — two or three cases — but must go through the REAL path
(`answerAsBrain`, the real jobs, the real judge), for the same reason the compose
suite does: a slice that measures a stub measures nothing.

**D-1 applies with more force here.** These slices exercise write paths, so build
the teardown first or state plainly which rows each slice leaves behind.

## D-3 · STANDING · Report the ledger honestly

Every build entry states the verification numbers measured **after** the last
edit, and reconciles claimed test counts with the actual suite delta. Codex caught
iteration 1 claiming "+19 tests" against a real delta of +1 passed; that kind of
arithmetic is what makes a green report worthless.
