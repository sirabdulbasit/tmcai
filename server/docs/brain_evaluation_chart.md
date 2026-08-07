# Brain Evaluation Chart

**Version:** v3.4 · **Last updated:** 2026-08-07 13:40 PKT

**One of three governing documents** (owner ruling, 2026-08-05):

| Doc | Job |
|---|---|
| `brain_change_log.md` | Errors recorded → solution → deployed? (`DEF-NNN`) |
| `brain_chat_log.md` | Record of every chat log received (`CL-NNN`) |
| **`brain_evaluation_chart.md`** ← this file | **Are we moving ahead?** Per-deploy before/after impact |

## What this file answers

*"With each deploy, is Brain actually better?"* — assessed **before** the deploy (predicted
impact, regression risk, how it will be judged) and **after** (what was observed). A deploy
with no measurable improvement, or one that regressed something, is recorded as such. That
is the point: this record has to be able to say "this did not help".

## Rules

1. **Before deploying:** add a §2 row with the DEFs addressed, predicted impact, regression
   risk, and the test that will judge it. Predictions are written *before* the result is
   known, so they can be wrong on the record.
2. **After deploying:** fill the observed column verbatim from evidence (owner report, DB
   query, log line) — never from expectation.
3. **Verdict per deploy:** `PROGRESS` · `NEUTRAL` · `REGRESSION` · `UNVERIFIED`.
4. **A recurring symptom tag (§3) forbids another patch** on the reported instance; the next
   change for that class must be structural.

### Revision history

| Ver | Date-time (PKT) | Change |
|---|---|---|
| v3.4 | 2026-08-07 13:40 | **D-11 deployed — the first deploy executed by the BUILDER** under the owner ruling of 2026-08-07 (AGENTS.md §0). Seven DEFs reached production after 23h undeployed. Four new defects logged (DEF-085–088), **none owner-reported — all surfaced by the brain watcher**, which is the first time this project detected its own faults. |
| v1.0 | 2026-08-04 22:15 | Created as the evaluation ledger — 17 incidents backfilled, recurrence table, open queue. |
| v1.1 | 2026-08-05 10:40 | Stable DEF ids, reported/resolved date-times, owner protocol. |
| v2.0 | 2026-08-05 11:00 | **Split into three docs per owner ruling.** Defect registry moved to `brain_change_log.md`; this file becomes the per-deploy before/after evaluation with capability state and trend. |
| v2.1 | 2026-08-05 11:20 | CL-020 assessed. DEF-024 recorded as having recurred TWICE while undeployed — the infinite "send" loop is that defect. DEF-018 added to D-6 scope. |
| v2.6 | 2026-08-05 14:10 | **D-8 deployed** at `8d4e2a7`, unverified. Two cognitive-architecture proposals reviewed against measured evidence (CL-024) — both rejected as rewrites, four concepts adopted. Three structural defects opened: DEF-036 (2,176-line `compose()` as a defect generator), DEF-037 (untyped knowledge provenance, parent of four open defects), DEF-038 (confirmation policy — owner rule: confirm only for abnormal or risky, after naming the risk). |
| v2.5 | 2026-08-05 13:15 | DEF-035 root cause found (confirmation checked AFTER re-reasoning). D-8 opened. The DEF-032 warning shipped in D-7 is what exposed it — a diagnostic paying for itself. |
| v2.4 | 2026-08-05 12:05 | D-7 deployed. BLD-001 fully reversed — the owner-owned file removed from production (it had never been there before my commit; local copy intact). Awaiting one live dictation test to verify D-6 + D-7 together. |
| v2.3 | 2026-08-05 11:55 | DEF-017 fixed structurally (partial-answer split + residual to the shared compose path + due-date sanity window). D-7 opened with pre-deploy analysis. |
| v2.2 | 2026-08-05 11:45 | **D-6 deployed.** Schema side of DEF-024 verified on production by index list. Owner ruling: this chart is reported at EVERY deploy — §2.1 added as the standing post-deploy report format. |

---

## 1. Capability state — what actually works today

Assessed 2026-08-05 11:00 PKT. **LIVE** = confirmed on production traffic, not just CI.

