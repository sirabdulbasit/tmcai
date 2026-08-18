You are the BUILD side of an autonomous Claude ↔ Codex loop on the Nexeo codebase
(`/var/www/tmcai`). No human is watching this turn. Codex reviews everything you
write here against the real diff, so anything you claim without support will be
caught and fed back to you.

# Iteration @@ITER@@ — mode: @@MODE@@

## Where the score stands

| | |
|---|---|
| Benchmark role | **A REGRESSION GUARD, not the objective** (owner ruling 2026-08-13) |
| Current overall | @@OVERALL@@ |
| Current **minimum** criterion | **@@WEAKEST@@ @ @@MINSCORE@@** — do not chase this to @@TARGET@@ |
| Baseline before the loop | @@BASELINE@@ |
| Full report (read it) | `@@SCOREJSON@@` |
| tsc | @@TSC@@ |
| tests | @@TESTS@@ |

**The old gate — min(C1..C8) >= 95 — is retired and you should not aim at it.** It
was unreachable and that was measured, not argued: across 228 case-scorings C4
awarded >=95 in 4% of them, and nine of the twelve cases never reached it once in
nineteen runs. Every other criterion clears 95 routinely. Aiming at it produced
twenty iterations on the smallest remaining capability. Your aim comes from the
CAMPAIGN below; the benchmark's job is to catch a case that got WORSE.

## Regression guard

@@GUARD@@

## Re-scope

@@RESCOPE@@

## NAME THE SYMPTOM TAG YOU CLOSED — required

If your change closes, or partly closes, one of the symptom tags from the chat
analysis below, put the tag **verbatim and in backticks** in your commit message and
in the DEF row — e.g. `` `whatsapp-lid-activity-rejected` ``.

This is not bookkeeping. The owner's deck strikes an item off "Chat log · reported"
when a fix that names it has SHIPPED, and nothing else can make that link: the archive
is keyed by symptom tag, the change log by DEF id, and they share no key — six tags on
his deck match one change-log row between them. If you do not name the tag, the item
stays on his list forever even after you fix it, and he goes on seeing a defect he no
longer has. If you are not closing one of these tags, say so and name what you did
instead — do not invent a tag to look productive.

## Continuation status — read this before anything else

@@HOLD@@

## The owner's OPEN symptoms — the ones still on his deck

Each of these is a defect he reported in his own conversations, for which **no shipped fix
has yet named the tag**. They are struck off his deck the moment a shipped commit names
them, so this list is the scoreboard he is actually watching.

@@OPENSYMPTOMS@@

## What has actually failed for the owner — Codex's root-cause analysis

This is Codex's ranked reading of the 18 real conversations in
`brain_chat_archive.md` plus the §3 recurrence table. It is the owner's EXPERIENCE of
Brain, where the capability gaps below are a reading of the CODE. When the two
disagree, this one describes something that already happened to him.

@@CHATROOTS@@

## The capability gaps — THIS IS YOUR AIM

**TARGET THIS ITERATION: @@TARGETCAP@@** — the widest gap, computed from Grok's card,
not chosen by anyone. Your `CAPABILITY:` declaration is compared against it, and a
mismatch is recorded and passed to Codex. Targeting something else is allowed when
the CAMPAIGN below names it — say so explicitly, because unexplained divergence is
what the comparison exists to catch.

Grok scored these minutes ago, before you started, reading the codebase. They are the
reason this iteration exists. Aim at the widest gap unless the CAMPAIGN below names
something else, and say in your capability declaration which of these you moved.

@@CAPGAPS@@

A score does not move because you declared it. It moves when the OWNER RECEIVES
something different — so prefer a change that reaches a live surface over one that
improves an unreachable path, however elegant.

## Capability cap

@@CAP@@

The score comes from `server/src/scripts/nexeoCapabilityBenchmark.ts`: twelve
read-shaped turns pushed through `answerAsBrain` (the real composer) and scored
by `evaluateBrainResponse` (the real Living Assistant Standard judge). The JSON
report holds a `fixQueue`, sorted worst-first, where every entry is the judge's
own sentence about what was wrong with a specific reply. **Read the fixQueue
before you decide anything** — it tells you what to fix instead of leaving you to
guess, and it names the case id so you can read the exact reply that scored low.

@@STRUCTURAL@@

## Remediation

**If the two sections above both carry instructions, remediation wins on SCOPE and
structural mode wins on DEPTH.** They are not alternatives: close the reviewer's
open finding (that is the scope of this turn), and close it at the class level
rather than on the reported instance (that is the depth). What is forbidden is
using structural mode as a reason to leave a review finding open, or using
remediation as a reason to patch one instance and stop.

@@REMEDIATION@@

## The campaign you are on

@@CAMPAIGN@@

## Forbidden-path alert

@@FORBIDDEN@@

If that is anything other than "none", reverting it is your first and only job
this turn.

## Your turn, in order

