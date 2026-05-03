# MyOS — 6-Layer Architecture

MyOS is a personal executive operating system for Abdul Haseeb (MD, TallyMarks Consulting). It ingests every signal the user receives, keeps an always-compounding knowledge base about people, topics and organizations, and routes decisions through a living reasoning engine that respects standing human intent.

This document describes the six stacked layers, how they talk to each other, and — most importantly — how Brain thinks when a feed event lands or a question arrives.

---

## 1. The six layers at a glance

```
                ┌──────────────────────────────────────┐
        Top  →  │  6.  Instructions                    │   Non-negotiable human orders
                ├──────────────────────────────────────┤
                │  5.  Open Items                      │   Work tracker, derived state
                ├──────────────────────────────────────┤
                │  4.  Action                          │   What Brain does / proposes
                ├──────────────────────────────────────┤
                │  3.  Brain                           │   Living reasoning engine
                ├──────────────────────────────────────┤
                │  2.  Knowledge (Wiki)                │   Compounding memory
                ├──────────────────────────────────────┤
       Base →   │  1.  Feed                            │   Connectors: reality in
                └──────────────────────────────────────┘
```

Reading the stack: **Feed** pulls reality in, **Knowledge** turns it into lasting memory, **Brain** reasons over it, **Action** decides what to do, **Open Items** tracks the work that results, and **Instructions** constrains every layer above — they are the human's standing voice Brain must obey.

---

## 2. Layer 1 — Feed

Every signal the user receives becomes a feed event. A feed event is an immutable row with its original payload plus tenant / user stamping.

### Connectors
- **Gmail** — two-way. Reads threads, drafts, sends replies and forwards.
- **WhatsApp** — read/write via the MD's user WebJS session.
- **Google Calendar** — events, RSVPs, scheduling.
- **Google Tasks** — todos.
- **FACL folder scribe** — pulls entire folders of organizational docs (Google Drive) on a cadence.

### What's stored
`feed_events` — one row per inbound message/event, status ∈ `new | processed | deferred`, plus `senderEmail`, `senderName`, `rawPayload`, `sourceType`, `sourceId`.

### How feed enters the system
Every connector writes into `feed_events` and immediately calls two things:
1. The **scribe pipeline** (layer 2) — convert the payload into wiki memory.
2. The **autonomous executor** (layer 4) — check whether any rule or standing instruction should fire.

Feed never rewrites history. If the sender corrects a value, a new event arrives and the knowledge layer decides which version wins.

---

## 3. Layer 2 — Knowledge (Wiki)

Knowledge is the compounding memory substrate. Everything Brain knows — about people, topics, organizations, past decisions, prior answers — lives here as markdown pages with rich metadata and a vector embedding.

### Page taxonomy
| Kind | Example | Scope |
|---|---|---|
| `email_message` | one inbound email | user |
| `sender_topic` | running thread with a sender on a topic | user |
| `whatsapp_conversation` | WhatsApp chat | user |
| `entity_person` | canonical person across channels | tenant-shared |
| `topic` | subject across many people | tenant-shared |
| `org_doc` | FACL document | tenant-shared |
| `attachment_doc` | parsed attachment | tenant-shared |
| `policy` / `project` / `decision` / `pattern` | organizational context | tenant-shared |
| `observation` | Brain's running awareness | user |
| `mind_state` | one-paragraph "what's happening" | user |
| `answer` | a prior Q&A pair | user |
| `gap` | a known hole in knowledge | user |
| `instruction` | standing order from user | user |
| `meeting_minutes` | a digested meeting — attendees, decisions, commitments, open questions | user |
| `tenant_log` | chronological tail | user |
| `tenant_index` | rollup used by the planner | user |

### Two-tier design (source → concept)
**Source pages** (email_message, whatsapp_conversation, org_doc, attachment_doc) are the raw substrate.

**Concept pages** (entity_person, topic) are synthesized by the `conceptSynthesizerService` — a debounced background worker that reads N source pages about the same entity or topic and re-writes a running summary. Concept pages are preferred in retrieval because one concept summarizes many sources.

### Cross-channel identity
`personIdentityService` keeps one canonical entity across email + WhatsApp + phone. Incoming messages match by email, phone or wa_id; names bridge when the primary key is missing (threshold 0.7). Wiki pages tag their person through `metadata.entityId`, so `getPagesLinkedToEntity` surfaces every email + chat + attachment from the same human.