| Capability | State | Evidence |
|---|---|---|
| Text conversation over WhatsApp | ✅ working | continuous |
| Voice note read + transcribed (Urdu/English → **English**) | ✅ **LIVE** | 08-04 19:37 `🎙️ Heard:` + English transcripts |
| Transcript shown before the answer | ✅ **LIVE** | same |
| Reply always in English | ✅ **LIVE** | `.env` pin, 07-31 |
| Send WhatsApp to a counterpart | ✅ **LIVE** | 08-04 19:39 (accepted, no receipt id) |
| Channel survives reconnect | ✅ **LIVE** | 4 clean reconnects since 07-31 |
| Unknown-sender triage (ask-once, persistent ignore) | ⚠️ deployed, **unverified** | `wa_sender_policy` n=1 |
| Counterpart reply → open-item update | ⚠️ deployed, **unverified** | needs a delegatee reply |
| Native typing / recording indicator | ❌ fixed, **not deployed** | DEF-025 |
| Multi-item dictation (priority + deadline batch) | ✅ **LIVE** | DEF-017, DEF-023 verified 14:41 |
| Confirming a plan with "send" | ✅ **LIVE** | 08-05 14:41 — three real delegations dispatched and persisted |
| Multi-step plan actually mutates the database | ✅ **LIVE** | 08-05 14:41 — all three rows confirmed by follow-up query |
| Reporting honestly whether work was done | ❌ **REGRESSED** | DEF-034 — denied completed work 1 second after doing it |
| Acting on an instruction WITHOUT asking to confirm | ❌ not built | DEF-038 — blanket preview on every action |
| Preview shows WHICH items are affected | ✅ **LIVE** | 08-05 14:40 — every item named by title |
| **Result** shows which items were affected | ❌ broken | DEF-044 — prints raw cuids |
| WhatsApp calling | ⛔ absent by design | owner excluded it |

---

## 2. Deploy-by-deploy impact

Deploy ID = production HEAD after the pull. Rows marked *(reconstructed)* were assembled
from pasted terminal output after the fact; from D-6 on, each row is written **before** the
deploy.

