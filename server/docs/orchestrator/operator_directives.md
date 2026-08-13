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

## D-7 · ITERATION 10 IS STRUCTURAL MODE (stall carry-over across restart)

The stall counter reached **3/3 at iteration 9's close** — C4 has not improved for
three consecutive iterations (88.3 → 87.3 → 87.3, iterations 7–9) — and the
counter is in-memory (gap G5), so this restart silently reset it to 0. The rail's
verdict carries over by this note instead: **iteration 10 runs under CLAUDE.md
rule 5's circling verdict. Another patch on a C4 instance is FORBIDDEN.** Change
the mechanism that keeps producing the class, or execute D-5 (the measurement
surfaces), which is the standing structural direction and already ranks first.
This item expires once iteration 10's build entry acknowledges it.

---

## D-8 · CLOSED 2026-08-12 by DEF-153 — root cause was the office-hours gate, not pollution

**Resolved, and my guidance in this directive was misdirected.** I told the Builder
to hunt a `vi.mock` leak; the actual cause was `brainContactsUser` gating on office
hours (`brainOutboundService.ts:450`, DEF-120) with the test never bypassing the
gate — so it passed inside the working day and failed outside it. Codex blamed
Redis idempotency. Both of us reasoned from theory; the Builder printed the
program's own refusal (`NOT SENT reason={"sent":false,"reason":"outside_office_hours"}`)
and had the answer in one run. That is the chart's own lesson — *diagnosing from
theory instead of asking the system* — and this time the orchestrator and the
reviewer were the ones doing it.

**Standing rule that comes out of it:** any test touching behaviour that varies with
wall-clock time, office hours, quiet hours or timezone must INJECT the time, never
read it. A clock-dependent suite is not flaky in the retryable sense — it is red for
hours at a stretch, which no amount of resampling detects.

---

## D-8-OLD (superseded, kept for the record) · The verification rail is non-deterministic

**Observed 2026-08-12 13:00–13:11 UTC, on ONE unchanged commit (`e059486`):**

```
12:59:30  loop rails      npx vitest run  → GREEN  (172 files, 2053 passed)
~13:00    Codex re-ran    npx vitest run  → RED    (8 failed)
13:05     orchestrator    npx vitest run  → RED    (8 failed, 171 files)
13:11     isolation       npx vitest run tests/def140OwnerAddressBoundary.test.ts
                                          → GREEN  (19/19)
```

No commit between them. All 8 failures are in
`tests/def140OwnerAddressBoundary.test.ts`, which passes alone. Therefore
**cross-file pollution or ordering/parallelism dependence**, not a code
regression — and the loop's primary rail can report GREEN on a suite that is red.

