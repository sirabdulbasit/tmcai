# Orchestrator handoff — 2026-08-13, 11:30 UTC (state block rewritten; the 11:15 version is stale)

You are the **Orchestrator Manager** of a three-agent build loop at `/var/www/tmcai`.
Read `AGENTS.md` and `CLAUDE.md` first — they are the working contract. This file is
the live state and the things that will bite you.

## Your role, and the boundary the owner set

**You do not implement Brain code.** Owner ruling: *"you will not do any
implementation you are orchestrator engineer or bridger"*. You own the orchestration
(`scripts/orchestrator/**`), the measurement, the directives, and the Deck panel. The
Builder writes Brain code; Codex reviews it; Grok scores capability.

You also **own the honesty of the reporting**. The owner's standing demands:

- *"improvement should not be in numbers it should be in real"* (D-10)
- *"we are not here to increase just numbers of iteration we need significant
  improvements against each iteration"* (D-14)
- *"fixing defects and product work both is improving the capability"* (the English /
  Spanish analogy — repair counts, and undeployed work does not)

## The four seats

| seat | who | how |
|---|---|---|
| Builder | Claude session `b965a1bf-7923-4b81-a88a-f4490ddc8eb6` | `claude -p --resume`, model `claude-opus-5[1m]` |
| Reviewer | Codex thread `019ff185-597b-7333-927a-75b7a0a182a5` | write-restricted to `review_log.md` |
| Scorer | Grok `grok-4.5-build` | read-only, `--deny Write,Edit,MultiEdit` |
| Orchestrator | you | documents, rails, reporting |

Communication is **document-mediated on purpose** — `build_log.md`, `review_log.md`,
`operator_directives.md` — so every claim is auditable. Never pipe agents directly.

## How to run it

```bash
tmux new-session -d -s nexeo -x 200 -y 50 \
  "scripts/orchestrator/supervise.sh 2>&1 | tee -a /tmp/nexeo-loop.out"
```

`supervise.sh` is the entry point, not `nexeo-loop.sh`. It exists because the owner
said *"it should never be in idle"*.

- **`STOP`** (`server/docs/orchestrator/STOP`) — finish this iteration, then the
  supervisor **restarts**. This is the safe swap point.
- **`HALT`** — the only thing that actually stops the loop.
- A staged `nexeo-loop.next.sh` is syntax-checked and promoted **at the boundary**,
  automatically.

### THE RULE THAT WILL BITE YOU

**Never edit `nexeo-loop.sh` while it is running.** Bash parses the whole `while` loop
before executing it, so your edit does not affect the current run — but a size change
shifts the byte offset it uses for anything after the loop. Stage into
`nexeo-loop.next.sh` and let the supervisor swap it. I broke this rule twice today
and had to restore with `cmp`.

**Do not use `pkill -f nexeo-loop.sh`** — the pattern matches your own command line
and kills your shell (exit 144, twice). Use `pgrep -f "nexeo-loo[p].sh"`.

**Foreground `sleep` is a no-op in this harness.** Wait loops must be backgrounded.

## Where things stand right now

```
loop            running under supervise.sh (restarted 11:22:06); iteration 25 BUILDING
iteration 24    ABORTED — no work product. The tmux server hosting the loop died
                ~11:16, ~45s into the build, AFTER the header and BUILD line were
                written. Logged ABORTED in ledger.jsonl; not an iteration spent.
iteration 23    tsc clean · 182 files / 2207 tests · measured 94.9 / C4 86.7
                Codex: WEAK (2 HIGHs) · deployed=no · stall 9/3
deployed        NOTHING since iteration 16 (df47687, 06:39 UTC today) — 1 deploy in 14
capability      47.4 ±1.3   objective 87.3   (the band matters — see D-18)
campaign        C-3 Self-Pruning (33 → 60), active from iteration 25, 3 increments.
                C-2 Self Follow-Up PARKED — starved, not failed: 5 iterations open,
                0 increments, 3 of 8 budget unspent, every turn eaten by remediation
remediation     TWO bounds now, and they compose: NEXEO_REMEDIATION_LIMIT=1 (env, set
                at the tmux launch — a restart without it loses the bound) and the
                class bound in f5e7d10 (state/remediation-streak, limit 4, cleared
                only by SOUND). Both fired on 25; the marker path is closed as work.
staged          nexeo-loop.next.sh — escapes backticks that ate the reviewer's score path
```

