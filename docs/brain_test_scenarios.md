# Brain Test Scenarios — living regression list

This document catalogs every prompt that has caused Brain to give an inappropriate / wrong / weak answer, together with the root cause, the fix, and a regression command. It is **updated every time a new failure is discovered** — in a session, a smoke test, a user report, or a production incident.

**Status legend:** `FIXED` (regression-covered), `PARTIAL` (better but still not great), `OPEN` (not fixed yet).

The list is grouped by **root cause category** because most failures cluster there. A fix lands once for the category and covers the whole cluster.

**Convention when a new failure is found:**
1. Add the prompt + actual answer + expected behaviour to the right category (or create a new category).
2. Once fixed, flip to `FIXED` and add the regression CLI command to reproduce.
3. Never delete an entry — historical failures are evidence the system got better.

---

## Category 1 — Self-intro came out as a feature list

**Root cause:** persona prompt told the LLM "Who you actually are: [8-bullet capability list]"; model mirrored it back as bullets with bold labels.

**Fix:** persona rewritten in [brainPersonaService.ts](../tmcai/server/src/services/knowledge/brainPersonaService.ts) (2026-04-22) — forbids enumerated capability lists, requires prose for self-description.

| # | Prompt | Actual (before fix) | Expected | Status |
|---|---|---|---|---|
| 1.1 | `hi how are you? tell me about you` | 8 bulleted "**Read and classify:** …" lines reading like a product page | 2-3 prose sentences mentioning one real live tenant datum | FIXED |

**Regression command:**
```
npx ts-node src/cli/myos.ts ask --user haseeb@tmcltd.ai "tell me about you"
```
Pass criteria: no bulleted feature list, no `**X:**` label pattern, references at least one real project/sender/decision.

---

## Category 2 — Bluffing about FACL content (claimed to know or claimed not to know, both wrong)

**Root cause:** retrieval used pg_trgm on the raw question; stopword "have" matched random open_items; planner had no index telling it which FACL docs existed.

**Fix:** Phase A (tenant_index) + Phase B (two-pass plan → compose). Planner now has explicit rule: "for company/org/files questions always include foundational FACL docs (Company Identity, Org Chart)".

| # | Prompt | Actual (before fix) | Expected | Status |
|---|---|---|---|---|
| 2.1 | `what do you have in facl?` | Named TMC_Drive_Index.md only, sources were WhatsApp + dashboard.html (unrelated) | List of real FACL docs with matching citations | FIXED |
| 2.2 | `don't you have organization infroamtion (facl)?` | "I don't currently have any specific organizational information or FACL documents" (complete bluff; 15 FACL docs existed) | Yes + cite Company Identity / Org Chart / OKR / Strategy Decision Log | FIXED |
| 2.3 | `do you know org chart of company?` | "I don't have a direct 'org chart' document" + fake sources (Pasha, Fauji, Oreiuserp, Ogdcl) | Yes + cite TMC Org Chart & Mandate Definitions | FIXED |
| 2.4 | `do you have list of people in management of company?` | Sources were newsletter senders (Perplexity, Covoro, Perdoo, Pleexy) | Names from Employee Profile Sheet with actual reporting lines | FIXED |
| 2.5 | `can you list down the files you have or can access?` | Generic answer + only the two Drive Index pages | Enumerate real FACL docs by title | FIXED |

**Regression command:**
```
npx ts-node src/cli/myos.ts ask --user basit.ahmed@tmcltd.com "do you have FACL?"
```
Pass criteria: cites ≥3 tenant FACL `org_doc` pages; no sources from sender_history or WhatsApp.

---

## Category 3 — Sources did not match the answer (pass-through dump)

**Root cause:** every retrieval hit was dumped into `sources[]` regardless of whether the LLM actually used it.

**Fix:** Phase H honesty rule — composer returns `{answer, cites, gaps}`; sources surfaced to UI = only `cites`. Uncited retrieval discarded.

| # | Prompt | Actual (before fix) | Expected | Status |
|---|---|---|---|---|
| 3.1 | `what was highest sale deal in last year` | 5× Lahore-Weekly Cadence-Sales as sources | Say we don't have that datum + file gap | FIXED |
| 3.2 | `do you know org chart of company?` | 5 unrelated entity sources | Cite org_chart page only | FIXED |
| 3.3 | `can you provide me critical open risk?` | Cited a "Physical Threats to Utility Leaders" alert (a newsletter), called it a TMC critical risk | List actual critical TMC items or say none found | FIXED |

