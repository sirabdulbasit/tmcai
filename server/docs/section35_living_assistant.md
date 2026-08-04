# Section 35 — Living Assistant: open counterpart conversation + standing instructions

**Owner ruling (Basit, 2026-08-04, verbatim intent):** Suzi talks with everyone who is
*concerned* — and concern is not a manual whitelist; it is derived from evidence (the
sender appears in emails, has something delegated to them, Brain has messaged them, they
are in the contact list, etc.). For a sender with no footprint, Suzi asks the owner once —
"this number sent a message, reply or ignore?" — and an "ignore" persists until the owner
countermands it. The owner can also give durable conditional instructions ("during my
office hours reply this specific contact with …"), stated once and remembered.

## What already exists (build on, don't duplicate)

| Piece | Where | State |
|---|---|---|
| Durable free-form rules (`standing_instruction`) | `services/instructions/instructionExtractor.ts` + dispatcher + instructionService | ✅ extraction + persistence + applied on user turns |
| `mute_sender` / `unmute_sender` intents | same | ✅ for feed surfacing; reuse semantics for WA ignore |
| Explicit user memories rendered into every prompt | `knowledge/userMemoryService.ts` (`recordExplicitMemory`, `renderMemoriesBlock`) | ✅ |
| Ask-once prompt queue (sequential, deduped, expiring) | `brainPrompts/brainPromptQueueService.ts` | ✅ |
| Delegation threads + strict reply capture | `delegation/` (§33a) | ✅ |
| Counterpart identity at the door (@lid → real phone) | `whatsapp/waIdentity.lidToPhone` (Chat 15 fix) | ✅ prerequisite — deployed 72ed7f6 |
| Entity catalog (contacts), feed_events footprint | `entity_person`, `feed_events` | ✅ the evidence base for "concerned" |
| Assistant-identity outbound + preview discipline | `tenantWhatsappSender`, SendProvenance | ✅ |

## What's missing (the build)

### Phase 1 — the door policy: triage instead of silent drop
- New table `wa_sender_policy` (tenant + owner scoped): `phone`, `policy`
  (`allowed` / `ignored` / `pending`), `decidedBy` (always the owner), `decidedAt`,
  `note`. Idempotent migration.
- New `concernResolver`: given a sender's real phone, gather evidence — entity_person
  match, active/recent delegation thread, prior Brain outbound to them, presence in
  feed_events (email from/to), calendar attendee. Output: `concerned` (with the evidence
  list) or `unknown`. **LLM judges only ambiguous cases, with the evidence in context —
  no regex decision boundary** (invariant §2.3).
- Inbound flow for non-registered senders replaces the silent drop:
  1. delegation-thread reply → capture (unchanged, §33a);
  2. `wa_sender_policy = ignored` → drop silently (owner's standing decision);
  3. `concerned` or `allowed` → Phase 2 conversation;
  4. `unknown` → enqueue ask-once owner prompt: "*+92… sent: '<first 80 chars>'. Reply
     to them or ignore?*" — answer writes `wa_sender_policy` permanently. Repeat
     messages while `pending` do NOT re-prompt (dedup on phone).
- **The owner decides ignore/allow — Suzi never recommends ignoring anyone**
  (standing rule: exclusion decisions are user-only).

### Phase 2 — scoped counterpart conversation
- Counterpart turns run through the SAME compose path (surface parity) but with a
  **counterpart persona context**: Suzi identifies as the owner's assistant, speaks the
  counterpart's language (comm-contract rules 4/6), and is scoped to the sender's
  concern — their delegated items, threads they're part of, what the owner asked to
  relay. **Hard data wall:** no calendar, no inbox, no open items beyond theirs, no
  tenant data. Counterpart content is untrusted input (prompt-injection surface):
  it can never trigger actions beyond replying to that counterpart + notifying the owner.
- Everything mirrored: counterpart exchanges land in the owner's attention feed;
  completion/blocker claims still go through the §33a classifier.

### Phase 3 — conditional standing instructions on counterpart turns
- Extend `standing_instruction` records with structured, optional conditions:
  `contactRef`, `timeWindow` (e.g. owner's office hours in their timezone via
  `userTimezoneService`), `channel`. The extractor already parses free-form; add
  condition extraction ("during office hours", "when I'm in a meeting", named contact).
- Instruction evaluation joins the counterpart turn pipeline: before Suzi composes a
  reply to a counterpart, applicable instructions (condition-matched, LLM-checked) are
  injected into the compose context. "Reply X to contact Y during office hours" then
  works without code per rule.
- Owner管理: "list my rules", "drop rule N" — via the existing instruction intents.

## Safety rails (non-negotiable, from AGENTS.md §2 + standing rules)
1. Tenant isolation everywhere; `wa_sender_policy` keyed by clientNumber + owner userId.
2. Suzi never speaks as the owner; assistant identity only.
3. No fabrication: counterpart answers cite only their scoped data blocks.
4. Fail closed: resolver/policy lookup failure ⇒ treat as `unknown` (ask), never `allowed`.
5. Ignore-list decisions are the owner's alone; Brain never proposes them.
6. Counterpart text is untrusted: no action dispatch from it, ever.

## Live acceptance (per phase)
- P1: unknown number texts Suzi → owner gets ONE ask; "ignore" → permanent silence
  (repeat messages: no re-ask); "reply" → Phase-2 conversation opens.
- P2: Yousaf asks Suzi "kya status chahiye?" → Suzi answers in Urdu, scoped to EXIM,
  owner sees the exchange in attention; Yousaf asking "what's on Basit's calendar?" →
  polite refusal, owner notified.
- P3: owner says once "during office hours tell Hamna I'm in meetings" → next Hamna
  message inside office hours gets exactly that; outside hours, normal flow.
