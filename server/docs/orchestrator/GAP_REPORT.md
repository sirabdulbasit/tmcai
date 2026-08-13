# Orchestrator gap report — full intelligence & control audit

**Written 2026-08-12 ~12:00 UTC, at owner request** (*"review the entire
orchestrator intelligence and its control and analyze any gap"*), under Fable 5,
for implementation under Opus 5. Audit only — nothing below is fixed yet.

**System state at audit:** loop mid-iteration 9 (build turn running), STOP armed
so iteration 9 is the last before restructure; scoring daemon exited cleanly
after scoring iteration 8; benchmark 95.3 overall / C4 87.3 gating / stall 2/3;
capability 47.3 vs 91.9 (scored by Grok); 10 defects shipped, none deployed.

---

## What is working (do not re-audit from zero)

- Three seats operating: Builder (Claude, session `b965a1bf`), Reviewer (Codex,
  thread `019ff185`), Scorer (Grok, two-phase read-then-format, evidence-gated
  ingest). Nine iterations completed, all with review; 7–8 scored independently.
- Rails hold: tsc/build/vitest gate every iteration; forbidden-path check runs
  post-build; STOP files stop both processes cleanly.
- Evidence discipline holds: scorecard refuses unevidenced scores (proven — it
  rejected Grok's placeholder pass); reliability axis separate from capability;
  per-iteration snapshots in history; scorer notes routed verbatim to Builder
  (S-1 in operator_directives.md).
- Convergent findings: Codex (from diff) and Grok (from code) independently
  agreed DEF-144 didn't reach the WhatsApp surface — the multi-agent design is
  producing real signal.
- Pulse window: per-phase timings from the loop's own log, capability bars,
  ≤74 columns, in-place redraw.

---

## CRITICAL — integrity of the loop's own records

### G1 · Codex's autonomous review scope includes orchestrator commits
`nexeo-loop.sh:598`: `DIFF_STAT="$(git diff --stat "$BASE_HEAD" HEAD ...)"` —
unscoped. Orchestrator commits made mid-iteration (pulse fixes, scorecard, this
report) land in the Builder's review range. Codex's iteration-2 WEAK verdict was
partly caused by exactly this ("225-line monitoring feature bundled without
review rationale"); it was fixed **only in the manually-rendered prompts**
(iterations 3–5), never in the loop. Autonomous iterations 6–9 all had polluted
ranges.
**Fix:** scope DIFF_STAT to `-- server/src server/tests server/prisma
server/docs`, and state in review.md that `scripts/orchestrator/**` is the
orchestrator's and out of scope (except the benchmark-integrity check, which
must stay).

### G2 · Reviewer–Scorer contradiction has no reconciliation
Iteration 8: Codex ruled **WEAK** — "globally preferring ungrounded model prose
for every successful WhatsApp action … does not provide the claimed fail-closed
containment" (a truthfulness regression, the project's most serious class).
Grok, same iteration, raised Accurate Communication 72→73, **PROGRESSIVE**. Both
had the same inputs. The card now shows +1 with no trace of the reviewer's
objection. Nobody arbitrates; the scorecard's credibility is the casualty.
**Fix (minimal):** ingest cross-checks the review verdict — a capability
increase in an iteration Codex ruled WEAK/WRONG must carry the objection in the
card's evidence line, and the pulse/card should show `codex WEAK · grok +1
(disputed)`. **Fix (fuller):** a one-shot arbitration prompt to the scorer:
"Codex found X; does your +1 survive that finding?" — its answer recorded.

### G3 · Score phase runs outside the sequence (owner ruling: strict sequence)
Scoring is a parallel daemon on its own clock; it scored iteration 8 while the
loop built iteration 9. Owner: *"none of Build, checks, measure, review, score
should run at a time, its a sequence work."*
**Fix:** retire the daemon; call `run-score.sh $ITER` from the loop after
REVIEW, then ingest, then ledger. Build → Checks → Measure → Review → Score.

### G4 · Measure/Review overlap must be unwound (same ruling)
The overlap was built for an earlier instruction ("both agents immediately
after each other") and costs Codex the fresh score — its strongest early finding
quoted post-build case text and it hasn't been able to do that since.
**Fix:** measure blocking, before review; pass the fresh SCOREJSON and a
SCORESTATE that says "this iteration's, measured after the build". Accept the
~5-min serial cost until G12/G13 make measurement faster.

---

## HIGH — control plane

### G5 · Stall counter does not survive restarts
`STALL=0` is in-memory (`nexeo-loop.sh:526`); the iteration counter persists but
the circling detector's memory does not. It stands at **2/3 right now**, and the
imminent restructure restart resets it to 0 — structural mode, the anti-circling
rail, is defeated by every restart.
**Fix:** persist STALL and BEST_MIN in `state/`, restore on boot, and note
"restored stall=N" in the ledger's restart row.

### G6 · A failed review is silently absorbed
If codex exits non-zero the loop logs "continuing" and moves on. The next build
prompt says "read the newest `## Iteration` section" — the Builder would read
iteration N-1's directive believing it current, with no marker that N's review
is missing.
**Fix:** on review failure, append a stub `## Iteration N — REVIEW FAILED
(orchestrator)` marker to review_log.md is WRONG (bridge must not write in
Codex's voice) — instead pass REVIEWSTATE into the next build prompt ("iteration
N's review failed; the newest entry is N-1's") and record it in the ledger row.

### G7 · The autonomous build prompt never forbids `scripts/orchestrator/**`
The prohibition was delivered only in manual SendMessage briefs (iterations
3–5). `prompts/build.md` contains no such rule, and Codex's checklist wouldn't
catch a Builder edit to the loop (it only guards benchmark/judge files). One
Builder turn "helpfully improving" the loop would be reviewed by nobody.
**Fix:** add the rule to build.md rules block; optionally add an orchestrator
self-check after each build turn (`git diff --name-only` ∩ `scripts/orchestrator/`
→ CRITICAL alert, same mechanism as forbidden paths).

### G8 · The loop's entire memory is untracked in git
`review_log.md`, `ledger.jsonl`, `orchestrator_ledger.md`, `loop.log`,
`scores/*`, `state/*` are untracked (verified: `??` in git status). One
`git clean -fd` — which a Builder turn could legitimately run — destroys the
audit trail, the scorer's continuity inputs, and the iteration counter.
**Fix (needs owner default):** loop commits the orchestrator docs at the end of
each iteration (named files, never a directory add — BLD-001), or explicit
.gitignore + a tarball snapshot per iteration. Recommend commit-per-iteration:
the audit trail belongs in history.

### G9 · Nothing survives a reboot
The loop and (former) daemon live in a user tmux session. `pm2` runs an
unrelated `nexeo-brain-watch`; no unit manages the loop. Owner ruling: "make
sure now these iterations will not stopped" — a box reboot stops them silently,
and state/iteration would resume but nothing would relaunch it.
**Fix:** pm2 unit (`nexeo-orch-loop`) wrapping the loop with restart-on-boot;
STOP file semantics already make restarts safe. Alternatively systemd. Either
way the pulse should show "loop process: managed/unmanaged".

---

## HIGH — economics and scale

### G10 · Seat context grows without bound
Builder transcript: **4.16 MB** after 9 iterations, replayed on every resume.
Codex iteration-8 review: **14,210,644 input tokens** (mostly cache reads, but
cache writes are billed and the thread grows every iteration). No rotation or
handover strategy exists. By iteration ~25–30 this is slow, expensive, and will
eventually hit hard context limits mid-loop — the in-session property becomes
the failure mode.
**Fix:** planned seat handover at a size threshold: the seat writes its own
handover summary (what it learned, what recurs, what to never retry), the
orchestrator opens a fresh session seeded with that summary + the governing
docs, and the ledger records the rotation. Applies to all three seats.

### G11 · No cost ledger
One observed build turn cost **$10.68** (claude result JSON carries
`total_cost_usd`); a measurement is 24 LLM calls; Codex/Grok usage is in their
output envelopes. Nothing is recorded. Owner is steering toward 100+ iterations
with no per-iteration cost line.
**Fix:** parse cost/usage from each phase's raw output into `ledger.jsonl`
(`cost_build_usd`, `tokens_review`, `cost_measure_est`), and show cumulative
spend in the pulse. The data is already on disk in the raw logs — backfill is
possible.

---

## HIGH — instrument validity (these cap everything else)

### G12 · D-1 unfixed: every measurement writes the owner's live tenant
`WARNING … benchmark MUTATED live data` fired on every one of ~11 runs; the same
row (`cmsotakwf…`) has been created and repeatedly edited. Directive D-1 (teardown
via `transitionStatus → CANCELLED`, unrevertables reported) has not been picked
up by any Builder turn.
**Fix:** force-rank D-1 next iteration; it blocks G13 (sampling multiplies
writes).

### G13 · D-4 unfixed: the gate steers on noise
C4 readings on near-identical code: 90.0 / 87.9 / 88.3 / 87.3. The stall
counter keys off ±1 moves inside a ±3 instrument. The loop re-picked its gating
criterion (C4→C6→C4) on single samples.
**Fix:** median-of-3 sampling per case (after D-1), report per-criterion spread,
and make the stall comparison use the median ± spread.

### G14 · The gate as defined may be structurally unreachable
`brainResponseEvaluator.ts:89`: any criterion where the judge can name an
improvement scores **≤85**. The gate demands min ≥95 across 8 criteria × 12
cases simultaneously, inside ±3 noise. Passing requires the judge to find
literally nothing to name, 96 times in a row. Risk: the loop runs to
`MAX_ITER=40` doing sound work and "fails". Also: the gate arithmetic is
hardcoded to the 12 compose cases, so D-5's new surfaces won't gate anything.
**Fix (owner decision required):** either (a) redefine pass as e.g. "3-run
median: overall ≥95 AND min ≥90, no criterion regressing", or (b) keep 95 as
aspirational and re-anchor the loop's stop condition on the capability
scorecard instead. The gate must also learn to read the D-5 slices once they
exist (separate thresholds per surface, never folded into one average).

### G15 · D-5 not started: five capabilities still invisible
No iteration has begun the measurement surfaces (verified: no D-5/proactive
uptake in iterations 8–9 build entries). Self-Pruning, Self Follow-Up, Learn,
Authorized Action, Memory (+205 of the +40.4 objective gap) remain unmeasurable,
so the loop keeps landing on Accurate Communication.
**Fix:** already ranked first in directives; keep it there and protect it from
being preempted by another C4 patch — if iteration 10 doesn't start D-5, the
orchestrator should say so to the owner rather than let it slide again.

---

## MEDIUM — observability and hygiene

### G16 · Pulse attributes concurrent phases to the wrong iteration
Owner screenshot: Grok scoring iteration 8 rendered under "Iteration #9".
Becomes rarer once G3 serialises, but restarts can still mislabel.
**Fix:** label each phase row with its own iteration when it differs from the
header.

### G17 · Measure/Checks phases show no progress line
The "Progress <phase>" line only reads Build/Review/Score streams. The benchmark
writes per-case lines and the rails know which tool is running — both could be
tailed. Cosmetic.

### G18 · D-2 unresolved: `32ba427` (DEF-132/133) has no review and no deploy
Contains a within-tenant authorisation-hole fix (DEF-133), mutation-verified,
sitting unreviewed for a day. **Fix:** give Codex a one-off special review turn
for that commit range, then hand the deploy decision to the owner.

### G19 · No deploy package
10 defects, 1 pending migration (`20260811b`), zero deployed; live Brain
unchanged since D-22. The longer it accumulates, the riskier the eventual
deploy, and no document assembles it.
**Fix:** orchestrator maintains `DEPLOY_PACKAGE.md`: pending DEFs in order,
migrations, per-DEF live-acceptance checklist, rollback notes. Deploy itself
stays owner-gated.

### G20 · Scorer double-score guard is file-existence only
Deleting `iter-NN-capability.json` re-scores that iteration and appends a second
history row (double-counted movement). Low likelihood; cheap guard: ingest
refuses an iteration already in history unless `--rescore` is passed.

---

### G21 · Owner-report intake (raised by owner post-audit; basic version now exists)
The owner communicates with the live Brain and had no defined way to report an
issue into the loop. Created at audit time: `owner_reports.md` (intake file,
append-only, loose format) + directive **D-6** making UNPROCESSED reports outrank
the whole queue — wired through operator_directives.md, which every build turn
already reads, so no loop-script change was needed. **Left for Opus:** an ack-back
mechanism (owner should see "R-1 → CL-034/DEF-147" without opening files — pulse
line + card line), dedup against existing DEF rows, and an urgent path (stop loop
after current phase, inject report first).

### G22 · Pulse in-place redraw breaks when the frame is taller than the terminal
Owner's paste (12:17–12:19): full frames stacking in scrollback, one truncated
mid-frame, despite in-place mode. Cause: the frame has grown to ~23 lines (5 phase
rows + 9 capability bars + summary lines). `\033[H` homes to the top of the
*viewport*; when the terminal has fewer rows than the frame, every write scrolls
the overflow into scrollback, so "redraw in place" degrades to exactly the
stacking it was built to end. The truncated middle frame is the scroll interaction
mid-write, not data loss.
**Also (same item, second owner report):** a PARKED loop renders as
`Progress: nobody working`, indistinguishable from a hang — the owner read a
cleanly-stopped system as "stuck". The pulse must read the loop's process state
and say which: `LOOP STOPPED after iteration 9 (STOP consumed) — relaunch
pending` vs `idle between phases` vs `no loop process — NOT managed`. A status
window that cannot tell "finished as instructed" from "frozen" fails at its one
job.
**Fix (Opus):** use the alternate screen buffer (`\033[?1049h` on entry, restore
on exit — what watch/top do), which gives a fixed viewport regardless of frame
height; AND read `shutil.get_terminal_size()` each tick — if rows < frame height,
compact (drop spacer lines, single-line phases) and show "…enlarge window" rather
than silently scrolling. Keep per-line `\033[K`.
Note also visible in the same paste, expected not defective: iteration 9 shows
`Score: —` because the daemon was stopped pre-restructure — the sequential loop
must score it on relaunch (already in the handover notes).

### G23 · ~~Pulse displays UTC clock times with no zone label~~ FIXED 2026-08-12 17:45 PKT (owner reported it twice — second report treated as a fix request)
Owner report: pulse shows "Iteration Started: 11:51:36" while his clock reads
5:31pm — the box runs UTC, the owner is UTC+5 (PKT, the zone every governing doc
already uses for deploy rows). Elapsed timers are unaffected. A subtlety for the
fix: `phase_timeline()` parses log stamps with `time.mktime(strptime(...))`,
which reads them as SERVER-LOCAL — correct only while server-local happens to be
UTC, and it silently breaks if TZ ever changes (a `TZ=Asia/Karachi` workaround
would skew every elapsed figure by 5h, so there is NO safe env workaround).
**Fix (Opus):** parse log stamps as UTC explicitly (`calendar.timegm`), display
in Asia/Karachi, and LABEL the zone ("17:31 PKT") — an unlabeled clock in the
wrong zone reads as a lie, labeled it is merely a preference.

### G24 · The verification rail is non-deterministic — a green rail can be a red tree
On one unchanged commit: loop rails GREEN (2053 passed) → Codex RED (8 failed) →
orchestrator RED (8 failed) → the failing file GREEN in isolation (19/19). Cross-file
~~pollution~~ in `tests/def140OwnerAddressBoundary.test.ts`.

**CORRECTED 2026-08-12 13:35 — that diagnosis was wrong, and so was Codex's.** The
Builder reproduced the failure and printed the program's own refusal:
`NOT SENT reason={"sent":false,"reason":"outside_office_hours"}`. `brainContactsUser`
gates delivery on OFFICE HOURS (`brainOutboundService.ts:450`, DEF-120) and the test
never bypassed the gate — so it passed inside the working day and failed outside it.
The rails' green at 12:59 and Codex's red minutes later were different sides of that
boundary; my "passes in isolation" run was simply inside the window, not evidence of
isolation. Codex had blamed Redis idempotency. Three agents, three diagnoses, and
only the one that asked the system was right — the chart's own recorded lesson, with
the orchestrator and reviewer as this instance's offenders. Fixed in DEF-153, and the
standing rule is now in D-8: time-dependent behaviour must be INJECTED in tests,
never read from the wall clock. The double-sampling rail still ships, but for a
better reason than I gave — two samples seconds apart would both have been green,
because a clock-dependent suite is red for hours at a stretch.

Consequences for the
orchestrator, beyond the Brain-side fix (filed as directive D-8): (a) `test_status()`
takes one sample and trusts it; (b) the new deploy phase gates on that same single
sample; (c) the Builder's published verification numbers are unfalsifiable when the
suite is order-dependent — Codex has now caught two false-green claims.
**Fix (Opus, orchestrator side):** on a green result the rail should re-run once and
require both green before proceeding (cheap: ~20s), report DISAGREEMENT explicitly
when the two differ, and record both samples in the ledger. Do not "fix" flakiness by
retrying until green — that converts a real red into a reported green, which is the
exact failure this project has a chart section about.

### G25 · Campaign lifecycle had a rule and no enforcement (partially fixed 2026-08-13)
The campaign file stated from the outset that "a campaign ends when its exit
condition is met or its budget is spent — whichever first — and the orchestrator
records which. Never silently extended." Nothing implemented it. At iteration 15 the
build prompt rendered "ACTIVE CAMPAIGN C-1 … (iteration 4 of 3)" — over budget, with
C-2 due to start at 15 and nothing to start it. A rule with no enforcement is a
comment, and this one was mine.
**Done:** `campaign-advance.sh` decides continue / roll-over / budget-spent at the
end of an iteration, writes the closed campaign into `history` with its outcome, and
deliberately REFUSES to extend a budget itself — an extension is a judgement with a
reason and belongs in `extended[]`. C-1's own extension (3→5) is recorded there with
why: neither half of its exit condition is met (Codex ruled the slice synthetic; D-1
teardown absent after 14 live-data writes), and C-2 cannot be scored without an
end-to-end proactive measure.
**Left for the loop:** call it from `nexeo-loop.sh` after the SCORE phase, and
surface `exit_condition_status` + `budget left` in the pulse/Deck so an over-budget
campaign is visible on the dashboard rather than only in a prompt. Until wired, the
orchestrator runs it by hand each iteration — which is exactly the manual step that
let this drift in the first place.

## Suggested build order for Opus 5

1. **G3+G4+G1** — one restructure of `nexeo-loop.sh` (sequential phases, scoped
   review, score phase in-loop) + G16 label fix + G22 alt-screen redraw. (G23 PKT clock: already fixed.) The loop is already stopping
   after iteration 9 for exactly this.
2. **G5, G6, G7** — control-plane patches in the same edit (stall persistence,
   REVIEWSTATE, build.md prohibition).
3. **G8 + G9** — audit trail committed per iteration; pm2 unit. Ask owner only
   if he objects to docs-in-git.
4. **G11** — cost ledger (data already on disk).
5. **G2** — disputed-score marking in ingest (small); arbitration prompt later.
6. **Relaunch.** Then hold the Builder to **D-1 → D-4 → D-5** (G12–G15), which
   are directives, not orchestrator code.
7. **G14** — needs an owner decision on the gate; present options (a)/(b) with
   this report's evidence.
8. G10, G18, G19, G17, G20 as capacity allows; G10 before iteration ~20.

**Effort estimate:** items 1–5 are one focused session; 6–8 are ongoing
governance.