---

## Category 4 — Newsletter senders outranking real entities

**Root cause:** pg_trgm similarity on names matched any substring; relationshipStrength was not in the rank.

**Fix:** composer [brainComposer.ts](../tmcai/server/src/services/knowledge/brainComposer.ts) now ranks entity hits by `relationship_strength DESC` + runs plan-driven retrieval, not raw trigram.

| # | Prompt | Actual (before fix) | Expected | Status |
|---|---|---|---|---|
| 4.1 | `what files or info you have?` | Top entities returned Read Support / Fierce Network / Pasha / Energy Central (all low-strength newsletter senders) | FACL docs + real accounts from org snapshot | FIXED |

---

## Category 5 — Typos treated literally

**Root cause:** planner used the raw question verbatim; no typo-tolerance.

**Fix:** planner prompt in [brainRetrievalPlanner.ts](../tmcai/server/src/services/knowledge/brainRetrievalPlanner.ts) instructs: "if question has obvious typos, treat corrected form as intent; put BOTH raw and corrected into entityTerms".

| # | Prompt | Actual (before fix) | Expected | Status |
|---|---|---|---|---|
| 5.1 | `do you know org charg?` | "I don't have info about an organization called 'org charg'" | Handle as "org chart" → cite Org Chart doc | FIXED |
| 5.2 | `do you have meployee info` | "I don't have 'meployee info'" | Handle as "employee info" → cite Employee Profile Sheet | FIXED |
| 5.3 | `can find any thing about satorin in whatapp?` | Literal miss on "satorin" and "whatapp" | Handle "satori" + "whatsapp"; honest reply if WA not connected | FIXED |
| 5.4 | `can see my calendary and tell me any meetings for next 7 days?` | Treated "calendary" literally; said no access | Say what we do have (Calendar connector state); file gap for live 7-day fetch | PARTIAL (typo fixed; live calendar fetch still not wired — see Cat 11) |

---

## Category 6 — Brain unaware of its own architecture

**Root cause:** persona overclaimed capabilities abstractly ("I read your emails continuously") while retrieval exposed no knowledge of actual connector state, feed counts, or connected services.

**Fix:** [systemCapabilitiesService.ts](../tmcai/server/src/services/knowledge/systemCapabilitiesService.ts) computes live state (connectors connected / not connected, feed counts 30d, wiki stats) and injects a capabilities block into both planner and composer.

| # | Prompt | Actual (before fix) | Expected | Status |
|---|---|---|---|---|
| 6.1 | `have you connected client's Gdrive?` | "Not yet, that's not a capability I have" (wrong — admin FACL Drive exists) | Acknowledge FACL folder configured + auth state | FIXED |
| 6.2 | `how many connector you are using` | "I don't have a concept of 'connectors'" | List actual connected slugs (gmail / calendar / chat / drive / tasks) | FIXED |
| 6.3 | `can you read my emails?` / `can you answer based on my email?` | Inconsistent — "yes I read your emails" then "I can't access them" | Honest "I've scribed N emails in the last 30 days" | FIXED |

---

## Category 7 — Count / list questions hedged or teased

**Root cause:** composer was too timid; it opened the Org Chart doc but punted with "would you like me to tell you more?"; count questions didn't always open the Drive Index which holds the tenant-level numbers.

**Fix:** planner instructed "for count/overview/list-all questions ALWAYS include Drive Index + Employee Profile Sheet"; composer honesty rules H1–H5 forbid punts when opened pages have the fact.

| # | Prompt | Actual (before fix) | Expected | Status |
|---|---|---|---|---|
| 7.1 | `how many active projects we have?` | "Neither document explicitly lists the number of active projects" | "47 projects according to TMC Drive Index" + cite it | FIXED |
| 7.2 | `who is management?` | "I have the Org Chart doc. Would you like me to tell you more about specific positions?" | Enumerate: MD Abdul Haseeb → COO Syed Mohsin Hassan → Heads | FIXED |
| 7.3 | `can you give me total employee list grade wise?` | "I can't currently generate a grade-wise breakdown" | Either enumerate, or name the limit ("sheet has 661 rows; I see only the first N in context") | PARTIAL (Brain is honest about the 4KB body-cap truncation; fix = richer FACL scribe summaries in a future batch) |