Why this outranks feature work: every iteration's "verification matrix" claim, the
rails that decide whether a build turn's work is safe to stack on, and the new
deploy phase's gate all rest on `vitest run` meaning something. Right now a green
rail is a coin flip. Codex caught this only because it independently re-ran —
which is also the second time Codex has caught a false-green verification claim
(iteration 10's build log published green while the tree was red).

**Find the leak, don't retry-loop it.** Likely candidates: a `vi.mock` of
`../src/db/prisma` or `promptBlockService` in that file leaking into or being
clobbered by another file's mock of the same module; module-level state in
`brainOutboundService`; or a shared singleton captured at import time. Prove the
fix by running the full suite 5× consecutively green, and name the polluting pair
in the DEF row so the class is recorded, not just the instance.

---

## D-9 · STANDING · The significance bar for every iteration

Owner, 2026-08-13: *"i need significant improvement in each iteration"*.

That is a fair demand and it has been failed for eight iterations, so it is now a
condition each turn is judged against rather than an aspiration. **An iteration is
significant only if it does one of these three, and the build entry must say which:**

**S1 · It changes what the owner RECEIVES on a named capability.** Per his ruling of
the same day, a fix and a feature both count — teaching English and teaching Spanish
both improve communication. The test is that something reaching him is different
afterwards. DEF-159 qualifies: he saw `+239487846228094`, he will now see a name.

**S2 · It unblocks measurement of a capability with a gap larger than 30.** Not any
measurement — those specifically. Self-Pruning needs +51, Self Follow-Up +48, Learn
+43, Authorized Action +34. Work on a capability nothing can score produces a 0 and
reads as failure, which is what happened to iterations 3, 5, 6 and 9.

**S3 · It closes a reviewer finding on a change that has not yet earned SOUND.**
Finishing is significant. Sixteen iterations produced two SOUND verdicts because every
turn started something new; the remediation rule now enforces this and it counts.

**What does NOT clear the bar**, and should be declared plainly rather than dressed up:

- another point of C4 — it is the SMALLEST remaining gap (16.3 of 360) and has absorbed
  eight iterations;
- internal hygiene, a refactor, or a test-only change with no owner-visible effect;
- a change on a path that does not fire in production;
- anything that stays in the branch. **Undeployed work is worth zero under the owner's
  own rubric**, so an iteration that clears S1 must reach production to have been
  significant — which is why deploy is now a loop phase.

**Ranking, when several are open:** S1 on the largest gap, then S3, then S2, then S1 on
a smaller gap. An owner report (D-6) still outranks all of them.

If a turn cannot clear the bar, say so in the build entry with the reason. A turn that
honestly reports "this was not significant, and here is why" is more useful than one
that claims a capability movement the reviewers then refuse — that pattern has already
cost this loop four iterations and about eighty dollars.

---

## D-10 · STANDING, OUTRANKS THE SCORE · Improvement must be REAL, not numeric

Owner, 2026-08-13: *"improvement should not be in numbers it should be in real"*.

The capability score is a proxy and it has been managed as if it were the goal. From
here:

**An increment is not done when tests pass. It is not done when Grok scores it. It is
done when the behaviour is OBSERVED IN PRODUCTION and the evidence can be quoted back
to the owner.** Ship it, then go and look at what actually happened on his WhatsApp —
the real message, with its real timestamp.

What that requires of a build turn:

- **Name the observable.** Not "improves follow-up" but "Hamna is messaged when the
  ShireMe deadline passes, with no instruction from him." If you cannot state what he
  would SEE, you cannot claim the increment.
- **Deploy it.** Undeployed work has changed nothing for him, so it cannot be real.
- **Say what you could not observe.** "The code path is complete but no deadline has
  passed since deploy" is an honest and useful report. Claiming the behaviour on the
  strength of a passing test is the `fabricated-status` class — five recorded
  occurrences, and it is the defect he has complained about most.

What it requires of the orchestrator: report in behaviour, not metrics. Lead with what
Brain now does that it did not do before, quote the real message, and put the capability
delta last as corroboration. Eighteen iterations of leading with 47.3 taught him
nothing about his own assistant.

The score still exists and Grok still owns it — a real improvement should show up there
too, and a score that moves with no observable change behind it is a signal that
something is being credited that has not actually happened.

---

## D-6 · STANDING, RANKS FIRST · Owner reports override the queue

**Check `server/docs/orchestrator/owner_reports.md` before anything else, every
turn.** **DETECTION RULE (corrected 2026-08-13):** any text below the file's marker
line that is not already marked `PROCESSED` is an unprocessed report — do not look
only for a `## R-<n> · UNPROCESSED` header. R-2 arrived as pasted chat with no header
and the header-only rule did not fire; the owner pastes, and the Builder adds the
header. An intake that requires the owner to format correctly is an intake that drops
reports. The owner talks to the LIVE Brain; a report there is a defect observed on
production traffic, and CLAUDE.md rule 1 (log first, same session) applies to it
in a way it cannot apply to benchmark findings.

An `UNPROCESSED` report outranks Codex's directive, the fixQueue, and every
D-item below. Processing means: CL row + DEF row(s) same turn, chart §3 recurrence
check before coding, fix if it fits one coherent change (otherwise the DEF stays
OPEN with a written reason), then mark the report `PROCESSED → CL-NNN / DEF-NNN`
in place. Reports are never deleted.

If the file has no UNPROCESSED entries, proceed to Codex's directive as usual.

---

## S-1 · FROM THE SCORER (Grok), verbatim

Written after iteration 8. Quoted as given — the orchestrator does not paraphrase the scorer.

**The capability gap it would close next:**

> Contain the global renderer inversion: prefer prose over receipt only when a typed ActionOutcome is present (start with update_open_item); fail closed otherwise. Thread applied/rejected/artifact identity into ComposeResult so brainAnswerSurvivesReceipt is not an empty-outcome length check.

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

### MEASURED, 2026-08-13 — 21 runs, and the open question above is now answered

Every benchmark run on record is flagged `mutated`. All 21 name **one row**:

```
runs flagged mutated                21 of 21 on record
row                                 cmsotakwf0006rts1bdsrjjkj — open item #506
                                    "Define rules for Brain's responsiveness to new vs. existing…"
created                             2026-08-11 15:25:06, INSIDE iter-00's window (15:22:50→15:29:12)
open_items count, iter-09..iter-18   283 → 283 every run — nothing created since iter-00
what the 20 later runs did          update_open_item, idempotently: priority='high'
notes / delegation_trail            0 / 0 — no note spam, no invented delegation
messages sent                       none on record
```

**So the row is benchmark junk, not an owner item** — that is the deliberate
determination D-1 asked for, made on the creation timestamp rather than on its
plausible-looking title. The 20 updates after it are self-inflicted: the suite
edits the row the suite created.

**And the prescribed teardown would not have worked on it.** Its status is
`DRAFT`, which is not in `ItemStatus` at all, so `transitionStatus(#506,
'CANCELLED')` cannot resolve a transition and refuses. The row is simultaneously
(a) junk the loop is supposed to withdraw and (b) unwithdrawable through the
canonical entry point. See **D-11**, which is the real defect underneath this one.

**Revised harm assessment, stated plainly so nobody over- or under-reacts:** the
realised damage is one benchmark-created DRAFT item carrying `priority='high'` in a
backlog of 283, with no note spam and no messages sent. That is small. The
*exposure* is not bounded by it: `answerAsBrain` has no dispatch switch, so the
next case that provokes a send would message a real person from a measurement run.
Containment is therefore still owed — but D-1's teardown is the second priority,
behind D-11.

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

---

## D-11 · OPEN · `DRAFT` is a live status the lifecycle matrix cannot express

**Found 2026-08-13 while measuring D-1. This is CIRCLING, not a new problem** — per
CLAUDE.md rule 5, the symptom class *"an open-item status written outside the
matrix"* is already in the chart as DEF-129's root cause. A structural fix is
required; a patch on item #506 is not a fix.

### The two vocabularies

`transitionMatrix.ts:19-41` defines nine statuses: NEW, TRIAGED, IN_PROGRESS,
DELEGATED, WAITING_INFO, SNOOZED, INFORMED, CLOSED, CANCELLED.

`DRAFT` is not among them — yet it is a **designed, shipped product state**:

```
server/src/services/openItems/openItemGate.ts:296     status: 'DRAFT'   ← minted here
server/src/services/openItems/openItemGate.ts:73,77   'NEW' | 'DELEGATED' | 'DRAFT'
server/src/jobs/openItemDraftAskJob.ts:6,42           a DAILY job walks DRAFT items
server/src/services/openItems/applyOpenItemUpdate.ts:91  promotes out of DRAFT
server/src/services/openItems/zombieItemPolicy.ts:94  treats DRAFT as active
server/src/routes/briefRoutes.ts:2400                 renders DRAFT to the owner
```

So the gate creates items in a status the canonical entry point does not know.

### The consequence, which is a capability loss and not just untidiness

`transitionStatus` resolves `findTransition(item.status, target)`. For a DRAFT
item that lookup returns `undefined` for **every** target, so the function refuses
all of them. A DRAFT item cannot be triaged, delegated, closed, snoozed or
cancelled through the only path allowed to change status.

**Nexeo cannot move an item Nexeo itself created.** State it that way in the
capability block: this is `Authorized Action` and `Self-Pruning`, not hygiene.

Worse, the two escape hatches both do harm:
- a caller that gives up on the matrix and writes `status` directly is exactly the
  DEF-129 bypass, re-created; or
- the item sits forever, which is what `zombieItemPolicy` then has to reason about.

### Exposure today — measured, not estimated

```
TMC-0001:  CLOSED 275 · DELEGATED 4 · CANCELLED 3 · DRAFT 1
```

One DRAFT row, and it is the benchmark's own #506. **Say this out loud in the
build entry rather than inflating it:** no owner item is currently frozen. The
gate's DRAFT path is nearly cold in production, so this is a live *structural*
hole with an almost-empty blast radius — the cheapest possible moment to close it,
and the reason to close it now rather than after it has minted fifty rows.

### What a structural fix has to settle (the Builder decides and argues it)

1. **One vocabulary.** Either DRAFT joins `ItemStatus` with its real transitions
   (in from creation, out to TRIAGED/NEW on completion, out to CANCELLED on
   withdrawal), or the gate stops minting it and expresses "missing priority/due
   date" as a field rather than a status. Both are defensible; two vocabularies
   are not.
2. **If DRAFT joins the matrix**, `DRAFT → CANCELLED` must exist, which also
   unblocks D-1's teardown for #506.
3. **A migration for existing rows** — hand-written and idempotent, and it must
   handle the row whose status the 20260811b migration already declined to
   interpret rather than pretending the table is clean.
4. **A test that fails on the hole itself**, not on one row: assert that every
   status any production code path can write is present in `ALL_STATUSES`. That is
   the assertion whose absence let this ship — a matrix test that only exercises
   statuses the matrix already knows can never catch a status it does not.
5. **Do not "fix" this by widening the `ItemStatus` type without transitions.** A
   status with no legal transitions is still a frozen item; it would move the
   refusal from `findTransition` to nowhere at all, which is worse because it
   would look fixed.

---

## D-12 · OPEN · Nobody can read what Nexeo says to the owner's team

**Measured 2026-08-13 against production while building the observation query C-2
increment 1 would be judged on.** The query cannot be written, because the data
does not exist.

### Nexeo does chase — that part is real, and I had it wrong first

My first reading of `whatsapp_outbound_messages` (empty since 2026-08-07, while
follow-up actions ran on 08-11 and 08-12) looked like proof that follow-ups were
recorded and never sent. **It is not proof.** That table is written by
`UserWebjsProvider` — it is the owner's own WhatsApp session sync, not the tenant
sender the worker uses. Its silence says nothing about worker sends. Stated here
because the wrong version of this finding is much more alarming than the true one,
and it would have sent the Builder at a defect that does not exist.

What production actually shows, from `delegation_thread_events`:

```
outbound_receipt · whatsapp · accepted · 26 · latest 2026-08-12
outbound_receipt · whatsapp · failed   ·  4 · latest 2026-07-30
provider_message_id present:  0 of 30
```

And from `agent_actions` (76 lifecycle rows):

```
brain_prompt  done  43     ← went to the OWNER, not the delegatee
whatsapp      done  31
email         done   2     ← the only sends with real provider receipts (Gmail ids)
channel 'none'         0   ← failures are NOT recorded as done. The literal
                             `status: 'done'` at actionLifecycleWorker.ts:264 looked
                             like fabricated-status; it is not, because a failed send
                             returns {sent:false, channel:'none'} and no row is written.
```

So the honest verdict on Self Follow-Up is **not** "inert". It is: chases are
attempted, 26 were transport-accepted as recently as yesterday, more than half of
all follow-ups go to the owner as a `brain_prompt` rather than to the delegatee,
and **not one WhatsApp chase has a provider receipt** — so delivery is unconfirmed
across the board (`tenantWhatsappSender.ts:70-72` returns `ok: true` with
`confirmation: 'transport_accepted'` when Meta gives no message id).

### The gap that blocks everything else

**The body is stored nowhere.**

```
delegation_thread_events   no body / text / payload / snippet column (checked in information_schema)
agent_actions.output       {channel, receipt, reason, nextFollowUpAt} — no text
whatsapp_outbound_messages owner's webjs sync only
```

There is no query, anywhere, that answers *"what did Nexeo say to Hamna?"*

Consequences, in order of severity:

1. **The owner cannot see what is sent in his name to his own team.** That is the
   thing he asked for when he ruled improvement must be REAL and not numeric
   (D-10). It is also a trust surface, not a logging nicety.
2. **C-2's exit condition is unsatisfiable as written.** Increments 1 and 3 both
   say "quoted verbatim with its send time"; increment 4 requires a ledger row
   behind every claimed chase. None can be observed — or falsified — today. This
   is why **increment 0** was inserted ahead of them.
3. **A fabricated chase claim cannot currently be caught.** If Brain tells the
   owner "I chased her", there is no artifact to check that against. The
   fabricated-status class has five recorded occurrences; this is the one place it
   would be invisible.

### Constraints on the fix

- **Do not backfill the 30 historical sends.** Their text is unrecoverable, and
  inventing it would be the exact failure the loop is trying to end. Report them
  as unrecoverable.
- **Store it once, on the path that already runs.** `registerWorkerSend` /
  `recordWorkerReceipt` already bracket every worker send
  (`actionLifecycleWorker.ts:169-175`) — that is the single site. A second
  logging path would be `protection-with-two-implementations`, eight occurrences.
- **Do not confuse `transport_accepted` with delivered.** Whatever is stored must
  keep those distinguishable, because the current inability to tell them apart is
  half of why this capability cannot be judged.

---

## D-13 · OPEN · Brain chooses how to address the owner — the fixed title comes out

**Owner ruling, 2026-08-13, verbatim:** *"Sir is configured in setting, but if you
think brain should decide then well, remove it from setting and lets brain
decide"*.

I do think so, and the reason is what the measurement showed.

### What was measured

C4 — *"Human voice — reads as a person, not a template. No canned sentence, no
filler apology… Excess formality is a C4 cost"*
(`brainResponseEvaluator.ts:41,111`) — is the criterion gating the entire loop, at
**86.7 of 95** after iteration 20. Every case scoring below 90 lost its points to
the same thing:

```
B12  75  "My apologies, Sir" — overly formal and canned
B05  85  "Morning, Sir." — formal/template
B09  85  "the use of 'Sir' feels overly formal and slightly robotic"
B11  85  "The assistant does not have the capability to…" — third-person formal
B06  85  dry — "Here is a summary of your open items"
B10  85  bulleted list with timestamps
     complaint frequency across 12 cases: formal 4 · canned 3 · template 3 · Sir 3
```

And `Sir` was not a defect — `brainPersonaService.ts:23,188` exposes it as
`preferredTitle`, *"How Brain should address you"*, with `first_name_only` as an
alternative. **The loop has spent 20 iterations gated on a criterion that was
docking points for honouring the owner's own setting.**

### Why Brain deciding is the right answer rather than a rubric exemption

A fixed title is what makes it read as a template. Prepending the same honorific
to every reply is mechanical by construction, and mechanical is exactly what C4
measures. A competent assistant varies register with the moment — and most human
messages open with no address at all. So the fault is not the word `Sir`; it is
that the word was **forced**, uniformly, by configuration.

That also makes this a real capability change rather than a scoring one. **If C4
rises here it is because what the owner receives actually changed** — which is the
D-10 bar (improvement must be real, not numeric) and the capability contract's
test (did what the owner receives change?). Contrast the rejected alternative:
editing the judge rubric to exempt the honorific would have raised C4 by several
points while Nexeo still spoke exactly the same way. That is the kind of movement
this loop must never produce.

### Scope for the Builder

1. **Remove the forced title from composition.** `preferredTitle` must stop being
   prepended as a standing instruction. Register becomes the model's choice per
   turn, informed by context — the same way it already chooses length.
2. **Do not replace one fixed token with another.** Substituting `Basit` for
   `Sir` everywhere would score the same and be the same defect. The test is that
   the address form **varies across the 12 cases, and is often absent.**
3. **Take the other C4 complaints in the same change**, because they are one
   register problem, not five: the third-person `"The assistant does not have the
   capability to…"` (B11), the canned `"Here is a summary of your open items"`
   (B06), and the filler apology opener (B12).
4. **Honour an explicit instruction if the owner gives one.** If he ever says to
   call him something, that is an instruction to obey and remember — this
   directive removes a default, not his authority over it.
5. **Do NOT touch `brainResponseEvaluator.ts`.** The judge rubric and the
   benchmark cases stay protected. The number must move because the voice moved.

### Falsifier

Across the 12 benchmark answers, the opening words are not all of one shape, at
least some replies open with no address at all, and no reply contains a filler
apology opener. If every answer simply gained a new uniform greeting, this failed
and C4's rise is an artefact.

---

## D-14 · OPEN · Ship every iteration, and stop enumerating phrases

**Owner, 2026-08-13:** *"as a orch manager u should keep an eye on improvement of
each iteration, we are not here to increase just numbers of iteration we need
significant improvements against each iteration"*.

He is right and this is my failure to manage, not the Builder's to work harder.
Three things are measured, and together they fully explain a frozen 47.4.

### 1. One iteration in ten reached him

```
#11 #12 #13 #14 #15 #16 #17 #18 #19 #20
 ·   ·   ·   ·   ·   ▲   ·   ·   ×   ·      ▲ = deployed
hold hold hold hold hold SHIP hold hold — hold
```

Grok on iteration 20, unprompted: *"nothing moved — Iteration 20 DEF-165 is
branch-only (c2ba9a3 NOT YET deployed); overall remains 47.4"*. The capability
contract says undeployed work has changed nothing for him. **So the capability
number is frozen by construction, and no amount of good building moves it.** Nine
of the last ten turns produced real work that he has never received.

### 2. Deploy holds are correct, which makes them worse

The gate is not too strict. Iteration 20's HIGH is real: B12 still tells him *"I'll
make sure the duplicate is cleared"* with no action behind it — fabricated action,
in the exact case the turn set out to fix. Loosening to `no-critical` would not
ship it either. **There is nothing to relax here; the work genuinely is not ready.**

### 3. Three iterations, one class, the same losing shape

18, 20 and 21 have all attacked unevidenced self-repair by **enumerating forbidden
phrases**. Each time Codex finds the next phrase outside the enumeration and rules
WEAK, correctly:

```
iter 18   removed "…to prevent it happening again"      → iter 20 says "I'll make sure it's cleared"
iter 20   added recurrence vocabulary + evidence seam   → the promise is "just outside the enumerated syntax"
```

A blacklist cannot close a class whose members are generated by a language model.
Codex has now said *"authorization, not detection"* twice in different words. That
is the finding, and the loop has not acted on it.

### THE RULES, from iteration 22

1. **Invert the shape for this class. No enumeration.** A sentence asserting that
   Brain did, fixed, flagged, sent or prevented anything ships ONLY when an
   attesting artifact exists for that specific assertion. Whitelist, not blacklist.
   If the artifact cannot be produced, the sentence does not ship. A fourth
   phrase-list attempt is not to be started.
2. **Scope every turn to something that can SHIP.** A turn that restructures a
   validator attracts HIGH findings and holds; a turn that makes ONE owner-visible
   behaviour correct, with a test and a live check, can be SOUND and reach him.
   Until the ship rate recovers, prefer the second even when the first is more
   interesting. **A smaller change that arrives beats a better change that does
   not.**
3. **An iteration that deploys nothing AND moves no capability is a FAILED
   iteration** — not a neutral one. Say so in the build entry. Two consecutive
   failures and the KIND of work changes; the orchestrator re-scopes rather than
   letting a third attempt run.
4. **The orchestrator reports the ship column to the owner every time.** Not the
   benchmark, not the test count: whether anything reached him. That is the number
   he has been asking about all week and the one I let drift out of the report.

### What this is not

Not a licence to ship weak work to make the column look better. The gate stays on
SOUND. The way to ship more is to attempt less per turn, not to lower the bar —
and if a turn cannot be scoped small enough to pass review, that is worth saying
out loud rather than spending another 30 minutes and $15 on a hold.

---

## D-15 · OPEN · A bracketed marker is never a reply

**Iteration 21 sent the owner this, as the entire answer to "why did I get two
reminders?":**

```
[unevidenced self-repair claim — nothing was flagged and no prevention was
 scheduled; say what is observable and that the cause is not known]
```

Codex ruled **WRONG**; the regression guard caught it independently before the
review landed. B12 C4 85 → 10, C6 100 → 20, C7 90 → 20, C1 85 → 20, aggregate C4
86.7 → 80.7.

### This is occurrence 8 of `guard-destroys-the-answer`, and the design invites it

`brainAskRoutes.ts:189` does `result.answer = validation.replacement`. When
`exciseClausesMatching` and `exciseSentencesMatching` both fail — because the whole
answer is one matching sentence, which is exactly the shape of a short apology —
`replacement` is the `suggestedReplacement` marker, and the marker becomes the
reply.

**The route already knows this failure by name.** Its own comment:

> `salvaged: false` means the whole answer became a marker, **which is what
> destroyed four correct replies on 2026-08-10 before anyone could see it
> happening.**

And the judge rubric names it as a worked example:
*"Brain sent the literal text `[completion recorded and item closed]`: C4 = 5. A
machine marker reached a human."*

So this is not a surprise, it is a permitted outcome that has now fired at least
twice. **Four iterations have treated the class as a detection problem** — three
enumerating phrases, one generalising the grammar. Both halves fail for one reason:
while a marker may be a user-facing answer, every improvement in detection
increases the chance the owner gets a debug string instead of a reply.

### THE SCOPE FOR ITERATION 22 — small, and it must SHIP

1. **A bracketed marker may never reach a human.** It is an internal signal. Where
   the code currently assigns one to `result.answer`, it must instead:
   a. **regenerate** the answer under the constraint (the composer is right there,
      and the violation description already states what to avoid); or
   b. failing that, emit a **plain honest sentence** with no brackets, written for
      that violation class — for B12: what is observable, and that the cause is not
      known.
2. **Never two blocking rules on one claim.** Codex's other finding: the old phrase
   rule and the new grammar rule BOTH fired on B12. That is
   `protection-with-two-implementations`, occurrence 9. One rule owns this class.
3. **The test that would have caught it**: for every block-severity rule, assert the
   user-facing result contains no `[` marker. Table-driven over the rule list, so a
   rule added later inherits the assertion instead of needing to remember it.
4. **Ship it.** This is a small, self-contained change on a path with existing
   tests. Iteration 22 must end deployed — per D-14, two consecutive iterations have
   now reached the owner with nothing.

### What NOT to do

- Do not narrow the DEF-166 grammar rule to make B12 pass. The rule caught a real
  unbacked promise; the bug is what happened after it caught it.
- Do not delete the markers. They are correct as internal signals and the logs need
  them; they simply must not be the thing the owner reads.
- Do not add a fifth detection improvement. The class is closed by making a block
  safe, not by making detection cleverer.

---

## D-16 · OPEN · The capability number must mean ONE thing: what the owner has

**Owner, 2026-08-13:** *"Iteration 21 downgraded brain to 47.2"*. It did —
Accurate Communication 74→72, overall 47.4→47.2, Grok's verdict **REGRESSION**.

Grok's own note names the tension exactly: *"Branch still NOT DEPLOYED so
production phone is unaffected; that limits debit size, not the REGRESSION verdict
on the compose path."*

### The asymmetry, stated plainly, because it is mine

The contract says an improvement scores **0 until deployed** — *"a fix sitting in
the branch has changed nothing for him, however good it is"*. Iteration 21's
regression was equally undeployed and was scored **−2**.

**So the number is currently debited for branch regressions and not credited for
branch improvements.** That is not Grok being inconsistent; it is the contract
being silent, and it makes the figure unreadable: 47.2 is neither what the owner
has in production (unchanged, 47.4 by the same rule) nor what the branch would give
him (higher than 47.4 on nineteen defects, lower on this one).

### The rule, from the next card

**Score what the owner HAS — production.** A branch change, in either direction,
moves nothing until it ships. Symmetry is the whole point: a scorer that debits
unshipped harm while ignoring unshipped good will drift downward through exactly
the kind of week this has been, and the number stops being a measure of Nexeo and
becomes a measure of how the branch happens to look on scoring day.

**And report the branch separately**, because it is real and it matters:

```
capability (production)   47.4    what he has today
branch delta if shipped    ?      what this HEAD would give him, +/- per capability
blocked by                        the reviewer verdict holding it
```

That way iteration 21 reads honestly as: *production unchanged at 47.4; the branch
currently contains a regression that must not ship*. Which is the true statement,
and more useful than a single number that has quietly averaged the two.

### What does NOT change

- **Nobody edits Grok's numbers, including me** (`capability_targets.md`). 47.2
  stands as the card that was written under the rule as it was. The correction
  applies from the next card forward and is recorded here so the discontinuity has
  a reason attached rather than looking like a rescore.
- **`basis: live-evidence` still requires production**, and nothing on this branch
  has it.

---

## D-17 · OPEN · Tag markers at creation; close the voice path; then SHIP

Iteration 22 repaired iteration 21's regression — B12 went from a raw marker to
*"My apologies, Sir. It looks like I sent that reminder twice. I can see the two
identical messages in our conversation log, but I don't have a specific reason
recorded for the duplication."* Case overall 50 → 95, aggregate C4 80.7 → 88.8,
overall 92 → 95.4, and no marker in any of the twelve answers.

Codex ruled **WEAK** on two HIGH findings. Both are in the same small marker path,
and one of them is not this branch's fault.

### HIGH #2 IS ALREADY IN PRODUCTION — verified, not assumed

```
git cat-file -e df47687:server/src/services/knowledge/markerVoice.ts   → exists
```

`df47687` is the last **deployed** commit (iteration 16, 2026-08-13 06:39). So
`markerVoice.lastResort` — which takes a marker's inner text, capitalises the first
letter and returns it as prose — is live on the owner's WhatsApp today. Its own
header says stripping markers to silence *"is what made 77 of them feel like Brain
ignoring the user"*, so this path fires in production.

**Holding the deploy does not protect him from this.** It protects him from nothing
he is not already exposed to, while withholding everything iterations 17–22 fixed.

### HIGH #1 is real and the fix is structural, not another heuristic

`answerSanitizer.ts:235` matches `^\s*\[[^\]]{8,400}\]\s*$` and replaces it with
*"I don't have a good answer for that yet"*. A whole-answer `[see attached]`,
`[CONFIDENTIAL]` or `[Approved by Basit]` therefore loses real content. The build
log asserted *"no human reply is shaped like that"* — that assertion is about
EMBEDDED brackets, which is a different case, and Codex is right.

> **CORRECTION, 2026-08-13 11:32, and it inverts the trade this directive put to the
> owner.** The paragraph above is accurate about the BRANCH and wrong about what is
> NEW. The whole-answer bracket interception is **pre-existing and live in production**,
> not something iteration 22 introduced — verified, not reasoned:
>
> ```
> git show df47687:server/src/services/knowledge/answerSanitizer.ts
>   188: export function isWholeMarker(answer: string): boolean {
>   189:   return /^\s*\[[^\]]{2,200}\]\s*$/.test(answer ?? '');
>   273:   if (!isWholeMarker(answer)) return sanitizeAnswerForUser(answer);
> ```
>
> In the DEPLOYED commit a whole-bracket answer is already intercepted and handed to
> `renderMarkerInBrainVoice` to be prose-ified — and the deployed threshold is
> `{2,200}`, **broader on the low end** than the branch's `{8,400}`. What iteration 22
> changed is the SHAPE of the check and what happens after interception (a neutral
> fallback string instead of LLM prose-ification), never its existence. The deployed
> file contains no `NEUTRAL_MARKER_FALLBACK` at all.
>
> Why this matters more than tidiness: this directive told the owner that shipping
> "would introduce a new regression". **It would not — it carries an existing one
> forward with a narrower trigger.** Two orchestrators asserted the already-in-production
> half for HIGH #2 only; nobody had run the same check on HIGH #1 until now. This is what
> makes his LET IT SHIP ruling (D-20) the coherent one.

**The validator already knows it produced a marker. Nothing downstream should have
to infer it.** Tag it at creation — a field on the violation, or a sentinel the
route carries alongside the text — and the sanitizer stops guessing by shape, so
legitimate content can never be misread. This is the same lesson that finally
worked on the self-repair class: authorization, not detection.

### ITERATION 23 — both HIGHs, then deploy

1. **Marker provenance.** The producer marks it; consumers check the mark, never the
   shape. Delete the shape heuristic once the mark exists.
2. **The voice path consumes the sanitized text, never the raw marker.**
   `markerVoice.ts:58-68,79-82,98-130`: neither the LLM call nor `lastResort` may
   receive marker content. `lastResort` returns a fixed honest line — it must never
   prose-ify an internal instruction.
3. **MEDIUM #3 while you are in the file**: the fallback line promises *"let me look
   again"* and asks the owner to repeat himself. That is the empty-promise class
   inside the safety net. Say what is true and ask nothing of him.
4. **Then it ships.** Five iterations of work are held behind this path.

### This overrides the capability cap, explicitly and on the record

The starvation cap will fire on iteration 23 pointing at Self Follow-Up, and I am
overriding it. Stated plainly so it is judged rather than assumed:

- This is **not** a fifth iteration chasing Accurate Communication. It is the work
  that makes iterations 17–22 deliverable. Nothing counts until it ships (D-14), so
  a turn spent unblocking delivery buys more than a turn spent starting a capability
  on a branch that cannot ship.
- **It is one turn.** If iteration 23 does not end deployed, the override expires
  and iteration 24 goes to C-2 increment 0 regardless of what the reviewer says.
- The owner is told both numbers: one turn to unlock five, versus starting 13.4% of
  the journey one turn later.

---

## D-18 · OPEN · The scorecard could not measure change — measured, not suspected

Owner, 2026-08-13: *"i have very serious concern with such progress in decimals"*, then
*"you mean your compaing method will boost the improvement?"* — the right question,
and answering it honestly found that the instrument, not the rate, was the problem.

### What the history showed

Across eleven capability cards, **eight of the nine capabilities had never moved
once**, and the largest single-iteration change on any of them was **+2**.

### The from-scratch re-baseline (`run-score.sh 22 --fresh`)

Same code, same scorer, previous card withheld:

```
capability               carried   fresh   diff
Simple & Smart                33      36     +3
Thinking                      36      42     +6
Memory                        60      58     -2
Accurate Communication        74      68     -6
Authorized Action             52      55     +3
Self Follow-Up                43      52     +9
Learn                         42      38     -4
Self-Healing                  54      48     -6
Self-Pruning                  33      42     +9
OVERALL                     47.4    48.8   +1.3
```

**Every one of the nine moved when the anchor was removed.** So the instrument
disagrees with itself by ±6–9 per capability, ±1.3 overall — and the "+0.7 across 22
iterations" the owner was rightly angry about is **smaller than the measurement's own
noise**. The honest statement is not that progress was slow; it is that **we could not
tell whether 22 iterations improved Brain at all.**

### Cause, and it is mine

`score.md` carried three instructions that jointly forbid movement:

1. carry your previous numbers forward, do not re-derive;
2. never move a score without citable evidence;
3. nothing is deployed, so `live-evidence` is almost never available to you.

Each was written for a good reason — (1) to stop drift reading as progress, (2) to stop
invention, (3) because it was true. Together they produce a scorer that carries numbers
forward whatever the code does, and I then asked why nothing moved.

**And a fourth, worse than the other three:** the scorer reads the codebase only, so it
cannot see the one place a capability exists. It scored Self Follow-Up 43 `doc-read`
while the follow-up worker had chased a real delegatee that morning and the day before.
Its fresh read of the same code gave **52**, and production says the chase fires daily.
A capability that manifests at runtime could never be credited, however much was built.

### The fixes, shipped with this row

1. **`evidence-pack.sh`** — aggregates from the live database in the scoring prompt, so
   `basis: live-evidence` is achievable. **Counts, dates and rates only: never a name, a
   phone number, an email or a message body.** The scorer needs to know THAT a
   capability fires, not who it fired at, and this text goes to a third-party model.
2. **`run-score.sh --fresh`** — a from-scratch re-baseline, written to its own file and
   NEVER ingested. Two independent readings that disagree is the finding; substituting
   one for the other destroys it. **Run every 5 iterations.**
3. **Report a band, not a point.** 47.4 ±1.3 is the truth. A bare 47.4 claims a
   precision that does not exist, and it is what made a +0.2 look like a result.

### What this does NOT excuse

The work still has not shipped, and that is separate and real. One deploy in 13
iterations, and undeployed work changes nothing for the owner whatever any scorer says.
A better instrument makes delivery measurable; it does not substitute for it.

---

## D-19 · OPEN, RANKS ABOVE THE CAMPAIGN · Owner ruling 2026-08-13: no ship on known limitations; build an ABSENT capability, and every iteration must be significant

The owner was given the three options held open at the end of iteration 23 and ruled:

> **Move to campaign work; leave the branch undeployed.** Not option 1 (a sixth turn on
> the marker path), not option 3 (accept both HIGHs as DEF rows and ship on
> `NEXEO_DEPLOY_ON=no-critical`).

And, unprompted, the standing bar for what a turn is worth:

> *"my ask is every iteration should be significant improvement"*

### What this changes, mechanically

1. **The marker path is closed as a source of work.** Iteration 23's two HIGH findings
   are NOT to be repaired for a sixth turn. They are recorded as known limitations with
   DEF rows so they survive in the record, and the Builder states in its build entry
   whether each should stand as a known limitation or be grounds for reverting. The
   remediation rail is released for iteration 24 for exactly this reason.
2. **`NEXEO_DEPLOY_ON` stays `sound`.** The owner declined the no-critical path. Nothing
   ships without a SOUND review. The consequence is stated below, not hidden.
3. **The campaign moves to an absent capability.** C-2 (Self Follow-Up) is parked with 3
   of 8 budget iterations unspent — it did not fail, it was **starved**: every one of its
   five open iterations was consumed by remediation of the marker path. C-3 (Self-Pruning,
   33, `basis: absent`) becomes active, per the owner's own priority order in
   `capability_targets.md`.
4. **Remediation may never again eat a campaign.** `NEXEO_REMEDIATION_LIMIT` drops 3 → 1.
   A WEAK verdict buys one repair turn; after that the finding becomes a DEF row and the
   campaign gets its turn back. Three attempts × eleven WEAK verdicts is the arithmetic
   that produced "campaign open 5 iterations, zero increments delivered".

### The significance bar, made testable rather than asserted

Every iteration from 24 on closes with one of exactly two honest statements:

- **`deployed=yes`** — the owner received something, quoted back from production, or
- **a named, code-complete increment** of the active campaign that a reviewer can judge.

Anything else is a failed iteration and is reported as one. **If two consecutive
campaign iterations produce neither, the orchestrator stops the loop and returns to the
owner** rather than spending a third. Iteration count is not progress; D-14 and D-10 rank
above any number the scorer produces.

### The prediction, on the record before iteration 24 runs

With `DEPLOY_ON=sound` and eleven consecutive non-SOUND reviews, the most likely outcome
of iteration 24 is **`deployed=no` again**. That is the direct, foreseeable cost of the
owner's ruling and it is his to spend — but it is written down BEFORE the turn so the
result is judged against a stated expectation instead of explained afterwards. If it
comes true twice, the honest question back to the owner is not "one more iteration", it
is whether the SOUND gate or the branch is the thing that has to give.

---

## D-20 · CONDITIONAL, ARMS ONLY IF ITERATION 25 CLOSES `deployed=no` · Delete the second implementation; do not fix it a seventh time

Two owner rulings, 2026-08-13, taken after the orchestrator verified the premises in code
rather than asserting them.

### Ruling 1 — a SOUND verdict SHIPS, and that is not the option he declined

`deploy.sh:137` ships `git rev-parse HEAD` — **the whole branch**, gated only on the
current iteration's verdict. So a SOUND campaign turn carries the marker work to
production with it. Put to the owner with that consequence stated, he ruled: **let it
ship.**

The premise, verified before asking rather than after:

```
git show df47687:server/src/services/knowledge/answerSanitizer.ts | grep -n isWholeMarker
  188:export function isWholeMarker(answer: string): boolean {
  273:  if (!isWholeMarker(answer)) return sanitizeAnswerForUser(answer);
git cat-file -e df47687:server/src/services/knowledge/markerVoice.ts   → exists
```

`df47687` is the deployed production commit. **Both HIGH paths are already running on the
owner's WhatsApp today.** A deploy therefore adds no exposure that is not already there;
it adds fourteen iterations of fixes on top of it. What he declined was **lowering the
gate** (`NEXEO_DEPLOY_ON=no-critical`), not **meeting** it. `DEPLOY_ON` stays `sound`.

### Ruling 2 — the deletion turn, armed only on failure

Proposed by the outgoing orchestrator and put to the owner as a third resolution the
earlier three-option framing had missed. He ruled: **only if iteration 25 closes
`deployed=no`.** Iteration 25 keeps its campaign turn either way.

**If it arms, iteration 26 is this and nothing else:**

Iteration 23 landed provenance — `systemMarker()` stamps an invisible sentinel at the
producer and `isSystemMarker` reads it. That path stands alone and is load-bearing. The
two text-inference fallbacks are therefore a **redundant second implementation**, which is
this codebase's most-recorded failure shape (`protection-with-two-implementations`, 11+
occurrences, and it is always the weaker path that is live):

- `answerSanitizer.ts:310-311` — `isLegacyActionMarker(answer) || (isWholeMarker(answer) && !!curated)`
- the legacy snake-case bridge that infers origin from text

**Delete them, do not repair them.** Codex's iteration-23 HIGH #1 is asking for exactly
this. Six turns have attacked this class with detection, heuristics and provenance; none
attacked it with removal, and removal is the only one that cannot leave a second
implementation behind. If deleting either one breaks a test, that test is the evidence the
path is still load-bearing — stop and say so plainly instead of restoring the heuristic.

**This is not a seventh remediation turn** and must not be logged as one. It is a deletion
that closes two HIGHs and unblocks every future deploy from carrying them along.
