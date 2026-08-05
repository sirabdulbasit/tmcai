# Brain Evaluation Ledger

**Purpose:** answer three questions at a glance, with evidence — *what broke, was it
really fixed, and is the same thing coming back?* Created 2026-08-04 because the owner
could not tell whether the work was progressing or circling. Neither could the builder,
from the artefacts that existed.

**What already existed and why it was not enough**

| Artefact | Holds | Missing |
|---|---|---|
| `brain_chat_archive.md` | 17 incident post-mortems, root causes, fix commits | no cross-incident view; recurrence invisible |
| `tests/brainScenarios.ts` | 16 executable regression locks (`chat1`…`chat16`) | proves a fix holds; says nothing about *open* defects |
| git history | 21 commits since 07-24 with full reasoning | not organised by defect |
| chat messages | most of the OPEN defect list | **not written down anywhere** ← the real gap |

The last row is the actual problem. Defects were diagnosed in conversation and carried
verbally. If a session ended, the queue was lost. This file is the fix.

---

## 1. Scoreboard (2026-08-04)

- **17** incidents reported and root-caused
- **16** locked by an executable scenario (100% of chats have a regression test)
- **14** never recurred after their fix
- **3** symptom classes recurred — see §2
- **11** defects currently OPEN — see §4

**Verdict on "are we circling?"** Partly, and precisely: **not** across the 14 closed
incidents, but **yes** inside two classes. One of those (`@lid`) is now believed
structurally closed; the other (`pending-prompt-eats-command`) is genuinely unresolved
after three appearances and is the top open item.

---

## 2. Recurrence table — the anti-circling instrument

Computed from the archive's symptom tags. **A tag appearing 2+ times means the earlier
fix did not close the class.** This table is the reason the file exists.

| Symptom tag | Times | Chats | Status |
|---|---|---|---|
| `whatsapp-lid-activity-rejected` | **4** | 12, 14, 15, 16 | believed CLOSED structurally — see below |
| `whatsapp-ptt-media-not-ready` | **3** | 12, 14, 16 | CLOSED at root (Chat 16) — live-verified 08-04 |
| `pending-prompt-eats-command` | **2** | 3, 13 (+ unlogged 08-03, 08-04) | **OPEN — highest priority** |

### Why `@lid` recurred four times (the lesson worth keeping)

Each recurrence had a *different* root cause in a *different* module, so each fix was
correct and none was sufficient:

1. **Chat 12** — chat-state helpers rejected the LID Wid → fixed with a phone-chat retry
2. **Chat 14** — the liveness probe compared its self-chat echo against one Wid spelling
3. **Chat 15** — the inbound door resolved counterpart phones via `getContact()` only
4. **Chat 16** — `downloadMedia` parsed a message id that *embeds* `@lid`

The single underlying assumption, present in every case: **an identity or id is a
parseable string**. WhatsApp's LID namespace breaks that, and it broke separately in
chat state, liveness, counterpart identity and message ids.

Structural close: `whatsapp/waIdentity.ts` is now the **only** module allowed to call the
mapping API (a test fails CI if another file does), and both remaining hot paths bypass
id parsing entirely (`webjsMediaDirect`, `webjsChatStateDirect`). A fifth recurrence would
mean this containment failed — record it here first.

---

## 3. Closed defects

Each row is verifiable: read the archive entry, run the scenario, check the commit.

| # | Reported | Symptom (owner-visible) | Root cause | Fix | Locked by |
|---|---|---|---|---|---|
| 1 | 07-07 | Empty "With:" line on a meeting for a non-contact | ad-hoc attendee email dropped by the parser | `682bbc1` | `chat1` |
| 2 | 07-08 | "The email has been sent to Asad" — never sent | passive-voice completion claim escaped the guard | `259f972`, `459bd4d` | `chat2` |
| 3 | 07-08 | "send a test email…" answered `[noted]` | stale prompt captured a command | `c977a3d` | `chat3` |
| 4 | 07-10 | Proposed messaging Asad about Yousaf's item | owner NAME without routable id in the prompt block | `680c441` | `chat4` |
| 5–10 | 07-10→07-16 | see archive Chats 5–10 | — | — | `chat5`–`chat10` |
| 11 | 07-17 | Voice pipeline silent, no processing state | no observable activity signal | — | `chat11` |
| 12 | 07-17 | `@lid` activity rejected; PTT unavailable | LID Wid rejected by chat-state helpers | — | `chat12` |
| 13 | 07-22 | "Whatsup?" answered `[blocker recorded]` | regex allowlist was the decision boundary | `741d907` | `chat13` |
| 14 | 07-27 | Delegation sends refused for 6 days | probe echo matched one Wid spelling; 3 flags self-locked | `5e3f3c1` | `chat14` |
| 15 | 08-03 | Yousaf's reply vanished; "connection degraded" excuse | door resolved counterpart phone via `getContact()` only | `72ed7f6` | `chat15` |
| 16 | 08-04 | **Voice notes unreadable** | message id embeds `@lid`; lookup throws before any network call | `889edc0`, `b11fa3c` | `chat16` |