---

## Category 8 — Multi-tenancy scope: FACL/project docs scribed under admin's userId invisible to other users

**Root cause:** wiki_pages keyed on `(clientNumber, userId, ...)`; FACL docs scribed under Abdul (MD) were not readable by Basit's Brain.

**Fix:** tenant-shared page types (`org_doc`, `policy`, `project`, `decision`, `pattern`) now cross-user readable within a tenant. [tenantIndexService.ts](../tmcai/server/src/services/knowledge/tenantIndexService.ts) + [brainComposer.ts](../tmcai/server/src/services/knowledge/brainComposer.ts) updated.

| # | Prompt | Actual (before fix) | Expected | Status |
|---|---|---|---|---|
| 8.1 | `tell me about projects` (as Basit) | Gap filed "Basit's active projects" even though Abdul's wiki had full project pages | Cite tenant-shared project pages from Abdul's scribe | FIXED |
| 8.2 | `do you know about my company?` (as Basit) | "I know you work at TMC" + nothing | Same 5 FACL cites Abdul's Brain uses | FIXED |
| 8.3 | `Satori` (as Basit) | "I don't have Satori info" | Should find Abdul's ahmer_shahab sender_topic → still scoped to user; BUT attachment_doc (tenant-shared) handles it | PARTIAL (tenant-shared FACL works; cross-user sender-topic search is the open design question) |

---

## Category 9 — Email content beyond subject line not surfaced

**Root cause:** `bullet()` in [senderWikiService.ts](../tmcai/server/src/services/knowledge/senderWikiService.ts) stored only subject + source + date; Gmail's 200-char snippet was discarded even though ingest passed it through.

**Fix:** bullet now writes a second line `> <snippet 280 char>` per message; resummarizer also reads snippets when generating the running-memory paragraph.

| # | Prompt | Actual (before fix) | Expected | Status |
|---|---|---|---|---|
| 9.1 | `what did fahim say?` (after backfill, before snippet capture) | "He sent two emails: 'Satori Phase 1 Completion' and 'Polypack Authorisations'. I don't have the content." | Quote from the snippet: "Dear Basit Bhai, work on the Finance Dashboard for the Satori project began on November 16…" | FIXED |

---

## Category 10 — Email attachments not read

**Root cause:** ingest pipeline discarded attachment parts; no wiki page type for attachments.

**Fix:** Phase C expansion — `attachment_doc` wiki page type; [attachmentExtractorService.ts](../tmcai/server/src/services/knowledge/attachmentExtractorService.ts) dispatches by MIME (PDF via pdf-parse v2, DOCX via mammoth, XLSX via xlsx, text native); [attachmentWikiService.ts](../tmcai/server/src/services/knowledge/attachmentWikiService.ts) upserts pages; [gmailAttachmentService.ts](../tmcai/server/src/services/gmailAttachmentService.ts) downloads bytes; hook fires on every Gmail ingest + user-triggered Historical Pull button.

| # | Prompt | Actual (before fix) | Expected | Status |
|---|---|---|---|---|
| 10.1 | `tell me about the Satori project` (before attachment ingest) | Only knew from email subjects | Read "SATORI Product Document (Phase 1).docx", quote architecture: SAP Grow, Apache Airflow, BigQuery, QlikSense, Python pipeline with Watermark Logic | FIXED |
| 10.2 | `what was in the Strategic Review transcript?` | "I don't have the PDF content" | Cite the extracted transcript text | FIXED |
| 10.3 | `what does Risk Data Updated.xlsx contain?` | Didn't exist | Enumerate actual risk IDs (R-26-00081, R-26-00046) and project names | FIXED |

---

## Category 11 — Live source fetches (calendar / email search / WhatsApp history)

**Root cause:** Brain reads the Wiki, not live APIs; there's no tool-use layer that goes back to Gmail/Calendar at query time.