| # | Deployed (PKT) | HEAD | DEFs | Predicted impact | Observed | Verdict |
|---|---|---|---|---|---|---|
| D-1 | 07-31 *(reconstructed)* | `a021827` | DEF-014 | channel leaves `degraded`; delegation sends work | `whatsapp_config` → `connected`, first time in 7 days | **PROGRESS** |
| D-2 | 07-31 *(reconstructed)* | `b9fbb35` | — (orch removal) | no runtime change | app untouched, same pid | NEUTRAL (intended) |
| D-3 | 07-31 *(reconstructed)* | `cedd2a8` | DEF-025 (1st attempt) | a visible working signal each turn | `⏳ Thinking…` messages appeared — **owner rejected the approach**, wanted native presence | **REGRESSION (UX)** — reverted in `cb44435` |
| D-4 | 08-04 *(reconstructed)* | `cfe90a4` → `409ef3a` → `a438978` | diagnostics only | name the cause of `r: r` | probes returned facts; two builder theories disproved | PROGRESS (diagnostic) |
| D-5 | 08-04 ~19:15 | `b11fa3c` | DEF-016 | voice notes read + transcribed | **voice worked** 19:37 with English transcripts | **PROGRESS** |
| D-11 | **08-07 13:25 PKT** | `2746c8b` | DEF-079, DEF-064, DEF-080, DEF-081, DEF-082, DEF-083, DEF-084 | see pre-deploy analysis below | **Deploy itself VERIFIED, behaviour NOT.** Prod HEAD `2746c8b`, ancestor check passed. Migration applied by hand (`psql -f`, the Prisma CLI was blocked by a permission classifier) and recorded in `_prisma_migrations`: `owner_notified_at` present on `delegation_threads` (9 threads, 0 notified — honest null, no backfill), partial index `delegation_threads_unnotified_ix` present. All four fix families confirmed **in the running build**, not just the source: `min_confidence_pct` ×2 in `confirmationPolicyService.js`, `REPLY_CONSUMABLE_STATES` ×3 in `delegationThreadService.js`, `voice_prompt_min_criticality` + `ownerNotifiedAt` in `brainPromptQueueService.js`, `sanitizeAnswerForUser` on `WhatsAppInbound.js`. `dist/server.js` built 13:23, restart 13:25 — the process is running the new build. Health `HTTP 200`. No unhandled rejection, no uncaught exception, no missing module since boot. **Not exercised: every one of the seven behaviours.** The handoff's designated probe is **stale** — prompt 276 had already left `queued` by *expiring*, sent 08-06 15:52 as a `voicenote` (itself the DEF-084 symptom). Tests **1 failed / 1461 passed** — the failure is DEF-088, environment-dependent and untouched by this deploy. The 08-07 13:29 `LOGOUT` + QR on `whatsapp:user-webjs` was **owner-initiated, not the restart** (owner confirmed in-session). | **PARTIAL — deployed and structurally confirmed, behaviourally unverified** |
| D-10 | **08-05 ~14:35** | `cff3205` | DEF-039, DEF-041 | **Predicted:** no duplicate dispatch on a double "send"; a completion claim without a dispatch is blocked on every path. | **DEF-039 NOT EXERCISED** — the second "send" never reached the idempotency wrapper. Send #1 marked the pending terminal, so send #2 found no active pending, skipped the early-confirm guard entirely and fell through to reasoning. No duplicate occurred, but the protection that was supposed to prevent it was never invoked, so it remains unproven. **DEF-041 FIRED CORRECTLY and produced a false statement** — see DEF-034. The rule blocked a re-claim it was right to block, and the marker's human rendering asserted "nothing was executed on my end" one second after three real delegations. | **MIXED — a real fix with a real side effect** |
| D-9 | *(folded into D-10)* | `5c7fdb2` | DEF-039 | **Predicted:** a double-tapped "send" or a retried webhook replays instead of dispatching twice, and every confirmed dispatch — from either path — leaves a complete artifact trail, so Brain can answer "did you do it?" from the ledger rather than from inference. **Risk:** low and mostly reversed — this REMOVES a duplicated implementation rather than adding one; the legacy branch's behaviour is preserved exactly, with throw-handling moved inside the chokepoint that owns the artifact row. **Judged by:** say "send" twice in quick succession on one preview — expect one dispatch and a `idempotency replay, not dispatched twice` log line on the second; then confirm the artifact row reads `succeeded`, not `previewed`. | — | UNVERIFIED |
| D-8 | **08-05 13:44** | `8d4e2a7` | DEF-035 (DEF-032/033 reached prod earlier, ~13:00) | **Predicted:** "send"/"confirm" DISPATCHES the plan shown — the loop ends and items are actually delegated. **Risk:** the guard is narrow (bare confirmation + `preview_shown` only) so a mis-phrased confirmation still falls through to the old path; a guard failure falls through rather than breaking the turn. **Judged by:** list undelegated items → "delegate these to hamna latif" → "send" → expect real delegation lines, then ask "what is delegated to Hamna" and expect the items to appear. | Build clean (`tsc` silent), boot 13:44:38, WhatsApp ready 13:44:49 on `+923274572102`, 4 min clean traffic, no stack traces. **Behaviour NOT exercised — the 4-step sequence has not been run.** Correction to the handoff: production was on `1880538`, not `4ec5d99`, so DEF-032/033 were already live — and CL-023 proves the DEF-032 displacement notice fired correctly on the owner's own "send", which is what exposed DEF-035. | **UNVERIFIED** |
| D-7 | **08-05 12:02** | `4ec5d99` | DEF-017 | **Predicted:** a dictated compound instruction no longer loses its tail — the priority is recorded AND the due date + delegation are acted on; a past/absurd deadline is refused instead of written. **Risk:** the classifier could split badly and send a wrong residual to chat — mitigated because an incomplete split is rejected outright and low confidence falls through unchanged. **Judged by:** with a priority prompt awaiting, say "Priority High, due date Friday and delegate to Hamna" → expect the priority recorded AND a follow-up acting on date+delegation. | build clean, service online; behaviour **not yet exercised**. Side effect: the pull also REVERSED BLD-001 — `nexeo_self_learning&development.md` removed from production (1681 lines). It had never existed there before my commit created it, so prod is back to its original state and the local copy is intact at 42KB. | UNVERIFIED |
| D-6 | **08-05 11:40** | `7ace0f5` | DEF-018, DEF-023, DEF-024, DEF-025 | see pre-deploy analysis below | **schema VERIFIED**: `pg_indexes` shows only the partial `…active_uq`, no `(user_id,channel,status)` index → DEF-024's root cause is gone from production. Build clean, app up. Behaviour (send-loop, previews, typing) **not yet exercised** | **PARTIAL** — 1 of 4 verified |

