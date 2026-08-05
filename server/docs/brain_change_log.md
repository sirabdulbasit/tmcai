# Brain Change Log

**Version:** v1.0 · **Last updated:** 2026-08-05 11:00 PKT

**One of three governing documents** (owner ruling, 2026-08-05):

| Doc | Job |
|---|---|
| **`brain_change_log.md`** ← this file | Errors faced/recorded → solution provided → **deployed?** |
| `brain_chat_log.md` | Record of every chat log received (`CL-NNN`) |
| `brain_evaluation_chart.md` | Are we moving ahead? Per-deploy before/after impact |

## Rules

1. Every error the owner reports gets a **`DEF-NNN`** row here in the same session, with the
   date-time reported. Nothing is carried in conversation only.
2. A row is complete only when it has: **root cause** (not a restated symptom), **solution**,
   **fix commit**, **deployed date-time**, and **verification** (CI / LIVE).
3. `DEPLOYED` ≠ `VERIFIED`. A fix on production that nobody has exercised is
   `deployed, unverified` and must say so.
4. Symptom tags come from the existing vocabulary so recurrence is detectable — see the
   evaluation chart's recurrence table.

**Status vocabulary:** `OPEN` · `FIXED (not deployed)` · `DEPLOYED (unverified)` ·
`VERIFIED (CI)` · `VERIFIED (LIVE)` · `REOPENED`

---

## A. Resolved

| DEF | Reported | Error (owner-visible) | Root cause | Solution | Commit | Deployed | Status |
|---|---|---|---|---|---|---|---|
| DEF-001 | 07-07 | Empty "With:" line on a meeting for a non-contact | ad-hoc attendee email dropped by the parser | retain ad-hoc emails/phones in `normaliseAction` | `682bbc1` | 07-07 | VERIFIED (CI) |
| DEF-002 | 07-08 | "The email has been sent to Asad" — never sent | passive-voice completion claim escaped a first-person-only guard | widen `claimsCompletion` to passive/third person | `259f972`, `459bd4d` | 07-08 | VERIFIED (CI) |
| DEF-003 | 07-08 | "send a test email…" answered `[noted]` | stale prompt captured a command | imperative detection + marker sanitiser | `c977a3d` | 07-08 | VERIFIED (CI) |
| DEF-004 | 07-10 | Proposed messaging Asad about Yousaf's item | prompt block gave owner NAME but no routable id → substitution | bind routable id; forbid closest-match | `680c441` | 07-10 | VERIFIED (CI) |
| DEF-005…010 | 07-10→07-16 | see archive Chats 5–10 | various | various | — | — | VERIFIED (CI) |
| DEF-011 | 07-17 | Voice pipeline silent, no processing state | no observable activity signal | activity layer (reaction + presence) | — | 07-17 | VERIFIED (CI) |
| DEF-012 | 07-17 | `@lid` activity rejected; PTT unavailable | chat-state helpers rejected the LID Wid | phone-chat retry limb | — | 07-17 | VERIFIED (CI) |
| DEF-013 | 07-22 | "Whatsup?" answered `[blocker recorded]` | a regex allowlist was the final decision boundary | LLM relevance gate ahead of `recordAnswer` | `741d907` | 07-22 | VERIFIED (CI) |
| DEF-014 | 07-27 17:25 | Delegation sends refused **6 days**; `[no tenant whatsapp channel configured]` | probe echo compared against ONE Wid spelling; then 3 in-memory flags self-locked with no exit | `@lid`-aware echo set; `recordOutboundProof` re-arms; `repairReason` splits liveness from pairing | `5e3f3c1` | 07-31 | **VERIFIED (LIVE)** 07-31 |
| DEF-015 | 08-03 | Yousaf's reply vanished; Brain claimed "connection degraded" | inbound door resolved counterpart phone via `getContact()` only, which throws on `@lid` | shared `waIdentity.lidToPhone` as second limb | `72ed7f6` | 08-04 | DEPLOYED (unverified) — needs a counterpart reply |
| DEF-016 | 08-04 | **Voice notes unreadable** ("I could not read that voice note") | `downloadMedia` resolves the message from an id that EMBEDS `@lid`; the lookup throws before any network call | `webjsMediaDirect` — locate by string compare, then run the library's own download | `889edc0`, `b11fa3c` | 08-04 | **VERIFIED (LIVE)** 08-04 19:37 |
| DEF-023 | 08-04 20:00 | Confirmed 3-step plan died: `[Unknown pending action kind: updateopenitem]` — all updates lost | `update_open_item` was registry-valid, validated, previewed and confirmed but had NO dispatcher case | shared `applyOpenItemUpdate`; missing case added; `DISPATCHABLE_PLAN_STEP_KINDS` guard rejects undispatchable steps before confirmation | `666fb2a` | not yet | FIXED (not deployed) |
| DEF-024 | 08-03 | `[actionplan failed to queue: Unique constraint failed]` — lost a confirmed task, then a batch of three | legacy `UNIQUE(user_id,channel,status)`; the 07-22 repair migration dropped a **guessed** name and silently no-op'd for 74 migrations | migration matching by COLUMN SET, not name; `startPending` survives the collision | `76739af` | not yet | FIXED (not deployed) |
| DEF-025 | 08-04 | No native typing/recording indicator on any turn | `sendChatstate` calls generic `createWid()` on an `@lid` id; WhatsApp keeps LID constructors separate | `webjsChatStateDirect` picks the constructor by domain | `c1e5ceb` | not yet | FIXED (not deployed) |