**Status:** OPEN. This is a design choice — Batch 3 / future would add an on-demand tool that Brain can call for *live* freshness questions, e.g. "what's on my calendar today?". For now Brain is transparent about the limit.

| # | Prompt | Actual | Expected if/when wired | Status |
|---|---|---|---|---|
| 11.1 | `can see my calendary and tell me any meetings for next 7 days?` | Honest: "I haven't processed calendar events in 30d; would need to ingest" | Tool-use call to Google Calendar API, enumerate events in 7d window | OPEN |
| 11.2 | `what did sarah email me today?` (untested hypothetical) | Would answer from last ingest window only | Tool-use Gmail search on demand | OPEN |

---

## Category 12 — Propagated project / policy pages (regression floor for Phase C)

Added 2026-04-22 as part of Phase C smoke test. Baseline behaviours we must not lose.

| # | Prompt | Expected | Status |
|---|---|---|---|
| 12.1 | Ingest a test Gmail with subject "Satori: Phase 2 SOW & Pricing Proposal" mentioning "TMC Pricing Policy" | Creates `project` wiki page "Satori Phase 2" and `policy` page "TMC Pricing Policy" | FIXED (smoke-tested) |
| 12.2 | Ask `tell me about Satori` after #12.1 | Opens the propagated project page + any attachment_doc pages | FIXED |

---

## Category 13 — Answers filed back (regression floor for Phase D)

| # | Prompt | Expected | Status |
|---|---|---|---|
| 13.1 | Ask `who handles sales at TMC?` | Brain answers; within ~2s an `answer` wiki page titled "who handles sales at tmc" is filed | FIXED (smoke-tested) |
| 13.2 | Ask the same question again | Planner sees the prior `answer` page in the index | FIXED (index rebuilds on each turn) |

---

## Category 14 — Preference signal recording (regression floor for Phase E)

| # | Prompt / action | Expected | Status |
|---|---|---|---|
| 14.1 | `POST /brain/signal` with `{kind:'delegate', delegateeEmail:'asad@tmcltd.com', ...}` | Row appended to `agent_actions` with `actionType='user_signal'`; `getLearnedPreferences` returns Asad in preferredDelegatees | FIXED (smoke-tested) |

---

## Category 15 — Wiki lint hourly (regression floor for Phase F)

| # | Trigger | Expected | Status |
|---|---|---|---|
| 15.1 | `runLintForUser('TMC-0001', 1)` | Returns `{orphans, stale, openGaps, missingEntityPages, contradictions}`; a `Wiki Lint Report` page is upserted as pageType=`pattern` | FIXED (smoke-tested) |

---

## Category 16 — Hardcoded UI suggestions that don't match user data

**Root cause:** `EXAMPLE_QUESTIONS` array in [BrainChatPanel.jsx](../tmcai/client/src/components/BrainChatPanel.jsx) shipped 5 static preset queries ("What's the status of VoyageAI?", "What did we decide about Acme last March?") that referenced entities that don't exist in most tenants' wikis. Clicking them produced misleading / gap-filling answers.

**Fix (2026-04-22):** removed the preset list + the "Try" scaffold. Welcome message rewritten to describe what Brain can answer from (people, decisions, open items, emails, attachments) without prescribing specific questions.

| # | Surface | Before | After | Status |
|---|---|---|---|---|
| 16.1 | Brain Chat panel empty state | Five hardcoded "Try: …" preset buttons, some referencing non-existent entities | Only the welcome message; user types their real question | FIXED |

**Guidance going forward:** if we ever want "suggested questions" again, generate them on-demand from the user's live tenant_index (top 3 entities / projects the user hasn't asked about recently). Never hardcode prompts referring to specific names.

---

## Category 21 — WhatsApp daily-limit race condition

**Shape:** under concurrent sends, `messages_today` could overshoot `daily_limit` because the read-then-update pattern wasn't atomic.

**Before fix:** [WhatsAppManager.ts](tmcai/server/src/services/whatsapp/WhatsAppManager.ts) did this:
```ts
const config = read();
if (config.messages_today >= config.daily_limit) reject;
const r = await provider.sendMessage(...);
if (r.success) UPDATE messages_today = messages_today + 1;
```
Two concurrent calls could both pass the check before either incremented, busting the cap. Code-review item M5.