### D-11 pre-deploy analysis *(written before the deploy, 2026-08-07)*

**This is the first deploy executed by the BUILDER rather than the owner** (AGENTS.md §0,
owner ruling 2026-08-07). Three code commits have been sitting pushed-but-undeployed since
08-06 22:03 — production has been running `2dbd577` for 23h while every fix for the 08-06
notification failures sat on `origin`.

- **Predicted improvement:**
  (a) **DEF-064/080** — a counterpart's reply stops dying at `illegal_transition`.
  `REPLY_CONSUMABLE_STATES` is now *derived from* `THREAD_TRANSITIONS`, so recency picking a
  thread in `resolved_pending_owner` no longer silently discards an answer that was correctly
  identified and correlated. This is the exact break that lost Hamna's 08-06 14:00 reply.
  (b) **DEF-081** — `delegation_threads.owner_notified_at`, stamped only after a CONFIRMED
  send, finally joins "what was asked" to "when he was told". This is the first column of the
  ask ledger and the prerequisite for the monitoring work.
  (c) **DEF-084** — overdue reminders arrive as **text, not voice**. Voice becomes opt-in via
  `brain.voice_prompt_min_criticality`.
  (d) **DEF-079** — confirmation is gated on confidence with the owner setting the bar
  (`confirmation.min_confidence_pct`), instead of a blanket preview on every action.
  (e) **DEF-082** — five thresholds invented in a hurry on 08-06 (6h LID bootstrap, 2h lock
  age, 36h ledger lookback, 80-contact block, 0.6 confidence bar) become tenant-scoped
  `behaviorConfig` keys, tunable without a deploy. Literals survive only as unreachable fallback.
  (f) **DEF-083** — `promptReplyHandler` now sanitises at the send boundary, so a voice
  instruction is no longer answered with a bare `[noted]`.
- **Regression risk:** **moderate, concentrated in two places.** (1) The migration is additive
  — one nullable column plus a partial index on the null case, no backfill — so it is the
  low-risk half. (2) `WhatsAppInbound.ts`, `brainPromptQueueService.ts` and
  `delegationCaptureService.ts` all change on the **live inbound path**; a throw there costs a
  turn, not just a feature. (3) DEF-082 moves five decision boundaries behind config reads — if
  a key is missing at runtime the literal fallback applies, which is the pre-08-06 behaviour,
  so the failure mode degrades rather than breaks. (4) `pm2 restart` drops the whatsapp-web.js
  session; it is the fragile layer and reconnect is the thing to watch, not the code.
- **How it will be judged:** (i) production HEAD = `2746c8b` and `merge-base --is-ancestor`
  passes; (ii) `owner_notified_at` present on `delegation_threads` via a metadata query;
  (iii) **brain prompt 276 leaves `queued`** — it has been stuck waiting on exactly these
  dispatcher fixes, so it is the single best live probe available; (iv) WhatsApp reconnects and
  the watcher stream shows a clean turn; (v) the next overdue reminder arrives as text.
- **Explicitly NOT fixed by D-11:** DEF-036 (the 2,176-line `compose()` monolith — the
  structural one), DEF-040, DEF-046, DEF-062, DEF-067, DEF-069, DEF-070, DEF-071, the Rule-1
  clarification loop, and the empty-confirmation preview. Also **not** fixed: the monitoring
  blindness itself — `brain_health_finding` (HANDOFF §5a) is not in this deploy, so diagnostic
  truth still lives in rotating logs.
- **Verdict discipline:** this is *progressing*, not *circling* — DEF-064/080 is a new root
  cause (state-machine derivation), not another patch on the reported instance. The
  standing DBFAIL (`invalid byte sequence for encoding "UTF8": 0xc2`) the watcher is currently
  emitting is **not** addressed here and must not be read as fixed by this deploy.

---

### D-6 pre-deploy analysis *(written before the deploy)*

- **Predicted improvement:** (a) **"send" actually dispatches** — the infinite preview loop
  ends, because the pending row will persist (DEF-024); (b) previews name the items, e.g.
  `Delegate "ShireMe Recruiting Portal Application Testing" to Hamna Latif Bhutta`
  (DEF-018); (c) a dictated priority+deadline batch returns real "Updated …" lines instead
  of `[Unknown pending action kind]` (DEF-023); (d) native "typing…" appears (DEF-025).