### THE DECISION IS CLOSED — the owner ruled on 2026-08-13. See D-19 and D-20.

He was given the three options below and chose **campaign work on an absent capability,
branch stays undeployed** — not option 1, and explicitly **not** option 3. He added the
standing bar in the same breath: *"my ask is every iteration should be significant
improvement"*. Two follow-up rulings after the orchestrator verified premises in code:

- **A SOUND verdict SHIPS.** `deploy.sh:137` ships branch HEAD gated only on the current
  verdict, so a SOUND campaign turn carries the marker work to production. Told that, he
  ruled let it ship — he declined *lowering* the gate, not *meeting* it. `DEPLOY_ON=sound`.
  Verified first: **both HIGH paths are already live in production** (`isWholeMarker` at
  `df47687:188`, `markerVoice.ts` present in the deployed commit), so a deploy adds no
  exposure that is not already there.
- **The deletion turn (D-20) arms only if iteration 25 closes `deployed=no`.** Then
  iteration 26 DELETES the two text-inference fallbacks rather than repairing them a
  seventh time — provenance from iteration 23 stands alone, so they are a redundant
  second implementation. Not a remediation turn; do not log it as one.

The historical framing, kept because it is why the branch is where it is: two HIGHs
remain and both are **architectural completeness rather than live owner risk** —
`isWholeMarker(answer) && !!curated` only fires when the bracket text matches an
already-curated marker, so a legitimate `[see attached]` is returned untouched.

### Immediately next

1. **Report iteration 25 leading with `deployed=`.** If it closes `deployed=no`, D-20
   arms and iteration 26 is the deletion — say so to the owner in the same report.
2. If anything deploys, run `scripts/orchestrator/verify-chase.sh` immediately and
   quote him real production output, not a benchmark number.
3. **The significance bar is enforced, not asserted** (D-19): every iteration closes as
   `deployed=yes` or a named code-complete increment. Two consecutive iterations with
   neither → STOP the loop and go back to the owner rather than spend a third.
4. **Do not rebuild the autonomous chase** — it works (34 to delegatees; 27 accepted
   sends). D-12 is what is missing: re-verified 11:20 today, **zero of 31 sends carry a
   provider receipt**, so delivery is unconfirmed.
5. **A phantom iteration steals campaign budget.** 24's death made C-3 render as
   "iteration 2 of 5" on its first real turn; corrected in `campaign.json`
   (`from_iteration` 24 → 25). Check this after any mid-iteration crash.

## The five findings from today that change what you do

### 1. The scorecard could not measure change (D-18) — the biggest one

A from-scratch re-baseline (`run-score.sh <n> --fresh`) moved **all nine** capabilities
by up to 9 points on identical code. The instrument disagrees with itself by ±6–9 per
capability, ±1.3 overall — so *"+0.7 across 22 iterations"* is **inside its own noise**.
Cause was three instructions in `score.md` that jointly forbid movement, plus a fourth:
**the scorer reads only the codebase and cannot see runtime.** Fixed with
`evidence-pack.sh` (live aggregates in the prompt — counts only, never names, numbers
or message bodies, because it goes to a third-party model). Run `--fresh` every 5
iterations; never ingest it.

### 2. Nothing ships, and that is the binding constraint

Undeployed work scores zero by the owner's own contract. 13 iterations are held behind
two HIGH findings in one marker path. **The ship column (`deployed=yes/no`) is the
number to lead every report with.**

### 3. The autonomous chase already works — I nearly rebuilt it