**Live-verified on production:** #16 (voice reading + English transcripts, 08-04 19:37).

---

## 4. OPEN defects — the queue that was previously only in chat

Ordered by cost to the owner. **This section is the one to keep current.**

| ID | Symptom | Root cause (if known) | Evidence | Status |
|---|---|---|---|---|
| **O1** | Compound commands partially consumed. "Priority High, due date today and delegate to Hamna" → deadline set to **2024-03-29**, junk task titled "Priority High" created, delegation dropped. "yes"/"deligate it" → `[noted]`, nothing happens | pending-prompt/confirmation layer consumes part of a multi-intent message; Chat 13's LLM relevance gate handles single-intent only | 08-03, 08-04 chats | **OPEN — top priority** (3rd appearance of the class) |
| **O2** | Preview lists "• update open item ×3" with no item names, priorities or dates — owner asked to approve blind | `renderPlanPreview` has no case for `update_open_item`, falls to a default printing the bare kind | 08-04 19:57 | OPEN — safety consequence |
| **O3** | Brain fabricated "my WhatsApp connection is currently degraded" while the DB said `connected` for 4 days | channel health inferred rather than read from a ground-truth block | 08-03 17:25 | OPEN |
| **O4** | Machine-translated pronoun treated as the owner's assertion. Urdu "unko" → English "him" → Brain argued the owner called Hamna "he", costing 3 turns | translated transcripts carry invented gender; no marker telling the composer the text is a translation | 08-04 19:58–19:59 | OPEN |
| **O5** | Corrected title reverts. Owner fixed "Shair Mi" → "ShireMe Recruiting Portal", Brain confirmed, then said "Shiny Recruitment Portal" one minute later | reasoning re-reads stale STT text instead of the persisted title | 08-04 19:59 | OPEN |
| **O6** | Prompt queue interrupts mid-conversation, asking for a priority the owner had already dictated twice; hint text offers date phrases for a priority question | no conversation-turn suppression; mismatched prompt copy | 08-04 19:58 | OPEN |
| **O7** | "Morning, Sir" at 3:30 PM / 5:26 PM / 8:30 AM | prompt gets `getUserLocalDate` (date, no clock) while the persona few-shot opens "Morning, …" | 3+ occurrences | OPEN (`time-of-day-drift`) |
| **O8** | All-day calendar events rendered with a start time ("Office at 5 AM") | all-day events not distinguished in the calendar view | repeated | OPEN |
| **O9** | `whatsapp_messages.error_message` NULL on every failed row | failure reason discarded at the write path | 07-28 | OPEN (observability) |
| **O10** | Alert email dead — `535 Authentication unsuccessful` for basit.ahmed@tmcltd**.com** | SMTP credentials/domain | every boot | OPEN (this is why the 6-day outage went unnoticed) |
| **O11** | Owner's personal WA client down — `[fetchThreadContext] no client in user map, userId 2` | separate `UserWebjsProvider` session not initialised | 07-28 | OPEN |

**Not defects — absent by design:** WhatsApp calling (no foundation; owner excluded it).

---

## 5. Process rules (how this file stays honest)

1. **Every owner-reported issue gets a row in §4 the same session it is reported.** A
   defect that lives only in a chat message is a defect that will be lost.
2. **A defect moves to §3 only when ALL of:** root cause named (not a symptom), fix
   commit linked, executable scenario added in `brainScenarios.ts`, and — for anything
   touching messaging — live acceptance on production. Local tests are never live proof.
3. **Every new archive entry must carry symptom tags from the existing vocabulary.** New
   tags are fine; reusing an existing one is what makes §2 detect recurrence.
4. **Before fixing anything, grep §2 and the archive for the tag.** If it appears already,
   the earlier fix failed to close the class — escalate to a structural fix instead of
   patching the reported instance.
5. **Update §1's counts when §3 or §4 changes.** A stale scoreboard is worse than none.

## 6. Patterns that keep producing defects (builder-side)

Recorded because three of these caused wasted days:

- **A private helper in one consumer.** The `@lid` resolver lived inside
  `inboundActivity.ts`; every module written later reopened the hole. Shared modules, with
  a CI guard naming the single owner.
- **Registry presence mistaken for capability.** `update_open_item` was registry-valid,
  validated, previewed and confirmed — with no dispatcher. Now guarded by
  `DISPATCHABLE_PLAN_STEP_KINDS` pinned to the real `switch`.
- **A migration that silently did nothing.** `DROP CONSTRAINT IF EXISTS <guessed-name>`
  matched nothing, reported success, and the bug survived 74 migrations. Repair migrations
  must match by SHAPE, not name.
- **False-green health.** The liveness probe reported `ok` with `window.require` absent;
  connector status said `connected` while dead, then `degraded` while alive. Health must
  require positive evidence, not absence of a specific error.
- **Diagnosing from theory instead of asking the system.** Three wrong theories on the
  voice bug (unreleased upstream fix, pinned-build rotation, invented module names) cost
  days. The step-probe that replayed the real chain found it in one run.
- **Stale verification numbers.** A suite run BEFORE the last edit was reported as green
  while the tree was red. Re-run after the final change; quote commit-stamped figures.