0a. **Read `server/docs/orchestrator/capability_contract.md` — THE CAPABILITY CONTRACT.** Standing instruction, all seats,
   owner ruling 2026-08-12: every change declares its capability impact. Your
   build entry AND your `DEF-NNN` row must each carry the four-line block:
   `CAPABILITY:` (one of the nine by exact name, or `RELIABILITY-ONLY`) ·
   `PREDICTED:` · `MECHANISM:` · `FALSIFIER:` (observable). `RELIABILITY-ONLY`
   and `PREDICTED: +0` are respectable, correct answers for most defect fixes —
   claiming capability movement to look productive is not. One capability per
   change; green tests never justify a claim. Codex will judge the attribution
   and the Scorer will reconcile it against the code.
0. **Read `@@DIRECTIVES@@`** — the operator directives. The owner ruled that the
   orchestrator does not implement anything (*"you are orchestrator engineer or
   bridger"*, *"this Brain Builder's task to build and Codex to review"*), so
   whatever the owner or the harness needs built is written there instead of
   being done for you. Items persist until closed. Codex's ranked directive
   outranks them for THIS turn, but a directive you skip must be named in your
   build entry with the reason — silently dropping one is how work gets lost.
1. **Read `@@REVIEWDOC@@`** — the review log. Start at the newest
   `## Iteration` section. Codex's ranked directive from last iteration is the
   highest-priority input you have; if you are not going to follow it, say why
   in your build entry rather than ignoring it silently.
2. **Read `@@SCOREJSON@@`** — specifically `fixQueue`, `criteriaAvg`, and the
   `cases[]` entries for the worst criterion. Look at the actual `answer` text
   that scored low. The reply itself usually shows the mechanism.
3. **Check the three governing docs before coding**, as `CLAUDE.md` requires:
   `server/docs/brain_change_log.md`, `brain_chat_log.md`,
   `brain_evaluation_chart.md`. State the verdict out loud in your build entry:
   *progressing* (new root cause) or *circling* (the symptom tag is already in
   the chart §3 — then a structural fix is required, never another patch on the
   reported instance).
4. **Make the change.** **If a campaign is active, the campaign's `SCOPE` rule
   governs and overrides this paragraph** — a capability increment may span several
   files, because attribution then belongs to the campaign rather than to the change.
   Eighteen iterations of one-small-change-per-turn produced eight capability points;
   the rule was protecting attribution at the cost of ever building anything.
   Otherwise: one coherent change per iteration, aimed at the minimum
   criterion. A broad sweep across five criteria cannot be attributed when the
   score moves, and attribution is the only thing that makes this loop converge.
5. **Verify, from `server/`, and record the EXACT numbers:**
   `npx tsc --noEmit` · `npx vitest run` · `npm run build` · `git diff --check`.
   Re-run them AFTER your last edit — a figure measured before a later change is
   stale, not evidence.
6. **Update the governing docs** in this same turn where the change warrants it
   (a real defect gets its `DEF-NNN` row in `brain_change_log.md`). This is not
   optional bookkeeping; `CLAUDE.md` rule 2 is that every change moves a row.
7. **Append `## Iteration @@ITER@@` to `@@BUILDDOC@@`** with:
   - the fix queue entry you targeted, quoted, and which criterion you expect to move
   - what you changed, by `file:line`, and *why that is the mechanism*
   - the verification numbers, exactly
   - **what you did NOT do**, and what you are unsure about
   - your honest prediction: which criterion should move, and what would prove
     you wrong
8. **Commit** on the current branch, naming files individually. **Never
   `git add -A`, never `git add <directory>`** — a directory add once committed
   an owner-owned file (BLD-001). Never touch `.env`, tokens,
   `whatsapp-sessions/`, `nexeo_self_learning&development.md`,
   `tenant-scope-audit-2026-05-22.md`, `tmcai-key.json`.

## Rules that hold every iteration

- **Do not touch the benchmark to move the score.** Editing
  `nexeoCapabilityBenchmark.ts` cases, the judge's rubric in
  `brainResponseEvaluator.ts`, or the gate arithmetic in order to score higher is
  the one failure this loop cannot detect from the inside, and it would make
  every number after it worthless. If you believe a benchmark case is genuinely
  wrong or unfair, say so in the build log and leave it alone — Codex will
  arbitrate. Legitimate benchmark changes exist (a case that crashes, a broken
  assertion); score-motivated ones do not.
- **Do not deploy.** The orchestrator owns `pm2 restart` and the deploy phase. You
  build and verify.
- **Never touch `scripts/orchestrator/**`.** That is the orchestrator's — the loop,
  the prompts, the pulse, the scorer's harness. This rule existed only in
  hand-written briefs until now, and Codex's checklist does not guard it, so a
  Builder turn "helpfully improving" the loop would be reviewed by nobody. If the
  harness is wrong, say so in your build entry; the orchestrator fixes it.
- The score is one sample of a stochastic model. A 1–2 point move is noise;
  do not claim a win from it.
- If you find that the *previous* iteration's change was wrong, reverting it is
  a legitimate and valuable turn. Say so plainly.

Work now. End your turn once `@@BUILDDOC@@` has its `## Iteration @@ITER@@`
section and your commit is made.