`verify-chase.sh` on production: **34 follow-ups to delegatees, latest today**, one to
Hamna at 08:47 about an overdue item, unprompted. I had told the owner *"43 of 76 go to
the owner instead"* — **wrong**, I had grouped escalations in with follow-ups; it is 9.
What is actually missing: the **sent text is stored nowhere** (D-12), **no send has a
provider receipt** (delivery unconfirmed, 31 sends), and a **test fixture caused a real
chase to a real person** on 08-11.

### 4. Both rails pointed at the smallest gap

Accurate Communication is **15 of the 359 remaining capability points — 4.2%** — and had
received **22 of 22 iterations**, because the benchmark's fixQueue only names
conversational cases and the remediation rail chains to whatever the reviewer last
objected to. The starvation cap (`CAP_LIMIT`, default 3) now fires on measured campaign
starvation. Absent capabilities — Simple & Smart 33, Thinking 36, Self-Pruning 33 — are
44.3% of the journey with zero iterations spent.

### 5. The benchmark is a guard, not a gate (owner ruling)

`min(C1..C8) ≥ 95` was **unreachable**: C4 awards ≥95 in **4%** of 228 scorings and 9 of
12 cases never reached it. `regression-guard.py` replaces it — baseline is the median of
the last 5 runs, bands calibrated from 1728 comparisons (cell >12, case-mean >5), and it
labels `new` vs `chronic` so a long-standing wobble is not blamed on the current turn.

## Rails, and what each is for

| rail | fires when | gotcha |
|---|---|---|
| remediation | previous reviewed iteration was WEAK/WRONG | was silent 19 iterations — one `0x08` byte where `\b` was meant |
| lookback | picks the last **reviewed** iteration | not `ITER-1`; an aborted iteration used to skip remediation |
| re-scope | 2 consecutive iterations reached the owner with nothing | reads `state/fail-streak` |
| capability cap | campaign open ≥3 iterations with its capability unmoved | keys on **starvation**, not the declared `CAPABILITY:` line |
| guard | any measurement | reports chronic separately |
| ship | every iteration end | writes `deployed=` / `capability_moved=` |

Every rendered build prompt is saved to `logs/iter-N-build-prompt.md`. **Use it.** It is
how I proved the remediation note reached the Builder, and how I caught a zero-byte
prompt that had killed a build in 3 seconds (an unset `GUARD_TXT` under `set -u`).

## Open directives — read `operator_directives.md`

11 open. The ones that matter most:

- **D-12** the text Nexeo sends to the team is stored nowhere
- **D-13** the forced honorific comes out; Brain chooses register (owner ruling)
- **D-14** ship every iteration; stop enumerating phrases
- **D-15** a bracketed marker is never a reply
- **D-16** score what the owner HAS; report the branch separately
- **D-17** tag markers at creation; then ship. **The cap override expires after 23.**
- **D-18** the instrument fixes above
- **D-11** `DRAFT` is a live status the lifecycle matrix cannot express, so DRAFT items
  are frozen outside the only path allowed to move them

## Recurring shapes in this codebase — check before accepting a fix

- `protection-with-two-implementations` (11+) — the weaker path is the live one
- `guard-destroys-the-answer` (8) — iteration 21 sent the owner a debug marker as an
  entire reply
- `detector-is-a-list-of-sentences` (3) — enumerating what an LLM might say is not a
  strategy; four iterations proved it
- `fabricated-status` (5) — claiming work that did not happen

## How to report to the owner

Lead with **what he received**, then what is verified, then what is still broken, then
the verdict and next action (the five-line format is in
`brain_evaluation_chart.md` §2.1). State NOT VERIFIED plainly. He reads carefully and
he will check — he caught a missing capability number on the Deck within minutes today.

**Correct your own errors explicitly.** I made several today (a wrong "43 of 76", a
wrong ±2 noise band, an unevidenced "+20 step change" claim, telling him a card was
live when it was defined-but-never-rendered). He is owed the correction, briefly, and
then the work continues.