### Retrieval
`searchWikiByVector` runs pgvector cosine similarity (HNSW index, 768-dim Gemini `text-embedding-004` embeddings). Default search excludes noise page types (`gap`, `tenant_log`, `tenant_index`). Tenant-shared types are visible cross-user; other types stay per-user.

Composer-side ranker adds:
- Concept boost (`entity_person`, `topic` rank above raw sources).
- Temporal bias when the query has "latest/status/current" words.
- Per-entity and per-thread dedupe (max 2 per entity, 2 per thread, 12 total).
- Aggregate boost — when the question looks like a count query, pages with a precomputed `## Computed aggregates` block get +0.25.

### Honesty via metadata
Every opened page carries `last_updated` and `age_days` in its prompt header. Two rules (**H6**, **H7**) force Brain to lead with the newer source when they disagree, and to surface the age when the only available source is stale.

---

## 4. Layer 3 — Brain

Brain is not a single function; it is a living engine with two modes: **reactive** (it answers you) and **continuous** (it keeps thinking even when you're quiet).

### 4a. Reactive: the two-pass query loop

When the user asks Brain a question (via Brain Chat or `POST /brain/ask`):

```
question
   │
   ▼
Pass 1 — plan          brainRetrievalPlanner
   │    (Gemini Flash reads tenant_index + schema + question,
   │     returns JSON plan: which page IDs to open, which
   │     FACL titles to read in full, which entity terms to
   │     look up, the intent — casual/lookup/aggregate/…)
   ▼
Pass 2 — open          openPagesForPlan
   │    Vector search + FACL full-body + thread siblings +
   │    domain expansion + cross-channel pages for any
   │    surfaced entityId. Ranked and trimmed to ≤12 pages.
   ▼
Pass 3 — compose       brainComposer
        (Gemini Pro receives: persona + schema + system
         capabilities + standing instructions + learned
         preferences + tenant log + opened pages, and
         returns {answer, cites, gaps})
```

The compose pass runs under eight honesty rules embedded in the prompt:

- **H1** Only cite opened pages.
- **H2** Enumerate when asked to list.
- **H3** Extract numbers when asked to count.
- **H4** Prefer the Drive Index for tenant counts.
- **H5** If genuinely missing, name the gap.
- **H6** Prefer the most recent source when they disagree.
- **H7** Surface age when data is stale.
- **H8** Standing instructions are non-negotiable.

Side effects after every turn:
- Gaps recorded as `gap` pages.
- Complete answers (no gaps, has citations) filed as `answer` pages for next time.
- One line appended to `tenant_log`.
- `tenant_index` rebuilt lazily (debounced).

### 4b. Continuous: the cognitive engine

`brainCognitiveEngine.runCognitiveTick` fires every 30 minutes (first tick 90s after boot, per-tick cap of 30 users). Six analyzers run in parallel:

| Analyzer | Looks at | Fires when |
|---|---|---|
| `analyzeOpenLoops` | `open_items` | DELEGATED > 3 days |
| `analyzeStaleThreads` | `sender_topic` | last_updated > 5 days, ≥3 interactions |
| `analyzeNewContacts` | `entity_person` | created < 24 h, ≥2 linked sources |
| `analyzeRisingTopics` | `topic` | linkedPageCount ≥ 3 |
| `analyzeFrequencyShift` | feed counts | 7-day rate > 2× 30-day baseline |
| `analyzeInstructionFollowUps` | active instructions + tenant log | dueAt ≤ 24 h, or instruction matched a feed event in last 24 h |

Each analyzer emits zero-or-more `Observation` candidates. The engine ranks by urgency, keeps the top 8, dedupes on title inside a 24 h window, and files them as `observation` wiki pages linked to their anchor pages. It then writes a one-paragraph **mind_state** — "what's happening in the user's world right now" — that lives on Day Brief.

This is how Brain "keeps thinking" while the user is asleep: the next time they open MyOS, the mind state has already digested the intervening hours.

### 4c. Prompt assembly — what Brain sees

Every compose call builds this prompt envelope (top to bottom):

1. **Persona preamble** — who you are addressing, how they prefer to be spoken to.
2. **Brain schema** — the canonical description of page types and honesty rules.
3. **System capabilities** — what connectors are live, what Brain can actually do right now.
4. **Standing instructions (6th layer)** — every active user instruction, rendered as a non-negotiable block.
5. **Learned preferences** — signals from accept/reject/delegate/edit history.
6. **Recent tenant activity** — last 15 lines of `tenant_log`.
7. **Pages opened for this turn** — the ranker's ≤12 pages, each with `last_updated` + `age_days` in its header.
8. **Output rules + honesty rules** — the eight H-rules.

Only after all eight blocks does the user's question arrive. Everything above the question is context Brain has to respect.

---

## 5. Layer 4 — Action

Once Brain has formed a decision, one of three things happens:

| Path | Trigger | Visibility |
|---|---|---|
| **Autonomous** | shadow rule in `ACTIVE` mode matches the event's `dedupHash` | Day Brief → **Brief** section ("what I handled without you") |
| **Suggested** | triage classifier proposes action, MD must confirm | Day Brief → **My Attention** section |
| **Drafted** | draft reply composed and waiting | Day Brief → **Drafts** (inline below attention cards) |

### Autonomous executor flow
```
feed_event lands
   │
   ▼
computeDedupHash(userId, itemType, archetype, senderDomain)
   │
   ▼
lookup ACTIVE shadow_rule for that hash
   │
   ├── found ──► translate user_decision → SuggestedAction
   │             ├── ignore        → mark read + processed
   │             ├── add_open_item → create OpenItem
   │             ├── acknowledge   → mark processed
   │             ├── delegate      → forward via Gmail, log in delegation_logs
   │             └── draft_reply   → (deferred — needs LLM)
   │
   └── not found ──► run instructionMatcher
                     for every active instruction (standing_rule /
                     watchpoint / follow_up / update_request) with
                     a subject, do a case-insensitive substring check
                     against sender / subject / body. If any match,
                     append an `instruction_match` row to tenant_log.
                     (No auto-execute — fuzzy matching is too loose
                     for real delegation. The match surfaces on the
                     next cognitive tick and on Day Brief.)
```

### Draft tone
Draft replies flow through `toneService` which matches the user's historical voice. The user can **Approve**, **Edit**, or **Discard** (renamed from "Reject" for clarity). Every action emits a signal to `preferenceLearnerService`.

---

## 6. Layer 5 — Open Items

Open Items is the work tracker — the one place the user looks to see what's actually in flight.

### Where rows come from
- Feed events the user snoozed → `add_open_item`.
- Delegations → `DELEGATED` status with owner.
- Meetings that need prep → auto-created.
- Instructions that are `todo` kind → surfaced here once scheduled.

### Scoring
`priorityScoreService.scoreOpenItem` assigns `urgency` and `tags`:
- Entity relationship strength (VIP senders push priority up).
- Escalation rules (deadlines, approvals).
- Archetype (`review_risk` > `reply_needed` > `inform_only`).
- Stale days (older items decay or get nudged).

### Lifecycle
`NEW` → `IN_PROGRESS` / `DELEGATED` / `WAITING` → `DONE` / `DROPPED`.

Open items surface on Day Brief's **Open Items** section with Brain's inline suggestion ("Delegate to Asad · 8 prior", "Nudge Fahim — 5 days quiet").

---

## 7. Layer 6 — Instructions

The **6th layer**, sitting on top of the other five. An instruction is an explicit standing order that must be respected across every compose turn, triage decision and cognitive tick.

### Two scopes
| Scope | Visibility | Who can write | Use cases |
|---|---|---|---|
| `client` | every user in the tenant | `SA` / `AD` only | Compliance ("all responses must comply with HIPAA"), brand voice ("never promise pricing without CFO approval"), SLA ("acknowledge client emails within 4 hours"), delegation policy |
| `user` | only the author | the author | Personal preferences, delegation rules, watchpoints, follow-ups |

The composer renders the two as distinct labelled subsections, and the prompt explicitly tells Brain that client rules are organizational policy and override conflicting user preferences when they collide.

### Six kinds
| Kind | Example |
|---|---|
| `standing_rule` | "Always delegate Raazia's emails to Asad" |
| `watchpoint` | "Alert me immediately if anyone mentions EXIM" |
| `follow_up` | "Follow up with Fahim if no reply by Thursday" |
| `scheduled` | "Send me a weekly summary every Friday 5pm" |
| `todo` | "Call Kate next Wednesday" |
| `update_request` | "Update me when Project 846 hits UAT" |

### Storage
Instructions are stored as `wiki_pages` with `pageType='instruction'`. Metadata carries the structured form (`kind`, `subject`, `dueAt`, `condition`, `action`); the body is the natural-language original so Brain can quote it back when citing.

Lifecycle: `active` → `paused` | `fulfilled` | `archived`.

### How they flow through the system
1. **Capture** — UI `Tell Brain what to do…` input on Day Brief posts to `POST /brain/instructions`.
2. **Parse** — `parseInstruction` (Gemini Flash) converts the NL text into a `StructuredInstruction` JSON.
3. **Store** — a new `wiki_pages` row is created with status `active`.
4. **Inject** — every `brainComposer.compose` call fetches the active instructions and renders them as a non-negotiable block at the top of the prompt (above preferences, tenant log and opened pages).
5. **Enforce** — honesty rule **H8** ("standing instructions are non-negotiable") forces Brain to respect them and, when they shape the answer, cite which one applied.
6. **Match against feed** — `instructionMatcher` runs on every inbound feed event without a shadow rule, logging matches into `tenant_log`.
7. **Surface** — the cognitive engine's `analyzeInstructionFollowUps` analyzer promotes due/overdue instructions and recent matches to `observation` pages, which Day Brief renders under "Brain is noticing".

### UI surfaces
- **Instructions section on Day Brief** — inline add, list with kind pills (color-coded), pause/archive controls.
- **Composer-side badge** — Brain can say "per your standing rule to delegate Raazia's emails to Asad, I forwarded this to him" so the user knows which rule shaped the answer.

---

## 8. How Brain works — two end-to-end walkthroughs

### Walkthrough A: user asks "what did Fahim say about SFML?"

```
1. brainAskRoutes.ts   POST /brain/ask
                       validates tenant, calls answerAsBrain()

2. planRetrieval       Gemini Flash reads tenant_index + schema,
                       produces RetrievalPlan:
                         intent = 'factual_lookup'
                         entityTerms = ['Fahim', 'SFML']
                         openPageIds = []      (no specific page named)
                         faclTitles  = []      (no FACL doc named)

3. openPagesForPlan    Vector search on "what did Fahim say about SFML"
                       → top 40 hits, ranker trims to 12 (boost concepts,
                       temporal bias OFF because no "latest" word).

                       "SFML" is detected as a distinctive ALL-CAPS token,
                       so an ILIKE pass grabs any email_message whose body
                       literally contains "SFML" (vector embeddings under-
                       rank short rare codes).

                       Any opened email_message triggers thread-sibling
                       expansion: pull all email_messages sharing the
                       same threadId so Brain sees the full conversation.

                       Any opened page with an entityId triggers cross-
                       channel expansion: pull Fahim's entity_person page,
                       his WhatsApp conversation pages, and any attach-
                       ment he sent.

4. compose             Build prompt:
                        · persona
                        · schema
                        · system capabilities
                        · standing instructions (if any mention SFML or
                          Fahim, they're front-and-center)
                        · learned preferences
                        · tenant log tail
                        · 12 opened pages with age stamps
                        · 8 honesty rules
                       Gemini Pro returns {answer, cites, gaps}.

5. side effects        gaps → recorded
                       complete answer with cites → filed as 'answer' page
                       tenant_log appended "query | what did Fahim say…"
                       tenant_index rebuild debounced

6. UI                  BrainChatPanel renders the answer + cited sources.
```

### Walkthrough B: a new Raazia email lands while the user is asleep

```
1. Gmail poller        new message arrives, feed_event created.

2. scribe pipeline     emailBodyIngestService creates an email_message
                       wiki page (full body, HTML stripped, 40K cap).
                       senderWikiService updates Raazia's sender_topic
                       page. personIdentityService resolves Raazia's
                       canonical entityId. conceptSynthesizerService is
                       notified (debounced 5 min).

3. autonomousExecutor  compute dedupHash for (Raazia, email, reply_needed).
                       No ACTIVE shadow rule matches (she's too varied).

4. instructionMatcher  reads the 3 active instructions; "Always delegate
                       Raazia's emails to Asad" has subject="Raazia".
                       Substring match on senderName → hit.

5. tenant log          append "instruction_match | instruction 'Delegate
                       Raazia's emails to Asad' matched gmail from Raazia
                       … kind=standing_rule matchedOn=sender
                       action=delegate to Asad feedEventId=…"

6. triageSuggester     classifies the event, surfaces it on Attention
                       (no auto-forward yet — fuzzy subject matching
                       would misfire on legitimate exceptions).

7. 30 min later,       analyzeInstructionFollowUps reads the tenant log,
   cognitive tick      sees the recent instruction_match, promotes it
                       to an observation:
                         title: "instruction 'Delegate Raazia's emails
                                to Asad' matched gmail from Raazia"
                         kind: instruction_match
                         urgency: 0.5
                       Filed as observation wiki page.
                       mind_state is re-written incorporating it.

8. morning             user opens Day Brief:
                        · Standing Instructions panel shows the rule.
                        · Brain is noticing section shows the instruc-
                          tion_match observation linking to Raazia's
                          email.
                        · Attention list still has Raazia's email with
                          a one-click "Delegate to Asad" suggestion.
                       User confirms once; rule gets reinforced.
```

---

## 9. Why 6 layers, and why this order

- **Feed without Knowledge** is noise. Raw events without memory mean Brain re-reads the same 500 emails every turn.
- **Knowledge without Brain** is a searchable library. Useful, but the user still does every synthesis.
- **Brain without Action** is a chatbot. It thinks but never does anything.
- **Action without Open Items** loses track of in-flight work. The user has to re-derive state every morning.
- **Open Items without Instructions** makes Brain infer intent from behaviour alone — slow, prone to mismatches, and opaque.
- **Instructions without the five below** is just a notepad.

The stack order is load-bearing:
- **Feed is at the bottom** because everything downstream depends on raw reality.
- **Knowledge sits above it** because memory outlives any single event.
- **Brain reasons on top of memory**, not on raw events.
- **Action is how reasoning exits into the world**.
- **Open Items is derived state** — the accountability trail.
- **Instructions is at the top** because it overrides everything below it.

---

## 10. Key invariants

1. **Tenant isolation is absolute.** Every query scopes by `clientNumber`. Cross-user visibility is allowed only for tenant-shared page types (`org_doc`, `policy`, `project`, `decision`, `pattern`, `attachment_doc`, `entity_person`, `topic`).
2. **Brain never cites a page it didn't open.** Cited IDs must be a subset of the opened set (enforced in `compose`).
3. **Embeddings are idempotent.** Re-scribing the same content (same SHA-256 hash) is a no-op.
4. **Standing instructions are non-negotiable.** Encoded as honesty rule H8 in the compose prompt.
5. **Answer pages are filed only when complete.** A turn that produced `gaps` never becomes an `answer` page, so stale "I don't have it" responses can't poison future retrieval.
6. **Temporal awareness is always in-frame.** Every opened page's header carries `last_updated` and `age_days`.
7. **Fuzzy instruction matches never auto-execute.** They surface to tenant_log and the cognitive engine, never to irreversible actions like forwarding or replying.

---

## 11. Files to read

### Server — core services
- [brainComposer.ts](../server/src/services/knowledge/brainComposer.ts) — the compose pass
- [brainRetrievalPlanner.ts](../server/src/services/knowledge/brainRetrievalPlanner.ts) — the plan pass
- [brainCognitiveEngine.ts](../server/src/services/knowledge/brainCognitiveEngine.ts) — continuous thinking
- [instructionService.ts](../server/src/services/knowledge/instructionService.ts) — layer 6 data
- [instructionMatcher.ts](../server/src/services/knowledge/instructionMatcher.ts) — layer 6 feed hook
- [wikiEmbeddingService.ts](../server/src/services/knowledge/wikiEmbeddingService.ts) — semantic retrieval
- [personIdentityService.ts](../server/src/services/knowledge/personIdentityService.ts) — cross-channel identity
- [conceptSynthesizerService.ts](../server/src/services/knowledge/conceptSynthesizerService.ts) — entity_person + topic pages
- [autonomousExecutor.ts](../server/src/services/triage/autonomousExecutor.ts) — layer 4 execution
- [tenantLogService.ts](../server/src/services/knowledge/tenantLogService.ts) — chronological tail

### Server — routes
- [brainAskRoutes.ts](../server/src/routes/brainAskRoutes.ts) — ask, wiki search, instructions API
- [briefRoutes.ts](../server/src/routes/briefRoutes.ts) — Day Brief data + cognitive tick trigger

### Client — surfaces
- [DayBriefPage.jsx](../client/src/pages/DayBriefPage.jsx) — the home screen
- [WikiPageDetail.jsx](../client/src/pages/WikiPageDetail.jsx) — information web navigation

### Related docs
- [brain_schema.md](brain_schema.md) — the canonical schema text injected into every prompt
- [brain_test_scenarios.md](brain_test_scenarios.md) — living regression log