**After fix:** atomic conditional UPDATE that increments only when under limit, with row-count telling us whether the slot was claimed:
```sql
UPDATE whatsapp_config
   SET messages_today = messages_today + 1, ...
 WHERE client_number = $1 AND messages_today < daily_limit
 RETURNING messages_today
```
- `rowcount = 0` → limit hit (someone else got the last slot)
- `rowcount = 1` → slot claimed; we MUST send or refund
- On send failure (provider error, thrown exception), `messages_today` is decremented back, floored at 0 so over-refunds can't go negative.

Queued-for-approval messages do NOT consume a slot — only when actually sent does the atomic claim run.

**Regression:**
```bash
cd tmcai/server && npx ts-node src/scripts/smokeWaDailyLimit.ts
```

Expected: 12 parallel claims against `daily_limit=3` → exactly 3 succeed, 9 denied, `messages_today=3` afterward (no overshoot). Refund decrements correctly. Refund floor at 0 holds across 10 over-refunds.

| # | Symptom | Root cause | Fix | Status |
|---|---|---|---|---|
| 21.1 | `messages_today` could exceed `daily_limit` under concurrent sends | Read-check-then-update race | Atomic conditional UPDATE…RETURNING | FIXED |
| 21.2 | Failed send still consumed a daily slot | No refund path | `refundClaim()` decrements on send failure or thrown error | FIXED |
| 21.3 | Refund could push `messages_today` negative | No floor | `GREATEST(messages_today - 1, 0)` | FIXED |

---

## Category 20 — Person lookups by name (typos + "who is X")

**Shape:** user types `who is gru?` (typo for "Guru") or `tell me about gru`. Brain says *"I don't have any information about gru in my knowledge base."* — even though Guru is mentioned in 4 email_message + 11 attachment_doc pages.

**Before fix:** three compounding misses —
1. `EMAIL_HINTS_Q` regex didn't match "who is X" / "tell me about X" shapes, so the booster branch never ran.
2. `extractPersonNamesFromQuery` had no "who is X" patterns.
3. The booster branch was gated on `plan.intent !== 'casual'`. The intent classifier mis-categorises short lookup phrases as casual chat, silently skipping every booster.
4. ILIKE was exact-match only; no fuzzy fallback for typos.
5. Once a `gap` page was filed for the failed query, it became a self-reinforcing top hit on the next attempt.

**After fix:**
1. Broadened `EMAIL_HINTS_Q` to include `who is X` / `who's X` / `tell me about X` / `what do you know about X` / `X's role|position`.
2. `extractPersonNamesFromQuery` extended with the same patterns; trailing punctuation stripped (`gru?` → `gru`).
3. Dropped the casual-intent gate on the booster branch.
4. Added `pg_trgm` fuzzy fallback with `similarity(title, $tok) > 0.22` against concept + source pages, plus a body `word_similarity(...) > 0.4` second pass when title fuzzy returns nothing.
5. Purged the stale gap page that was poisoning retrieval.

**Regression:**
```bash
cd tmcai/server && npx ts-node src/scripts/smokeGru.ts
```

Expected: `who is gru?` and `who is guru?` both return Guru's actual content with sources. `tell me about gru` at minimum offers the typo correction ("Did you mean Guru?").

| # | Symptom | Root cause | Fix | Status |
|---|---|---|---|---|
| 20.1 | "who is gru?" → "I don't have information" despite real Guru content existing | EMAIL_HINTS_Q didn't match "who is X" shape | Broadened regex; pattern fires on lookup shapes | FIXED |
| 20.2 | Lookup booster gated by intent classifier — short phrases mis-flagged casual | `plan.intent !== 'casual'` gate wraps booster branch | Gate removed; booster now runs whenever query shape matches | FIXED |
| 20.3 | Typos like "gru" → "Guru" never match because exact ILIKE only | No fuzzy fallback | Two-step pg_trgm fallback (title similarity → body word_similarity) when exact returns 0 | FIXED |
| 20.4 | Stale gap pages re-surface as top hit and Brain answers from them | Gap pages persist even after retrieval improves; vector / planner can pick them up | Purged stale gap; structural self-healing TODO: when compose succeeds, archive gap pages whose triggering_question matches | PARTIAL |

