# Brain Evaluation Chart

**Version:** v2.6 · **Last updated:** 2026-08-05 14:10 PKT

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
| Multi-item dictation (priority + deadline batch) | ⚠️ fixed, **not deployed** | DEF-017, DEF-023 |
| Confirming a plan with "send" | ⚠️ **deployed 13:44, unverified** | DEF-035 — ordering, not the constraint |
| Acting on an instruction WITHOUT asking to confirm | ❌ not built | DEF-038 — blanket preview on every action |
| Preview shows WHICH items are affected | ❌ fixed, **not deployed** | DEF-018 |
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
| D-8 | **08-05 13:44** | `8d4e2a7` | DEF-035 (DEF-032/033 reached prod earlier, ~13:00) | **Predicted:** "send"/"confirm" DISPATCHES the plan shown — the loop ends and items are actually delegated. **Risk:** the guard is narrow (bare confirmation + `preview_shown` only) so a mis-phrased confirmation still falls through to the old path; a guard failure falls through rather than breaking the turn. **Judged by:** list undelegated items → "delegate these to hamna latif" → "send" → expect real delegation lines, then ask "what is delegated to Hamna" and expect the items to appear. | Build clean (`tsc` silent), boot 13:44:38, WhatsApp ready 13:44:49 on `+923274572102`, 4 min clean traffic, no stack traces. **Behaviour NOT exercised — the 4-step sequence has not been run.** Correction to the handoff: production was on `1880538`, not `4ec5d99`, so DEF-032/033 were already live — and CL-023 proves the DEF-032 displacement notice fired correctly on the owner's own "send", which is what exposed DEF-035. | **UNVERIFIED** |
| D-7 | **08-05 12:02** | `4ec5d99` | DEF-017 | **Predicted:** a dictated compound instruction no longer loses its tail — the priority is recorded AND the due date + delegation are acted on; a past/absurd deadline is refused instead of written. **Risk:** the classifier could split badly and send a wrong residual to chat — mitigated because an incomplete split is rejected outright and low confidence falls through unchanged. **Judged by:** with a priority prompt awaiting, say "Priority High, due date Friday and delegate to Hamna" → expect the priority recorded AND a follow-up acting on date+delegation. | build clean, service online; behaviour **not yet exercised**. Side effect: the pull also REVERSED BLD-001 — `nexeo_self_learning&development.md` removed from production (1681 lines). It had never existed there before my commit created it, so prod is back to its original state and the local copy is intact at 42KB. | UNVERIFIED |
| D-6 | **08-05 11:40** | `7ace0f5` | DEF-018, DEF-023, DEF-024, DEF-025 | see pre-deploy analysis below | **schema VERIFIED**: `pg_indexes` shows only the partial `…active_uq`, no `(user_id,channel,status)` index → DEF-024's root cause is gone from production. Build clean, app up. Behaviour (send-loop, previews, typing) **not yet exercised** | **PARTIAL** — 1 of 4 verified |

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
| `whatsapp-lid-activity-rejected` | **4** | 12, 14, 15, 16 | contained structurally — see below |
| `whatsapp-ptt-media-not-ready` | **3** | 12, 14, 16 | CLOSED at root, LIVE-verified 08-04 |
| `pending-prompt-eats-command` | **3** | 3, 13, 17 | fix written (DEF-017) — **structural: the verdict can now SPLIT a message**; undeployed |
| `confirm-never-dispatches` | **4** | 15, 17, CL-020, CL-023 | DEF-024 (schema) deployed and did NOT close it — the 4th recurrence exposed the real cause, DEF-035 (ordering), deployed 13:44 and **unverified**. Structural follow-up: DEF-038 removes the confirm step for instructed actions, which deletes the class rather than fixing it |
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
