# Brain Chat Log Register

**Register version:** v1.7 · **Last updated:** 2026-08-05 14:40 PKT
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
| CL-023 | 2026-08-05 13:03–13:06 | WhatsApp | **The loop, caught red-handed.** Correct 4-step delegation preview → "send" → identical preview WITH my new displacement warning → "confirm" → identical preview again. The warning proved the mechanism: each confirmation was creating a NEW plan instead of confirming the stored one. Also visible: "Morning, Sir" at 1:03 PM (DEF-026) and a due date of **Mar 29, 2024** still on Leave Request (DEF-031 debris) | DEF-035 | **ROOT CAUSE FOUND — ordering** |
| CL-024 | 2026-08-05 13:30–14:10 | direct | Two cognitive-architecture proposals handed over for honest review (GWT/ACT-R single-file brain; predictive-processing sandbox agent), with authorisation to rewrite the codebase because "current brain working is not acceptable". Then the sharper product observation: **"why do I need to say 'send' where I am instructing?"** and the rule that followed — *Brain should confirm only when the request is not normal or carries risk, and then only after naming the risk* | DEF-036, DEF-037, DEF-038 | NEW (architecture + product policy) |
| CL-025 | 2026-08-05 14:00 | direct | **External code audit delivered.** 2 critical, 5 high. Both criticals verified in source by me: (1) the DEF-035 guard dispatching without idempotency — duplicate emails/WhatsApp to real people, live on production at the time; (2) `fetch_contact_full` returning another user's private contact. Audit's code findings are strong; its "missing for human-like cognition" list is graded against an unspecified aspiration and contains category errors (no continual neural learning on hosted models, no embodied loop). Two items on it are real: no unified memory, and three capability registries with three different ceilings — the latter is DEF-023's root cause | DEF-039, DEF-040, BLD-005 | **NEW — and DEF-039 is a REGRESSION I introduced this morning** |
| CL-026 | 2026-08-05 14:04–14:11 | WhatsApp + Gmail | **The worst incident recorded.** Brain said "I will delegate all four unassigned items to Hamna Latif Bhutta now", delegated nothing, then emailed Hamna from the owner's own address stating the items HAD been delegated — and four minutes later correctly reported she has no items. Also visible: negation invented from a translated voice note ("Yes, we didn't give Latif") costing 3 turns; "Morning, Sir" at 2:04 PM; the DEF-031 junk item "Priority High" delegated and named to a real colleague; email had no greeting, no line breaks, no list; an opaque candidate id (`follow_up_policy.cmoq9jmj…`) shown to the owner; the follow-up instruction stored as free-form text with no cadence, so no monitoring was actually created | DEF-041, DEF-042, DEF-020 (2nd), DEF-026 (4th), DEF-031, DEF-038 | **RECURRING — `guard-below-early-return` 3rd in one day** |
| CL-022 | 2026-08-05 11:52–11:57 | WhatsApp | **DEF-017 + DEF-018 CONFIRMED WORKING** — one dictated compound voice note decomposed into a correct 5-step preview naming every item and field. Then it went wrong: an ambiguous follow-up displaced the plan, "send" dispatched a **canned test email to a real colleague under the owner's own name**, Brain then said "nothing was executed on my end" right after sending it, and five minutes later reported "no actionable items delegated to Hamna Latif" — the plan was gone | DEF-032, DEF-033, DEF-034 | DEF-017/018 VERIFIED; three NEW |
| CL-021 | 2026-08-05 11:50 | direct | "ok go ahead" — authorised the DEF-017 structural fix | DEF-017 | — |
| CL-019 | 2026-08-05 11:00 | direct | Owner ruling: keep THREE docs — change log (errors + solutions + deployed), chat log (this file), evaluation chart (before/after deploy impact) | — (three-doc split implemented) | NEW (process) |

---

## Observations that went RIGHT (recorded deliberately)

| CL | What worked |
|---|---|
| CL-017 | Voice reading + **English transcripts of Urdu speech**; semantic recovery of "exam solution" → "EXIM solution"; correctly spotted a duplicate item; accepted the "ShireMe" title correction; honest receipt reporting ("accepted but no receipt ID, I won't retry") |
| CL-016 | Honest "I can't read text from images" instead of pretending |
| CL-014 | Preview-before-dispatch held — no message was sent to a counterpart without explicit confirmation |
| CL-022 | **The 5-step preview was exactly right** — every item named with its priority and deadline, delegation steps separate. That is DEF-017 (compound decomposition) and DEF-018 (named previews) both working on first live exposure |
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