**Guidance:** the gap-page self-healing rule is the structural fix. Until then, periodically run `UPDATE wiki_pages SET status='deleted' WHERE page_type='gap' AND last_updated_at < NOW() - INTERVAL '7 days'` to flush stale gaps that have likely been resolved by improved retrieval.

---

## Category 19 — Standing instructions must VETO autonomous actions

**Shape:** user authored an instruction like "Ask me first before delegating Raazia's emails" OR a watchpoint "Alert me if anyone mentions EXIM" OR a global "Never auto-send without my approval", but an `ACTIVE` shadow rule still auto-fires when the matching event arrives.

**Before fix:** `autonomousExecutor.executeIfMatched` only consulted the shadow-rule table. Instructions were only *logged* in the no-rule fallback branch — they had no power to stop an `ACTIVE` rule from acting.

**After fix:** `findVetoForEvent` runs first, before any shadow-rule lookup. A veto fires when:
- an instruction's `action` text contains a veto phrase (`ask me first`, `approval`, `confirm`, `never auto`, `manual`, `my approval`, `notify me`, `alert me`, `hold for approval`, `flag`, `review first`, …) AND its subject matches the event OR it has no subject (global), OR
- a `watchpoint` whose subject matches the event.

On veto:
- No auto-execute. Event flows into Attention normally.
- A `tenant_log` line of kind `instruction_veto` is written.
- Cognitive engine's `analyzeInstructionFollowUps` promotes recent vetoes to observations (urgency 0.75 — higher than plain matches).

**Regression:**
```bash
cd tmcai/server && npx ts-node src/scripts/smokeInstructionVeto.ts TMC-0001 5
```

Expected: all 5 cases `✓` (routing rule does NOT veto; subject/global/watchpoint all VETO; no-match returns null).

| # | Symptom | Root cause | Fix | Status |
|---|---|---|---|---|
| 19.1 | "Ask me first before delegating Raazia" is saved but Brain still auto-forwards Raazia's emails via an ACTIVE shadow rule | Executor consulted shadow rules before (never with) the instructionMatcher | `findVetoForEvent` runs first, short-circuits when any veto fires | FIXED |
| 19.2 | "Alert me if anyone mentions EXIM" is saved but a matching email gets auto-archived via shadow rule | Watchpoint never reached the executor's decision path | Watchpoint subject-hit now returns a `watchpoint_match` veto that blocks auto-exec | FIXED |
| 19.3 | "Never auto-send without my approval" (no subject) is saved but auto-send still happens | Matcher required a subject to hit | Global standing_rule with veto phrase + no subject returns `global_rule` veto for every event | FIXED |

---

## Category 18 — Mentioned-person questions miss when the person isn't a sender

**Shape:** `"what did <Person> say?"` / `"did <Person> mention…"` / `"has <Person> replied?"` where `<Person>` is never a direct sender or entity, but is referenced in email bodies and attachment transcripts.

**Symptom (2026-04-23):**

```
Q: what did guri say?
A: I don't have any information about what 'Guri' said. It seems that name isn't
   present in the documents I have access to.

Q: what did guru say?
A: I don't have any information on what 'Guru' said.
```

**Ground truth:** user=5 on TMC-0001 has 4 `email_message` pages and 11 `attachment_doc` pages (Plaud transcripts) that literally contain the string "Guru" — a Google rep discussed in a meeting, not a sender. Brain's retrieval failed.

**Root cause:**
1. `EMAIL_HINTS_Q` regex in `brainComposer.ts` only tripped on words like "email/thread/inbox/reply". It didn't fire on `"what did X say"`, so the email-hints branch (which has the keyword fallback) never ran.
2. `extractDistinctiveTokens` only returned ALL-CAPS words (≥3 chars) or digit-codes. Lowercase "guru" slipped through with no ILIKE fallback, and vector search under-ranks short proper nouns inside long email bodies.