## B. Open

| DEF | Reported | Error | Root cause (if known) | Proposed solution | Status |
|---|---|---|---|---|---|
| **DEF-017** | 08-03, 08-04 | Compound commands partially consumed: "Priority High, due date today and delegate to Hamna" → deadline **2024-03-29**, junk task titled "Priority High", delegation dropped. "yes" → `[noted]`, nothing happens | pending-prompt/confirmation layer consumes part of a multi-intent message; the DEF-013 gate handles single-intent only | **structural** — multi-intent decomposition before the prompt layer can consume anything | **OPEN — top priority. 3rd appearance ⇒ structural fix required, not a patch** |
| DEF-018 | 08-04 19:57 | Preview showed "• update open item" ×3 with no names/priorities/dates — owner asked to approve blind | `renderPlanPreview` has no `update_open_item` case; falls to a default printing the bare kind | add the case; render item title + each changed field | OPEN — safety consequence |
| DEF-019 | 08-03 17:25 | Brain fabricated "my WhatsApp connection is currently degraded" while the DB said `connected` for 4 days | channel health inferred instead of read from a ground-truth block | supply health as a data block; forbid inferring it | OPEN |
| DEF-020 | 08-04 19:58 | Machine-translated pronoun treated as the owner's assertion: Urdu "unko" → "him" → Brain argued the owner called Hamna "he" (3 turns lost) | translated transcripts carry invented gender; composer isn't told the text is a translation | mark translated transcripts; never infer/challenge gender from them | OPEN |
| DEF-021 | 08-04 19:59 | Corrected title reverted — "ShireMe Recruiting Portal" confirmed, then "Shiny Recruitment Portal" a minute later | reasoning re-reads stale STT text instead of the persisted title | read titles from the item record only | OPEN |
| DEF-022 | 08-04 19:58 | Queue interrupted mid-conversation asking for a priority already dictated twice; hint offered date phrases for a priority question | no conversation-turn suppression; mismatched prompt copy | suppress during an active turn; fix copy per slot kind | OPEN |
| DEF-026 | multiple | "Morning, Sir" at 3:30 PM / 5:26 PM / 8:30 AM | prompt gets `getUserLocalDate` (date, no clock) while the persona few-shot opens "Morning, …" | inject local TIME; neutralise the few-shot | OPEN (`time-of-day-drift`) |
| DEF-027 | multiple | All-day events rendered with a time ("Office at 5 AM") | all-day events not distinguished in the calendar view | render all-day as all-day | OPEN |
| DEF-028 | 07-28 | `whatsapp_messages.error_message` NULL on every failed row | failure reason discarded at the write path | persist the reason | OPEN (observability) |
| DEF-029 | every boot | Alert email dead — `535 Authentication unsuccessful` for basit.ahmed@tmcltd**.com** | SMTP credentials/domain | fix credentials | OPEN — **this is why the 6-day outage went unnoticed** |
| DEF-030 | 07-28 | Owner's personal WA client down — `[fetchThreadContext] no client in user map, userId 2` | `UserWebjsProvider` session not initialised | re-pair / auto-init | OPEN |

**Absent by design, not defects:** WhatsApp calling (no foundation; owner excluded it).

---

## C. Undeployed work waiting on the box

`DEF-023`, `DEF-024`, `DEF-025` are fixed, pushed and **not yet on production**. Head to
deploy: `aaefa18` or later. `DEF-024` includes a migration
(`20260804_pending_unique_any_name`), so the deploy needs `prisma migrate deploy`.
