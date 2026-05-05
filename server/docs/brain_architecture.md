# Brain — Operations Architecture

> Single source of truth for how Brain operates. The Operations Manual
> wiki page (seeded per tenant), the `/how-it-works` visual page, and any
> future architecture rendering all derive their text from THIS file.
> Update here once; downstream views regenerate.

This document describes the SHAPE of Brain — the same design runs for
every user and every tenant. What differs is the live state each user /
tenant brings (which connectors are on, how many wiki pages, what
overlay rules they've accumulated, etc.). The visual page overlays that
live state on top of this skeleton.

---

## 1. Open Items — what they are

An open item is something Brain is tracking on the user's behalf. Every
open item has a status (NEW → TRIAGED → IN_PROGRESS → DELEGATED /
WAITING_INFO / SNOOZED → INFORMED → CLOSED), a priority (low / medium /
high / critical), an owner, an optional delegatee, and an optional
dueDate. Brain follows up on open items; it does not follow up on raw
email/feed events.

## 2. Quality gate — what becomes an open item

Brain auto-creates open items from connector signals (email, calendar,
WhatsApp, meeting transcripts). Every auto-create runs through a quality
gate before it lands on the user's plate. **Manual items the user
creates by hand bypass the gate.**

**Accept signals (any one passes):**
- Action verb in the title (review / approve / send / decide / draft /
  sign / complete / prepare / schedule / call / reply / handle / etc.)
- Title contains a question mark
- An explicit due date is provided
- Caller-classified archetype is "reply_needed"

**Hard rejects (override accept signals):**
- Intent is FYI / NOISE / INFORMATION
- Confidence below threshold (default 0.65, was 0.35)
- Sender looks like a newsletter or no-reply (no-reply / noreply /
  "view in browser" / "unsubscribe")
- Title is empty or under 4 characters

If rejected, the signal stays in the wiki as a sender history note but
never appears on the Action Center.

## 3. Forwarded emails — handling the inner ask

When someone forwards an email to the user, the actual ask is in the
FORWARDER'S note above the forwarded block, not the original subject.
Brain detects forwards (Fwd:/FW: prefix + forwarded-block delimiter)
and:

- Lifts the forwarder's note as the action signal ("please review" →
  title becomes "Review: <original subject>")
- Records original sender + forwarder + forwarder note in metadata
- The user sees who forwarded, what they wrote, and what was originally
  sent

## 4. Brain → user prompts (WhatsApp queue)

Brain has at most ONE prompt awaiting reply per user at a time. This is
enforced at the database level (partial unique index on
`brain_prompt_queue`). The user sees one question, answers it, then
sees the next.

**Criticality routes the channel:**

- **routine** → WhatsApp text
- **high** → WhatsApp voice note
- **top** → voice call (interrupts the queue, bypasses quiet hours)

**Top priority (voice call) trigger** is narrow on purpose:
priority=critical AND deadline within 24 hours. There's a 30-minute
cooldown — second top within that window comes as a voicenote, not a
second call. The user is never called repeatedly during one incident.

**Quiet hours** are respected for text and voicenote; bypassed only for
voice calls. Configured per user in `notification_preferences`.

**Sequential pacing**: when a prompt is awaiting reply, the next one is
held. If the user goes silent past 48 hours, the prompt auto-skips
(state="expired") and the next prompt dispatches — so a silent user
doesn't deadlock the queue forever.

## 5. Reply parsing — what the user can say

The user replies on WhatsApp with free-form text. Brain parses based on
the prompt's side-effect:

| Side-effect | What user says | What Brain does |
|---|---|---|
| set_due_date | "tomorrow" / "friday" / "next monday" / "in 5 days" / "2026-12-31" | Sets dueDate on the linked open item |
| assign_owner | "Asad Khan" / "asad@tmcltd.com" / "Asad Khan <asad@tmcltd.com>" | Sets delegateeName + delegateeEmail, moves item to DELEGATED |
| free_form_note | any text | Appends a note to the item |
| noop | any text | Records the answer; no item update |

Unparseable date phrases ("no idea, whenever") flag the item with
`metadata.dueDateNeedsClarification` rather than failing — Brain acks
"got it, flagged for clarification" and moves on.

## 6. Producer sweep — what fires the prompts (every 30 min)

Three producer rules find conversational gaps in newly-created
auto-items and enqueue the right prompt:

1. **CRITICAL_DECISION** — priority=critical AND deadline ≤ 24h → top
   criticality (voice call)
2. **DEADLINE_MISSING** — priority IN (high, critical), no dueDate,
   came from a connector → routine criticality, side-effect=set_due_date
3. **OWNER_MISSING** — forwarded item with no delegatee → routine
   criticality, side-effect=assign_owner

Producer is conservative: lookback 60 minutes, 3 prompts per user per
sweep maximum, dedup_key per (item, kind) so a re-run doesn't re-ask,
manual items skipped (sourceFeed IS NULL), low/medium-priority items
skipped.

## 7. Delegatee email loop — going to the assignee directly

When an item is DELEGATED with a delegateeEmail but no dueDate, Brain
emails the delegatee FROM the user's Gmail (CC'd to the user, no MyOS
branding) asking "when can you have this back?". The send captures
Gmail threadId. When the delegatee replies on that thread, the inbound
feed handler matches threadId, validates the sender is the delegatee,
parses the body for a date phrase, updates dueDate, and notifies the
user via WhatsApp:

- Parsed → "Asad confirmed 'Review Q3' by Fri Nov 7. Item updated."
- Unparseable → "Asad replied but I couldn't extract a date. Open the
  item to read."
- Wrong sender (someone else CC'd replied) → ignored, stamp untouched.

Default lookback 24 hours, 5 emails per user per sweep, idempotent via
`metadata.deadlineInquiry` stamp.

## 8. Follow-up worker — chasing stale delegations (hourly)

For DELEGATED items with no movement, Brain nudges the user via the
prompt queue at three tiers:

- **3 days silent** → first nudge ("are they back to you?") — routine
- **7 days silent** → second nudge ("consider escalation") — routine
- **14 days silent** → escalate ("recommend you take it back") — high
  (voicenote)

Each tier fires once. The daysSilent threshold is per-tier;
`metadata.followupTier` records the last tier so the same nudge
doesn't fire daily.

## 9. Smart cleanup — pruning the backlog

The Smart cleanup button on the Open Items page closes:

- Stale items (no activity > 30 days, non-critical priority)
- Duplicates of the same source (same `sourceFeed` + `sourceRef`)

Critical items are NEVER auto-closed. The button shows a preview before
applying so the user can cancel.

## 10. Visibility — user vs tenant scope

Wiki pages have a `scope` column:

- **user** — private to the owning user; only that user's Brain reads
  it (mind_state, sender_history, gap, answer, observation)
- **tenant** — shared across all users with the same `client_number`
  (this manual, FACL org docs, projects, policies, decisions)

Retrieval enforces:
`(scope='tenant' OR (scope='user' AND user_id=$me))`. A user can
never read another user's private pages even if they share a tenant.

When Brain composes an answer, every cited page header carries
`scope="tenant"` or `scope="user"` so the answer can lead with the
right layer (personal threads vs org-wide facts).

## 11. Honest answer rules — what Brain will and won't claim

H1-H13 govern Brain's answers. Most relevant for "what can you do"
questions:

- Brain says what it can ACTUALLY access (via `systemCapabilities`),
  not what the marketing page says
- Brain doesn't claim to "read all emails continuously" — it knows what
  it has scribed
- Brain doesn't deny capabilities that are active
- If a connector is not connected, Brain says so plainly
- When two sources disagree, Brain shows the conflict instead of
  picking silently
- When data is older than 14 days, Brain flags the staleness

## 12. Where the user sees Brain's actions

- **Day Brief** — morning summary of what's on the user's plate today
- **Open Items page** — full Action Center with stats, filters, smart
  cleanup
- **Brain Chat** — free-form conversation, retrieval-augmented from the
  wiki
- **WhatsApp** — proactive prompts (this manual's main subject) +
  critical bundles + emergency calls
- **Email** — outbound delegations + delegatee deadline inquiries
  (Phase 4)

Everything else (rule miner, propagation, embedding, autonomous
executor) is backend; the user doesn't see it directly but its outputs
feed the four surfaces above.

## 13. Self-correction trilogy — how Brain learns from feedback

Three independent loops, all triggered by user 👍 / 👎 in chat or Day
Brief:

### A. In-the-moment retry (turn-level fix)
On 👎 of a chat answer, a synchronous diagnosis runs (Gemini Flash)
that classifies the failure (wrong_person_scope / hallucination /
wrong_tone / etc.). If confidence ≥ 0.6, the UI offers "Try again with
the fix" — Brain re-composes with the diagnosis as steering.

### B. Per-user prompt overlay (composer-level fix)
When the same diagnosis category recurs (≥ 2 high-confidence diagnoses
in 14 days), Brain auto-promotes a permanent rule into the user's
prompt overlay. From then on, every chat answer + draft is composed
with that directive prepended. User can review / edit / disable / reset
on My Rules → Learned Preferences.

### C. Retrieval re-ranker (page-level fix)
Per-(user, page) cumulative feedback. 👍 boosts cited pages; 👎 with
diagnosis category in `wrong_source` / `retrieval_miss` penalises
them. Smoothed score `(pos - neg) / (pos + neg + 5)` capped at ±0.4.
Vector signal stays dominant; feedback steers, doesn't override. Other
diagnosis categories (tone, verbose) DON'T penalise retrieval —
those are composer issues, not retrieval issues.

## 14. The self-rebuild spectrum — what changes itself, what doesn't

Brain modifies its own behaviour at four levels. Higher levels = more
agency, more risk, more user oversight required.

| Level | What changes | Today | Notes |
|---|---|---|---|
| 1. Numeric calibration | thresholds, weights, page boosts | ✅ live | criticality_calibration drift, retrieval_feedback boosts, hits_count |
| 2. Per-user directives | overlay rules from feedback | ✅ live | user_prompt_overlay table, auto-promoted on recurrence |
| 3. Tenant-shared learnings | rules other users in the tenant inherit | ❌ not yet | would require admin review before propagation |
| 4. Architecture amendments | this document grows from observed patterns | ❌ not yet | Brain-proposed amendments to brain_architecture.md, user reviews + approves before merge |
| 5. Code rewriting | Brain modifies its own TS source | 🚫 NEVER | security boundary; goes through git + code review |

Levels 3 and 4 are buildable; level 5 is deliberately off-limits.
**The rule: anything that affects more than one user, or that adds to
this document, requires human approval.** Brain proposes; humans
dispose.

---

_This document is the single source of truth for Brain's behaviour. The
wiki Operations Manual is generated from it on every deploy via
`seedOpsManual.ts`. The `/how-it-works` visual page renders its
diagrams against the same section structure._