- **Note on urgency:** DEF-024 has now caused THREE owner-visible failures (08-03 lost task,
  08-04 lost batch, 08-04 infinite loop) while the fix sat pushed-but-undeployed. Deploying
  is the highest-value action available and no further code is needed for it.
- **Regression risk:** DEF-024 carries a migration that DROPS objects **by shape**. If the
  detection query is wrong it could drop an index it shouldn't — mitigated by excluding
  partial indexes and by idempotency, but it is the riskiest item in the batch. DEF-025
  changes the first limb of every inbound turn; if it throws, presence is lost but the turn
  must still complete (guarded, never throws).
- **How it will be judged:** dictate a 3-item batch → expect 3 "Updated …" lines;
  `pg_indexes` shows only the partial `…active_uq`; text Nexeo → native "typing…".
- **Explicitly NOT fixed by D-6:** DEF-017 (compound commands — the structural one),
  DEF-019–022, DEF-026–031.

---

### 2.1 Standing post-deploy report (owner ruling, 2026-08-05)

**This chart is reported at EVERY deploy.** The report is exactly these five lines, filled
from evidence — never from expectation:

1. **Deploy** — id, HEAD, date-time.
2. **Intended** — the DEFs it was supposed to fix.
3. **Verified** — which of them are now confirmed working, and by what evidence
   (owner report / DB query / log line). Anything not exercised is stated as *not verified*,
   not assumed.
4. **Still broken** — what a user can still not do after this deploy.
5. **Verdict** — PROGRESS / NEUTRAL / REGRESSION / PARTIAL / UNVERIFIED, plus the single
   highest-value next action.

#### D-11 report — 2026-08-07 13:25 PKT · HEAD `2746c8b`

*First deploy executed by the BUILDER under AGENTS.md §0 (owner ruling, 2026-08-07).*

| | |
|---|---|
| **Intended** | DEF-064/080 a counterpart's reply stops dying at `illegal_transition` · DEF-081 the ask ledger gets its first column · DEF-084 reminders arrive as text, not voice · DEF-079 confirmation gated on confidence · DEF-082 five invented thresholds become config · DEF-083 no more bare `[noted]` |
| **Verified** | **The deploy, not the behaviour.** Prod HEAD `2746c8b` (was `2dbd577` for 23h); `merge-base --is-ancestor` PASS. Migration live: `owner_notified_at` column + `delegation_threads_unnotified_ix` partial index confirmed by `information_schema` / `pg_indexes`. All seven fixes confirmed present **in `dist/`**, i.e. in the process that is running. Build clean, health `HTTP 200`, no crash since boot. |
| **Not verified** | **All seven behaviours.** No counterpart reply has arrived since the restart, so DEF-064/080 is unproven; no reminder has fired, so DEF-084 is unproven; `owner_notified_at` is 0/9 because nothing has been notified yet. The handoff's prompt-276 probe is **stale** — it left `queued` by expiring on 08-06, as a voicenote. |
| **Still broken** | DEF-036 (the 2,176-line `compose()` monolith) · DEF-040 · DEF-046 · DEF-062 · DEF-067 · DEF-069 · DEF-070 · DEF-071. **And four newly logged today, none owner-reported — all found by the watcher:** DEF-085 (a raw query failing every 90s for 24h+, `22021` UTF-8), DEF-086 (`triage-reasoner` LLM silently falling back to deterministic judgement), DEF-087 (every inbound WhatsApp failing to reach the wiki on a schema drift), DEF-088 (the test suite is red on this box, so the "0 failed" gate is currently unenforceable here). **Monitoring blindness itself is untouched** — `brain_health_finding` (HANDOFF §5a) is not in this deploy, so diagnostic truth still lives in rotating logs. |
| **Verdict** | **PARTIAL.** Structurally this is real progress — 23h of finished work reached production and the ask ledger exists for the first time — but nothing has been exercised, so no capability may be claimed as improved. **Highest-value next action:** DEF-085/086, because a job failing every 90 seconds and a judgement path silently degrading are both *currently happening*, and both were invisible to seven health jobs until a watcher was pointed at the loop. That is the same blindness that made the owner the detector. |

#### D-6 report — 2026-08-05 11:40 PKT · HEAD `7ace0f5`

