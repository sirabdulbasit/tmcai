# Brain Chat Log Register

**Register version:** v1.1 · **Last updated:** 2026-08-05 11:20 PKT
**Companions:** `brain_change_log.md` (what we DID — DEF-NNN + deploy status) · `brain_evaluation_chart.md` (per-deploy before/after impact)
**Post-mortems:** `brain_chat_archive.md` (root cause + paired executable scenario)

## What this file is for (owner ruling, 2026-08-05)

Every chat log the owner sends is registered here as **`CL-NNN`** with the date-time it
was received and what was OBSERVED — the owner's side of the story, before any diagnosis.
The change log records what was DONE about it, and the evaluation chart records whether the deploy that followed actually helped. Comparing the two answers the question that prompted
this: *did what we observed actually get treated, or did we go round again?*

**Intake rules**

1. A chat log gets a `CL-NNN` row the same session it arrives. Nothing is triaged from
   memory.
2. Each observation maps to one or more `DEF-NNN` in the change log. An observation with no
   DEF id means it was noticed and not acted on — that must be visible, not silent.
3. Mark each observation **NEW** or **RECURRING**. Recurring means the symptom tag already
   exists in the evaluation chart §3, and the rule then is a structural fix, not another patch.
4. Note what went RIGHT too. Three sessions in a row of only-defects gave a false picture
   of a system that was in fact improving in most respects.

---

## Register

| CL | Received (PKT) | Channel | Observed | DEF ids | New/Recurring |
|---|---|---|---|---|---|
| CL-001…CL-010 | 2026-07-07 → 07-16 | WhatsApp | Backfilled from archive Chats 1–10: ad-hoc attendee drop, fabricated send claims, `[noted]` marker leak, wrong-owner routing, and others | DEF-001…DEF-010 | all closed |
| CL-011 | 2026-07-17 | WhatsApp | Voice pipeline silent — no processing state visible at all | DEF-011 | NEW |
| CL-012 | 2026-07-17 | WhatsApp | `@lid` activity rejected; PTT media unavailable | DEF-012 | NEW (opens the `@lid` class) |
| CL-013 | 2026-07-22 | WhatsApp | "Whatsup?" consumed as an action-status answer → `[blocker recorded]` | DEF-013 | NEW (opens `pending-prompt-eats-command`) |
| CL-014 | 2026-07-27 17:25 | WhatsApp | Delegation sends refused: `[notifyviawhatsapp failed: no tenant whatsapp channel configured]`; no typing sign; voice unreadable | DEF-014, DEF-025 | RECURRING (`@lid` 2nd) |
| CL-015 | 2026-08-04 (covering 08-03) | WhatsApp | Yousaf's reply never arrived; Brain claimed "connection degraded" while DB said connected; compound command produced a **2024-03-29** deadline and a junk task titled "Priority High"; `[actionplan failed to queue]` | DEF-015, DEF-017, DEF-019, DEF-024 | RECURRING (`@lid` 3rd, prompt-eats 2nd) |
| CL-016 | 2026-08-04 19:45 | WhatsApp | Voice notes still `[I could not read that voice note]` after two fix attempts | DEF-016 | RECURRING (`@lid` 4th) |
| CL-017 | 2026-08-04 20:00 | WhatsApp | **Voice now works** (`🎙️ Heard:` + English transcripts). But: 3-step preview showed "• update open item ×3" with no detail; "yes" → `[Unknown pending action kind: updateopenitem]`, all three updates lost; gender argument from a translated pronoun; corrected title reverted; queue interrupted mid-conversation | DEF-018, DEF-020, DEF-021, DEF-022, DEF-023 | mixed — DEF-016 CONFIRMED FIXED; rest NEW |
| CL-018 | 2026-08-05 10:20 | direct | "Do you have any log of what we changed… I feel we are moving in circles" — process observation, not a defect | — (produced this register + the change log + the evaluation chart) | NEW (process) |
| CL-020 | 2026-08-04 20:22 | WhatsApp | **"send" never dispatches — infinite preview loop.** Said "send" twice, got the identical 3-step preview back both times. Preview again blind: "Delegate item to Hamna Latif Bhutta" ×3 with no item names. Junk task "Priority High (due yesterday)" still listed. Correctly reported the 3 items are NOT yet delegated to Hamna | DEF-024 (recurrence), DEF-018 (2nd), DEF-031 | **RECURRING — DEF-024, fix already written and pushed but NOT DEPLOYED** |
| CL-019 | 2026-08-05 11:00 | direct | Owner ruling: keep THREE docs — change log (errors + solutions + deployed), chat log (this file), evaluation chart (before/after deploy impact) | — (three-doc split implemented) | NEW (process) |

---

## Observations that went RIGHT (recorded deliberately)

| CL | What worked |
|---|---|
| CL-017 | Voice reading + **English transcripts of Urdu speech**; semantic recovery of "exam solution" → "EXIM solution"; correctly spotted a duplicate item; accepted the "ShireMe" title correction; honest receipt reporting ("accepted but no receipt ID, I won't retry") |
| CL-016 | Honest "I can't read text from images" instead of pretending |
| CL-014 | Preview-before-dispatch held — no message was sent to a counterpart without explicit confirmation |
| CL-020 | Honestly reported "no actionable items delegated to Hamna Latif" rather than claiming the earlier failed delegation had worked — the no-fabrication rule held under pressure |
| CL-015 | Disambiguated "Haider Ali" vs "Ali Haidar" by asking, with real context, instead of silently substituting |

---

## How to use this with the other two docs

Before starting any change:

1. Find the newest `CL` row and its DEF ids.
2. For each DEF, check the evaluation chart §3 for the symptom tag.
3. **State the verdict plainly:** *progressing* (new root cause) or *circling* (tag already
   present → the earlier fix failed; structural fix required).
4. Only then write code.
