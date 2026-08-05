# Brain Evaluation Chart

**Version:** v2.0 · **Last updated:** 2026-08-05 11:00 PKT

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
| Multi-item dictation (priority + deadline batch) | ❌ **broken** | DEF-017, DEF-023 |
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
| D-6 | *pending* | `aaefa18`+ | DEF-023, DEF-024, DEF-025 | see pre-deploy analysis below | — | UNVERIFIED |

### D-6 pre-deploy analysis *(written before the deploy)*

- **Predicted improvement:** a dictated batch of priority+deadline updates returns real
  "Updated …: priority=high, due=…" lines instead of `[Unknown pending action kind]`;
  `[actionplan failed to queue]` disappears; native "typing…" appears under the name.
- **Regression risk:** DEF-024 carries a migration that DROPS objects **by shape**. If the
  detection query is wrong it could drop an index it shouldn't — mitigated by excluding
  partial indexes and by idempotency, but it is the riskiest item in the batch. DEF-025
  changes the first limb of every inbound turn; if it throws, presence is lost but the turn
  must still complete (guarded, never throws).
- **How it will be judged:** dictate a 3-item batch → expect 3 "Updated …" lines;
  `pg_indexes` shows only the partial `…active_uq`; text Nexeo → native "typing…".
- **Explicitly NOT fixed by D-6:** DEF-017 (compound commands), DEF-018 (blind previews),
  DEF-019–022, DEF-026–030.

---

## 3. Recurrence table — the anti-circling instrument

From `brain_chat_archive.md` symptom tags. **A tag appearing 2+ times means the earlier fix
did not close the class.**

| Symptom tag | Times | Chats | Status |
|---|---|---|---|
| `whatsapp-lid-activity-rejected` | **4** | 12, 14, 15, 16 | contained structurally — see below |
| `whatsapp-ptt-media-not-ready` | **3** | 12, 14, 16 | CLOSED at root, LIVE-verified 08-04 |
| `pending-prompt-eats-command` | **3** | 3, 13, 17 | **OPEN — DEF-017, structural fix required** |
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