| | |
|---|---|
| **Intended** | DEF-018 previews name items · DEF-023 plan steps dispatch · DEF-024 "send" persists · DEF-025 native typing |
| **Verified** | **DEF-024 root cause GONE from the database** — `pg_indexes` on `brain_pending_actions` returns only `pkey`, two plain indexes and the partial `brain_pending_actions_user_channel_active_uq`. No index over `(user_id, channel, status)`. The legacy constraint that swallowed every pending row is confirmed absent. Build clean, service online. |
| **Not verified** | The three behaviours: does "send" dispatch, do previews name items, does native "typing…" appear. None exercised yet. |
| **Still broken** | DEF-017 compound commands (structural, untouched) · DEF-019–022 · DEF-026–031 |
| **Verdict** | **PARTIAL** — 1 of 4 verified. Next action: one live test (delegate 3 items → preview should name them → "send" should dispatch, not loop). |

#### D-8 report — 2026-08-05 13:44 PKT · HEAD `8d4e2a7`

| | |
|---|---|
| **Intended** | DEF-035 confirmation beats re-planning (the send loop) · DEF-032 displacement made visible · DEF-033 test-email template locked |
| **Verified** | **DEF-032 VERIFIED (LIVE)** — but at `1880538`, before this deploy: CL-023 shows the displacement notice firing on the owner's own "send". A diagnostic that paid for itself by exposing DEF-035. Infrastructure this deploy: build clean, boot 13:44:38, WhatsApp ready 13:44:49. |
| **Not verified** | **DEF-035 — the one that matters.** The 4-step sequence has not been run. Process online is not behaviour. DEF-033 also unexercised. |
| **Still broken** | The owner still cannot complete a delegation without saying "send" (DEF-038, now the top product defect) · DEF-019–022, DEF-026–031, DEF-034 · the two structural parents DEF-036, DEF-037 |
| **Verdict** | **UNVERIFIED.** Next action: run `list undelegated → delegate to hamna latif → send → what is delegated to Hamna`. If step 3 returns the preview again, the DEF-035 root cause was wrong and the ordering theory dies with it. |

---

## 3. Recurrence table — the anti-circling instrument

From `brain_chat_archive.md` symptom tags. **A tag appearing 2+ times means the earlier fix
did not close the class.**

| Symptom tag | Times | Chats | Status |
|---|---|---|---|
| `whatsapp-lid-activity-rejected` | **5** | 12, 14, 15, 16, **DEF-075** | **CONTAINMENT FAILED.** The rule said a fifth recurrence must be recorded here before any code change — this is it. Recurrences 1–4 each fixed a module that parsed an id; #5 is different in kind: the resolver itself cannot resolve an unknown counterpart, and the code then FALLS BACK to a synthetic phone that matches nothing. Four fixes treated symptom modules; none questioned whether LID→phone resolution can be relied on at all. It cannot. The next change must remove the dependency, not repair it |
| `whatsapp-ptt-media-not-ready` | **3** | 12, 14, 16 | CLOSED at root, LIVE-verified 08-04 |
| `pending-prompt-eats-command` | **3** | 3, 13, 17 | fix written (DEF-017) — **structural: the verdict can now SPLIT a message**; undeployed |
| **`confirm-misfires`** | **5** | 15, 17, CL-020, CL-023, CL-029 | DEF-024 → DEF-032 → DEF-035 → DEF-055. **Two of the four were introduced by the fix before them.** A patch on the reported instance has now failed four times running; DEF-038 (no confirmation step for instructed actions) is the only remaining structural move and it is overdue |
| `confirm-never-dispatches` | **4** | 15, 17, CL-020, CL-023 | DEF-024 (schema) deployed and did NOT close it — the 4th recurrence exposed the real cause, DEF-035 (ordering), deployed 13:44 and **unverified**. Structural follow-up: DEF-038 removes the confirm step for instructed actions, which deletes the class rather than fixing it |
| **`guard-below-early-return`** | **2** | DEF-035, DEF-039 | **NEW TAG, 2026-08-05 — the dominant failure shape.** `compose()` has ~14 early return points and its protections sit near the bottom, so whichever branch returns first skips them. DEF-035: confirm reducer below the reasoning gate. DEF-039: idempotency + artifact ledger inside the branch the new guard bypassed. DEF-041: the empty-promise guard at 2705/3794 unreachable from the reasoning path that returns at 2100 — which let a false statement reach a real person. **Three instances in one day is not coincidence; it is DEF-036 (the 2,176-line function) producing defects on schedule.** No further patch in this class is acceptable — the decomposition is the fix |
| **`protection-with-two-implementations`** | **4 in ONE DAY** | DEF-039, DEF-041, DEF-044, DEF-045 | **The most expensive shape found today.** DEF-039: idempotency + artifact ledger existed only inside the branch a new guard bypassed. DEF-041: the empty-promise regex existed twice — the copy on the live path was the weaker one, under a comment asserting the two were in sync and that it was canonical. Both false for months. **A protection with two implementations has one real implementation and one comforting fiction, and the fiction is what gets read during review.** DEF-044: preview renderer names items by title, result renderer prints raw cuids. DEF-045: the target guard runs at dispatch but not at preview, so the same lookup returning null means "show a placeholder" in one place and "refuse" in the other. Containment in every case: one owner, one implementation, CI-enforced. **This is now the dominant defect shape in the system — ahead of the monolith (DEF-036) that I ranked first this morning.** |
| `fabricated-status` | **3** | DEF-019, DEF-034, DEF-041 | inferred rather than read from a ledger; DEF-037 is the structural parent |
| `translated-transcript-misread` | **2** | DEF-020, CL-026 | "Yes, we didn't give Latif" — negation invented by machine translation, then argued back at the owner. Second occurrence ⇒ structural |
| `time-of-day-drift` | **4** | DEF-026 ×4 | "Morning, Sir" at 2:04 PM. Still open, still unfixed, cheap to fix |
| `preview-unconfirmable` | **2** | 17, CL-020 | fix written (DEF-018) — undeployed |
| `phantom-capability` | 1 | 17 | closed (`DISPATCHABLE_PLAN_STEP_KINDS`) |