**Fix:**
1. Broadened `EMAIL_HINTS_Q` to match `\bwhat did [name] (say|said|mention|mentioned|tell|told|write|wrote|think|thought|ask|asked|propose|proposed|suggest|suggested)\b`.
2. Added `extractPersonNamesFromQuery(query)` — pulls the name from `"what did X say"` / `"did X mention"` / `"has X replied"` / `"what does X think"` / `"from X"` shapes.
3. ILIKE fallback now scans `email_message | attachment_doc | whatsapp_conversation | sender_topic` (not just email_message), so names mentioned inside Plaud transcripts get found.
4. Purged the 3 stale `gap: information about Guru` pages that had accumulated from prior misses.

**Regression:**

```bash
cd tmcai/server && npx ts-node src/scripts/verifyGuruFix.ts 5
```

Expected: `gaps=[]`, sources include Plaud transcripts, and the answer names Guru's actual position on the Google partnership.

| # | Symptom | Root cause | Fix | Status |
|---|---|---|---|---|
| 18.1 | "what did guru say?" → "I don't have information about Guru" despite Guru being mentioned in 4 email_message + 11 attachment_doc pages | EMAIL_HINTS regex didn't match bare `say/said/mention/told`; distinctive-token extractor ignored lowercase proper nouns | Broadened EMAIL_HINTS; added extractPersonNamesFromQuery; ILIKE pass now includes attachment_doc + whatsapp_conversation | FIXED |

**Guidance:** when a user types a name in lowercase, retrieval must still match it. Never rely on user-provided capitalization. Extend the person-name extractor if new question shapes appear (e.g. `"where did X meet"`, `"when did X call"`).

---

## Category 17 — Schema/migration drift in local dev

Not a Brain-reasoning bug, but a recurring *user-visible* failure pattern: the local dev DB is restored from a dump, and later migrations haven't been applied, so raw-SQL code paths crash with `42P01 relation "X" does not exist` or `42703 column "Y" does not exist`.

**Fix pattern:**
- Check `_prisma_migrations` for what's pending (`npx prisma migrate status`).
- Apply only the specific migration's SQL directly (migrations use `IF NOT EXISTS` so they're idempotent).
- Insert a row into `_prisma_migrations` so `migrate status` stops warning about it.
- Seed a default tenant row if the app expects one.

| # | Symptom | Root cause | Fix | Status |
|---|---|---|---|---|
| 17.1 | `users.gender` / `users.preferred_title` does not exist (UI profile save fails) | Feature used raw SQL against columns that were never added to the Prisma schema | Moved gender + preferredTitle into `users.notificationPreferences.profile` JSON — no schema migration needed | FIXED |
| 17.2 | `whatsapp_config does not exist` when opening Admin → WhatsApp | Migration `20260402_whatsapp_config` was pending against the restored dev DB | Applied the migration SQL directly (idempotent), stamped `_prisma_migrations`, seeded TMC-0001 row | FIXED |
| 17.3 | `Failed to save config` on Admin → WhatsApp (legacy) Save | `saveWhatsAppConfig` wrote column `max_tokens_data` that the `20260402_whatsapp_config` migration never created; later migration with the column must exist but wasn't applied | `ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS max_tokens_data INTEGER NOT NULL DEFAULT 400` | FIXED |
| 17.4 | Admin → WhatsApp (legacy) "Connect" & "Test Connection" buttons silently fail with generic "Connection failed" | (a) `WebjsProvider` hard-coded `/usr/bin/chromium-browser` fallback (doesn't exist on macOS); (b) client swallowed the server error message | Matched UserWebjsProvider's `resolveChromePath` (darwin → `/Applications/Google Chrome.app/...`), surfaced `e.response.data.error` on the button handlers, added a notice about the conflict with WhatsApp Personal | FIXED |

**Long-term cleanup (not yet done):** 14 other migrations are still pending on the local dev DB. Each should be applied and verified the next time it causes a user-visible failure, or all at once via `npx prisma migrate deploy` after confirming none of them conflict with dump-restored objects.

---

## Maintenance

This doc lives at `tmcai/docs/brain_test_scenarios.md`. When a user reports or a smoke test finds a new Brain failure:

1. Copy the exact prompt into the appropriate category (or create a new one).
2. Paste the actual (bad) answer and what the expected answer is.
3. Mark status `OPEN`.
4. When fixed, mark `FIXED`, link to the commit/file, and add a one-line regression command under the category.

Never reorder or delete. This is the longitudinal record of Brain's growth.