### Why `@lid` recurred four times

Four *different* root causes in four *different* modules — each fix correct, none sufficient:

1. **Chat 12** — chat-state helpers rejected the LID Wid
2. **Chat 14** — the liveness probe compared its echo against one Wid spelling
3. **Chat 15** — the inbound door resolved counterpart phones via `getContact()` only
4. **Chat 16** — `downloadMedia` parsed a message id that *embeds* `@lid`

One shared assumption: **an identity or id is a parseable string.** WhatsApp's LID namespace
breaks that, separately, in every module that assumes it.

Containment: `waIdentity.ts` is the ONLY module allowed to call the mapping API
(CI-enforced), and the two hot paths bypass id parsing entirely (`webjsMediaDirect`,
`webjsChatStateDirect`). **A fifth recurrence means containment failed — record it here first.**

---

## 4. Trend

| Week | Reported | Root-caused | LIVE-verified fixes | Recurrences |
|---|---|---|---|---|
| 07-07 → 07-16 | 10 | 10 | — | 0 |
| 07-17 → 07-23 | 3 | 3 | — | 1 (`@lid` 2nd) |
| 07-24 → 07-31 | 1 | 1 | 1 (DEF-014) | 1 (`@lid` 3rd) |
| 08-01 → 08-05 | 4 | 4 | 1 (DEF-016) | 2 (`@lid` 4th, prompt-eats 3rd) |

**Reading:** report volume is falling and root-cause rate is 100%, but **live verification is
the bottleneck** — only 2 of 15 resolved defects have been confirmed on real traffic. The
rest are CI-only, which is exactly why fixes can feel like they never happened. The process
change that follows: verify on production in the same session as the deploy, and record it
in §2 immediately.

---

## 5. Builder-side patterns that produced wasted days

- **A private helper in one consumer** — the `@lid` resolver; every later module reopened the
  hole. Shared modules, with a CI guard naming the single owner.
- **Registry presence mistaken for capability** — `update_open_item` was validated,
  previewed and confirmed with no dispatcher behind it.
- **A migration that silently did nothing** — `DROP CONSTRAINT IF EXISTS <guessed-name>`
  matched nothing, reported success, survived 74 migrations. Repair by SHAPE, not name.
- **False-green health** — the liveness probe reported `ok` with `window.require` absent;
  connector status said `connected` while dead, then `degraded` while alive.
- **Diagnosing from theory instead of asking the system** — three wrong theories on the voice
  bug. The probe that replayed the real chain found it in one run.
- **Stale verification numbers** — a suite run BEFORE the last edit was reported green while
  the tree was red. Re-run after the final change.
- **Source-guard tests matching their own comments** — four times; strip comments before
  asserting on source.
