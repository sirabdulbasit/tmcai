# MyOS Brain — Required Specification (LLM Wiki Pattern)

**Author's note:** This document specifies a Memex-style knowledge layer that extends MyOS. The pattern it encodes is Andrej Karpathy's "LLM Wiki" (public gist, 2026). The full original text is reproduced verbatim in Appendix A. Everything else in this document maps the pattern to TallyMarks' context, the existing MyOS architecture, and the concrete delta to close.

**Product name:** The product is **MyOS**. Original requirement documents (kept in `reference/`) may still use other names — those files are source material and are left untouched. All planning, implementation, documentation, code, database migrations, and git branches use "MyOS" only.

**Deployment model:** MyOS is a **multi-tenant SaaS**. Every connector (Notion, Gmail, Slack, Drive, CRM, WhatsApp, GCal, and future sources) is **per-user** — each user brings their own OAuth credentials, their own workspace. Brain ingests from every connector that a user has connected into that user's personal wiki. Tenant-level config exists for organisational defaults and cross-user policies only.

**Architectural rule:** This work does **not** introduce a new layer. The wiki/memex pattern is folded into the existing L1-L5 structure. See § 6 for exact placement per layer.

**Status:** Design specification, not yet implemented.
**Scope:** Brain upgrade from "ADK orchestrator + raw RAG" to "ADK orchestrator + compounding per-user wiki".
**Out of scope:** Git backup of wiki pages is explicitly excluded from this build.
**Estimated effort:** 1 – 1.5 engineering weeks for the full build; 2-3 days for a reduced first-pass proof.

---

## 1. Executive summary

MyOS currently processes feed events one at a time and derives answers from raw data on every query. The knowledge never compounds. Ask the same question twice about the same customer and the Brain starts from zero both times.

Karpathy's LLM Wiki pattern fixes this by introducing a **persistent, LLM-maintained knowledge base** that sits between the raw sources and the query layer. The LLM updates the wiki on every ingest — new entity pages, revised concept summaries, cross-references, flagged contradictions. Every subsequent query benefits from the accumulated synthesis, not just the raw bytes.

Integrating the pattern into MyOS requires adding:
- A wiki maintenance agent (`wiki_scribe`) — new 7th worker under the existing Brain Orchestrator
- A schema document that tells the Brain how to maintain each user's wiki
- Ingest / query / lint operations wired into existing L1-L5 triggers (no new layer)
- Per-user index and chronicle pages maintained inside each user's own Notion workspace
- A per-user connector model for Notion, extending the same `user_connectors` pattern already used for Gmail/Slack/GCal

The storage substrate exists in two forms:
- The v4.1 install's seven Notion databases (Entity, Concept, Decision, Pattern, Meeting, Project, plus five pipeline DBs) belong to Abdul's personal Notion workspace and serve as his user-level wiki.
- Every new user onboarded to MyOS connects their own Notion workspace; MyOS auto-provisions the same seven DBs under a root page the user chooses. If the user has no Notion account, we fall back to storing the wiki in Postgres as markdown (see § 6.3).

---

## 2. The core idea (Karpathy, restated)

Most LLM-plus-document systems work like RAG:

```
user query
   ↓
embeddings index of raw documents
   ↓
retrieve top-k chunks
   ↓
LLM generates answer from chunks
```

Every query starts from scratch. The LLM rediscovers knowledge, resynthesizes connections, and forgets everything the moment the chat window closes.

The LLM Wiki pattern works like this:

```
raw sources  (immutable — Gmail, Slack, CRM, Drive, Calendar, WhatsApp)
   ↓  ingest
wiki  (LLM-written markdown/Notion pages — entity pages, concept pages,
       decision pages, pattern pages, cross-references, summaries)
   ↓  query
LLM reads the pre-synthesized wiki first, raw sources only if needed
   ↓  answer
answer may itself be filed back into the wiki as a new page
```

The wiki is a **persistent, compounding artifact**. The LLM owns it entirely. The human never writes wiki pages; the human curates sources, asks questions, and steers.

### Why this matters

The tedious work in any knowledge base is bookkeeping: updating cross-references, keeping summaries current, flagging when new data contradicts old data, keeping consistency across dozens of pages. Humans abandon personal wikis because maintenance grows faster than value. LLMs don't get bored. The maintenance cost is near zero.

The insight is the same one Vannevar Bush had in 1945 with the Memex: private, actively curated, with the connections between documents as valuable as the documents themselves. Bush couldn't solve "who does the maintenance." Modern LLMs solve it.

---

## 3. Three-layer architecture

### Layer 1 — Raw sources (immutable)

The curated collection of source documents. Articles, emails, Slack threads, meeting transcripts, Drive docs, PDFs, images.

- **Read-only.** The LLM never modifies raw sources.
- **Source of truth.** If a wiki page contradicts a raw source, the raw source wins.
- **Addressable.** Every raw source must have a stable ID so wiki pages can cite back to it.

In MyOS, this layer is already built: `feed_events` table, with the `source_integrity` HMAC guaranteeing raws are untampered after ingest.

### Layer 2 — The wiki (LLM-maintained)

A directory of LLM-written markdown/Notion pages, organised into page types:

| Page type | Purpose | Example |
|---|---|---|
| **Entity** | One page per person, company, deal, account | "Acme Corp", "John Smith" |
| **Concept** | One page per domain concept | "Q2 budget cycle", "VIP escalation policy" |
| **Decision** | One page per material decision | "Approved CFO budget variance 2026-04-18" |
| **Pattern** | One page per recurring behavioural pattern | "CFO escalates on Fridays" |
| **Meeting** | One page per meeting | "Board call 2026-03-15" |
| **Project** | One page per project | "Vendor onboarding initiative" |
| **Overview** | One page per area synthesising entities + concepts + projects | "Sales state-of-the-world April 2026" |

- **LLM-owned.** Created, updated, deleted, cross-linked only by the LLM.
- **Versioned.** Every edit is auditable (Notion revision history + periodic git export).
- **Interlinked.** Pages cite one another and back-cite the raw sources they summarise.

In MyOS this layer will live in Notion, using the seven DB IDs carried over from v4.1 (see § 7).

### Layer 3 — The schema

A document (e.g. `CLAUDE.md` for Claude Code, `AGENTS.md` for Codex, or in our case `agents/src/brain/wiki/SCHEMA.md`) that tells the LLM how the wiki is structured:

- What page types exist
- The naming convention for each
- The required frontmatter / metadata
- How to handle new sources
- How to flag contradictions
- Cross-reference conventions
- When to create a new page vs update an existing one

**This is the single most important artefact of the wiki system.** A well-written schema turns an LLM from a generic chatbot into a disciplined wiki maintainer. The human and the LLM co-evolve the schema over weeks and months as the wiki grows and conventions settle.

For MyOS this document will be checked into the repo and loaded as the first prompt block for `wiki_scribe` on every invocation.

---

## 4. Three operations

### 4.1 Ingest

**Trigger:** A new raw source enters the system.

In MyOS:
- Every Gmail/Slack/Chat/CRM/WhatsApp/Calendar event that Feed Curator promotes to an OpenItem triggers a wiki ingest.
- Drive / Notion / manual Drop-Zone documents also trigger it.

**Flow:**
1. LLM reads the raw source.
2. LLM summarises the source and files a summary page under `sources/`.
3. LLM extracts entities, concepts, decisions mentioned.
4. LLM updates or creates the relevant entity / concept / decision / pattern pages.
5. LLM updates `index.md` with any new pages.
6. LLM appends to `log.md` with `[<date>] ingest | <title>`.

**Touch count:** A single source can touch 5-15 wiki pages. This is normal and desired.

**Supervision:** For MyOS, default to low-supervision (automatic) for LOW-risk sources, with human review for HIGH-risk ones (CFO emails, legal notices, board communications).

### 4.2 Query

**Trigger:** User asks a question via chat, or an agent needs context for a decision.

**Flow:**
1. LLM reads `index.md` first to find candidate pages.
2. LLM fetches 1-5 most relevant wiki pages.
3. LLM answers the question synthesising from the wiki.
4. Raw sources are fetched only if wiki coverage is insufficient.
5. **If the answer is substantive, it gets filed back into the wiki as its own page.**

That last point is critical. A comparison, a timeline, an analysis — these are valuable. If they only ever live in chat history, they decay. File them.

In MyOS terms: any Brain Query chat turn that produces a multi-paragraph synthesis should offer a one-click "Save to Wiki" that turns the answer into a Concept or Decision page.

### 4.3 Lint

**Trigger:** Scheduled (nightly at 03:00 PKT, after the 02:00 UTC rule miner).

**Flow:** Ask the LLM to health-check the wiki. Looking for:
- **Contradictions** — page A says X, page B says not-X
- **Stale claims** — a page references a decision that newer sources have superseded
- **Orphan pages** — no inbound or outbound links
- **Missing pages** — an entity is mentioned 10+ times in other pages but has no dedicated page
- **Missing cross-references** — two pages are topically related but don't link
- **Knowledge gaps** — questions the wiki implicitly raises but doesn't answer

The lint output is posted to the Steering Wheel inbox as a daily "Wiki Health" digest. Abdul reviews it weekly.

---

## 5. Meta-files

### 5.1 index.md — content-oriented catalogue

Flat list of every page in the wiki with a one-line summary. Organised by page type. Updated on every ingest.

Example snippet:

```md
# Index

## Entities
- [Acme Corp](entities/acme-corp.md) — 12 touchpoints, last 2026-04-18
- [Basit Ahmed](entities/basit-ahmed.md) — Internal, MD TMC

## Decisions
- [Approved Q2 Budget Variance](decisions/2026-04-18-q2-budget.md) — CFO escalation resolved
- [Rejected Vendor X Procurement](decisions/2026-04-12-vendor-x.md)

## Concepts
- [VIP Escalation Policy](concepts/vip-escalation.md)
- [Q2 Budget Cycle](concepts/q2-budget-cycle.md)

## Projects
- [Vendor Onboarding Initiative](projects/vendor-onboarding.md)
```

The Brain reads `index.md` first on every query to narrow the search space. At small-to-moderate scale (hundreds of pages), this works better than embedding search.

### 5.2 log.md — chronological record

Append-only. Consistent prefix per entry so it's parseable with grep:

```md
## [2026-04-20 09:15] ingest | CFO email: Q2 variance request
Updated: Acme Corp entity page, Q2 Budget Cycle concept page, CFO entity page.
Source: feed_events/fe_abc123

## [2026-04-20 10:32] query | What does the CFO think of vendor X?
Answered from: CFO entity page, Vendor X entity page, decisions 2026-03-08 and 2026-04-12.
Filed new page: concepts/cfo-vendor-x-stance.md

## [2026-04-21 03:00] lint | Nightly health check
Found: 2 orphan pages, 1 contradiction (pattern page conflicts with decision page), 3 gap questions.
Posted to Steering Wheel inbox.
```

The log is a timeline of the wiki's evolution. The Brain reads the last 50 entries on startup to understand recent context.

---

## 6. Integration with MyOS (no new layer — fold into L1-L5)

### 6.1 How the pattern distributes across existing layers

**Rule:** No L6. Every piece of the wiki work belongs to an existing layer.

```
L0  User surfaces
    └── "Connect Notion" OAuth flow (new Settings tab section)
    └── Wiki page browser embedded in Steering Wheel
L1  Feed
    └── Existing FeedAdapter contract extended to Notion
        (new adapter: reads user's Notion as a source, not just as a sink)
L2  Open Items / Knowledge State
    └── New table: wiki_pages (per-user, client_number + user_id scoped)
    └── New table: user_connectors row-type 'notion' per user
    └── Source-to-wiki-page lineage tracked via wiki_page_sources
L3  Actions
    └── New handlers: upsert_wiki_page, lint_wiki, propose_wiki_page
    └── Existing sync_thought_to_notion gets wiki-aware routing
L4  Steering Wheel
    └── New tab: Wiki (browse + search user's own pages)
    └── New Health Check component: wiki health (orphans, contradictions, staleness)
    └── New chip on Brain Query: "Save answer to Wiki"
L5  Central Brain
    └── New 7th worker: wiki_scribe (Gemini 2.5 Flash)
    └── Brain Orchestrator augmented to read user's wiki index first on every query
    └── Reflection agent extended with nightly wiki lint tool
    └── New inference tools: query_wiki_index, read_wiki_page, propose_wiki_page
```

Everything that was previously "L6 Memex" in earlier drafts of this document has been remapped to these existing layers.

### 6.2 Map to existing MyOS artefacts (per-user, multi-tenant)

| Karpathy concept | MyOS location | Scope |
|---|---|---|
| Raw sources | `feed_events` table + per-user pulls from each connector + `source_integrity` HMAC | per-tenant (`clientNumber`) — every raw event is tagged with `userId` when user-scoped |
| Connector access | `user_connectors` table (one row per user per provider) | per-user |
| Wiki pages (Notion path) | User's own Notion workspace — MyOS provisions 7 DBs under a root page the user picks during connect flow. Abdul's existing v4.1 DBs become his personal wiki. | per-user |
| Wiki pages (fallback path) | `wiki_pages` table (Postgres) storing markdown when a user has no Notion connected | per-user |
| Schema doc | **NEW** — `agents/src/brain/wiki/SCHEMA.md` (global — same conventions for all users) | global |
| Ingest agent | **NEW** — `wiki_scribe` sub-agent (ADK, Gemini 2.5 Flash); runs per-user on every trigger | per-user invocation |
| Query augmentation | Modify `brain_orchestrator` + `external_knowledge` to read querying-user's wiki first | per-user context |
| Lint agent | Reuse `reflection_agent` with a new nightly tool that iterates per user | per-user run |
| `index.md` equivalent | Per user — auto-maintained Notion page "MyOS Index" in each user's workspace; Postgres mirror in `wiki_index` view | per-user |
| `log.md` equivalent | Per user — auto-maintained Notion page "MyOS Log" in each user's workspace; Postgres source is `decision_logs` filtered to that user | per-user |
| Tenant-level policy | `system_config` rows for defaults (retention, supervision threshold, default page types) | per-tenant |
| CLI search | Future — `qmd` MCP server per-user when a user's wiki grows beyond 1000 pages | per-user |

### 6.3 Database additions (multi-tenant, per-user)

Three new tables. All scoped by `(client_number, user_id)` for tenant + user isolation.

```sql
-- Per-user wiki page index. Mirror of the pages that live in that user's
-- Notion workspace; authoritative copy of markdown for users without Notion.
CREATE TABLE wiki_pages (
  id               TEXT PRIMARY KEY,             -- Notion page ID OR cuid() for Postgres-backed pages
  client_number    VARCHAR(20) NOT NULL,
  user_id          INTEGER NOT NULL,
  page_type        VARCHAR(30) NOT NULL,         -- entity | concept | decision | pattern | meeting | project | overview | source_summary
  title            VARCHAR(300) NOT NULL,
  notion_db_id     VARCHAR(50),                  -- which of the user's 7 DBs; NULL if Postgres-backed
  storage          VARCHAR(20) NOT NULL,         -- 'notion' | 'postgres'
  body_markdown    TEXT,                         -- populated when storage='postgres'
  inbound_links    INTEGER NOT NULL DEFAULT 0,
  outbound_links   INTEGER NOT NULL DEFAULT 0,
  source_count     INTEGER NOT NULL DEFAULT 0,
  last_updated_at  TIMESTAMP NOT NULL,
  last_updated_by  VARCHAR(50),                  -- 'wiki_scribe' | 'user:<id>' | 'lint'
  status           VARCHAR(20) NOT NULL DEFAULT 'active', -- active | orphan | stale | contradicted
  confidence       NUMERIC(3,2),
  metadata         JSONB
);
CREATE UNIQUE INDEX wiki_pages_user_title_idx ON wiki_pages(client_number, user_id, page_type, title);
CREATE INDEX wiki_pages_user_type_idx ON wiki_pages(client_number, user_id, page_type);
CREATE INDEX wiki_pages_user_status_idx ON wiki_pages(client_number, user_id, status);

-- Source-to-page lineage. Tells us which feed_events contributed to which wiki page.
CREATE TABLE wiki_page_sources (
  id                 SERIAL PRIMARY KEY,
  wiki_page_id       TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  feed_event_id      TEXT,                       -- raw feed_events.id OR
  decision_log_id    TEXT,                       -- decision_logs.id OR
  open_item_id       TEXT,                       -- open_items.id
  client_number      VARCHAR(20) NOT NULL,
  user_id            INTEGER NOT NULL,
  cited_at           TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX wiki_page_sources_page_idx ON wiki_page_sources(wiki_page_id);
CREATE INDEX wiki_page_sources_user_idx ON wiki_page_sources(client_number, user_id, cited_at);

-- Cross-reference graph between wiki pages.
CREATE TABLE wiki_page_links (
  id                 SERIAL PRIMARY KEY,
  client_number      VARCHAR(20) NOT NULL,
  user_id            INTEGER NOT NULL,
  from_page_id       TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  to_page_id         TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  link_type          VARCHAR(30),                -- 'related' | 'supersedes' | 'contradicts' | 'parent' | 'child'
  created_at         TIMESTAMP NOT NULL DEFAULT now(),
  UNIQUE(from_page_id, to_page_id, link_type)
);
CREATE INDEX wiki_page_links_user_idx ON wiki_page_links(client_number, user_id);
```

Plus one extension to the existing `user_connectors` table to formally accept `providerName='notion'`:

```sql
-- No DDL change; just register 'notion' as a valid providerName value.
-- The column is already a free-form VARCHAR. We add an index for user lookups.
CREATE INDEX IF NOT EXISTS user_connectors_user_provider_idx
  ON user_connectors(client_number, user_id, provider_name);
```

### 6.4 New services

**`server/src/services/wiki/wikiStorageService.ts`** — storage-agnostic interface over "where does this user's wiki live".
- Reads from `user_connectors` to determine: does this user have Notion connected?
- If yes → calls wikiNotionService
- If no → calls wikiPostgresService (markdown stored in `wiki_pages.body_markdown`)
- Always writes to `wiki_pages` as the source of truth for metadata + cross-references

**`server/src/services/wiki/wikiNotionService.ts`** — Notion API wrapper per user.
- Uses that user's access_token + refresh_token from `user_connectors`
- Per-user rate-limit bucket (Notion allows 3 req/s per integration; each user's integration is independent so no global bottleneck)
- Upsert semantics (title-hash based, within user's 7 DBs)
- Cross-reference tracking: parses `[[page name]]` markdown, keeps `wiki_page_links` table in sync
- Wikilink → Notion mention rewriting
- Advisory lock per `(user_id, page_id)` in Redis to prevent concurrent stomps

**`server/src/services/wiki/wikiPostgresService.ts`** — Postgres-backed fallback for users without Notion.
- Pure markdown storage in `wiki_pages.body_markdown`
- Full-text search via Postgres `tsvector`
- Same wiki_page_links graph

**`server/src/services/connectors/notionConnectorService.ts`** — OAuth + onboarding for Notion.
- Initiates Notion OAuth flow; stores tokens in `user_connectors`
- On first connect, auto-provisions the 7 DBs under a root page the user picks
- Health probe: `users/me` Notion API
- Token refresh cron (Notion integration tokens don't actually expire, but we validate them weekly)

### 6.5 New agent — `wiki_scribe`

`agents/src/agents/wiki_scribe.py`:

- **Model:** Gemini 2.5 Flash (cheap, fast, good enough for summarisation).
- **Tenant + user context:** Every invocation takes `client_number` AND `user_id`; agent reads + writes only that user's wiki.
- **Trigger:** Pub/Sub on `tmcai-open-item-events` (status='CLOSED' or status='TRIAGED' with rich content) AND on `tmcai-decision-recorded`. Message attributes carry `userId`; agent routes to the owning user's wiki.
- **Tools (all user-scoped):**
  - `read_raw_source(feed_event_id)` — fetch from `feed_events` (user-scoped)
  - `read_wiki_page(page_id)` — storage-agnostic read
  - `upsert_wiki_page(page_type, title, content, links[])` — storage-agnostic write (Notion if user connected, Postgres fallback otherwise)
  - `append_to_index(page_id)` — update user's "MyOS Index" page
  - `append_to_log(entry)` — update user's "MyOS Log" page
  - `find_entities(text)` — NER via Gemini
  - `find_similar_pages(embedding)` — pgvector over `wiki_pages` scoped to user
  - `link_pages(from_id, to_id, link_type)` — update `wiki_page_links`

- **Instructions:** Load `SCHEMA.md` verbatim on every run. See § 8 for the schema spec.

### 6.6 Query augmentation (per-user)

Modify `brain_orchestrator.py` so every chat query automatically pulls context from the **querying user's** wiki first:

```
Before answering, query this user's wiki via `query_wiki_index(user_id, question)` —
returns the 3-5 most relevant page IDs with summaries from the user's own
Notion workspace (or Postgres fallback).
Then read those pages via `read_wiki_page(id)` for full content. Only fall
back to raw sources if the user's wiki coverage is insufficient.

If your answer synthesises material that isn't already in this user's wiki,
call `propose_wiki_page(user_id, type, title, content)` at the end — this
queues a new wiki page for review.

Never read another user's wiki. The `query_wiki_index` tool enforces this at
the platform layer.
```

### 6.7 Nightly lint cron (per-user loop)

One new cron at 03:00 PKT (22:00 UTC previous day):

```ts
setInterval(async () => {
  const tenants = await prisma.tenant.findMany({ where: { isActive: true } });
  for (const t of tenants) {
    const users = await prisma.user.findMany({
      where: { clientNumber: t.clientNumber, isActive: true } as any,
      select: { id: true },
    });
    for (const u of users) {
      const { mineWikiHealth } = await import('./services/wiki/wikiLintService');
      const findings = await mineWikiHealth(t.clientNumber, u.id);
      // findings = { orphans, contradictions, staleClaims, gapQuestions }
      await postToSteeringInbox(t.clientNumber, u.id, findings);
    }
  }
}, 24 * 60 * 60 * 1000);
```

Implementation uses `reflection_agent` with a new tool `lint_wiki(user_id)` that pulls that user's `wiki_pages` rows, cross-references them, and asks Gemini Pro to flag anomalies. Output is per-user; a user sees only their own wiki's findings.

### 6.8 [REMOVED — git backup is out of scope]

Git backup of wiki pages is explicitly excluded from this build. Users who want version history rely on:
- Notion's native page revision history (30 days on free tier, unlimited on paid)
- The Postgres fallback's append-only edit trail in `wiki_pages.metadata.edit_history`

---

## 7. The v4.1 Notion DB shell — Abdul's user-level wiki (free inheritance)

The 11 Notion databases created during the v4.1 install belong to **Abdul Haseeb's personal Notion workspace**. They become his user-level wiki in MyOS — stored as his `user_connectors` row with `providerName='notion'`.

| Purpose | Database ID |
|---|---|
| Entity Wiki | `1d1e67fa-fe72-80ca-9dca-f56b8a4c9b87` |
| Decision Wiki | `1d4e67fa-fe72-8041-bca2-d19a3f00f2c3` |
| Pattern Wiki | `1d4e67fa-fe72-80f8-97d1-ce55e16e1085` |
| Project Wiki | `1d1e67fa-fe72-80e2-a93b-d78a1b63e1b6` |
| Concept Wiki | `1d4e67fa-fe72-8039-9f45-c4e5e4780e5b` |
| Meeting Wiki | `1d4e67fa-fe72-80f9-ae4f-c4dadc818a24` |
| Pipeline — Delivery | `1d1e67fa-fe72-8020-abec-d10f8e37de24` |
| Pipeline — Sales | `1d1e67fa-fe72-8075-b2b2-ea6f8dc66c38` |
| Pipeline — Strategic | `1d4e67fa-fe72-80c3-9fee-e4f5dd104d84` |
| Pipeline — Innovation | `1d8e67fa-fe72-8082-abb8-c2f6a4ceaa4d` |
| Pipeline — Operations | `1d8e67fa-fe72-80ae-a38f-c49f1fb9e64e` |

All eleven are empty shells. On migration:
1. Seed Haseeb's `user_connectors` row with his Notion token + these DB IDs.
2. The wiki_scribe agent starts populating them as Haseeb's ingests roll through.

Token: `NOTION_TOKEN` from v4.1 (full R/W/Comment capabilities).

**For every subsequent user**, the Notion onboarding flow (§ 6.4, `notionConnectorService`) auto-creates the same 11 DBs under a root page in that user's own workspace. Each user ends up with their own isolated wiki — no cross-user reads, no shared pages, no tenant-wide wiki.

---

## 8. Schema document specification

The `SCHEMA.md` file is the LLM's operating manual for maintaining the wiki. Minimum contents:

### 8.1 Page naming conventions

- Entity: `<entity type> — <name>` (e.g. "Contact — Basit Ahmed", "Company — Acme Corp")
- Concept: `Concept — <short phrase>` (e.g. "Concept — VIP Escalation Policy")
- Decision: `Decision — <YYYY-MM-DD> — <short phrase>` (e.g. "Decision — 2026-04-18 — Approve Q2 Variance")
- Pattern: `Pattern — <trigger>`  (e.g. "Pattern — CFO Escalates Fridays")
- Meeting: `Meeting — <YYYY-MM-DD> — <context>` (e.g. "Meeting — 2026-04-15 — Board Call")
- Project: `Project — <codename>` (e.g. "Project — Vendor Onboarding")
- Source summary: `Source — <YYYY-MM-DD> — <title>` (e.g. "Source — 2026-04-20 — CFO email on Q2")

### 8.2 Frontmatter (Notion properties)

Every wiki page must have:
- `page_type` (select) — one of the 7 types above
- `created_at` (date)
- `last_updated_at` (date, auto)
- `source_ids` (multi-select of feed_event IDs that fed this page)
- `inbound_links` (count, auto-derived)
- `outbound_links` (count, auto-derived)
- `status` — Active / Orphan / Stale / Contradicted
- `confidence` — 0.0–1.0, LLM's self-assessed reliability

### 8.3 Page body conventions

Every wiki page follows this structure:

```
# <Title>

> Short one-sentence summary.

## Key facts
- Bullet 1 (source: [[Source — 2026-04-20 — CFO email on Q2]])
- Bullet 2 (source: [[...]])

## Narrative synthesis
Prose paragraph or three synthesising the facts. Cross-links to other
pages in [[wiki-link]] format.

## Related
- [[Concept — Q2 Budget Cycle]]
- [[Entity — Company — Acme Corp]]
- [[Decision — 2026-04-18 — Approve Q2 Variance]]

## Open questions
- Do we know why the variance is so high?
- Did anyone consult legal?

## Change log
- 2026-04-20: Page created from CFO email ingest
- 2026-04-21: Added narrative paragraph after follow-up email
```

### 8.4 Ingest workflow

On every ingest:

1. Read the raw source fully.
2. Produce a 3-sentence summary.
3. Create or update `Source — <date> — <title>` page with the summary and full text in a collapsible toggle.
4. Extract entities, concepts, decisions, meetings, projects mentioned.
5. For each extracted thing, upsert its wiki page:
   - If page exists, add facts under "Key facts" with source citation, regenerate narrative synthesis with the new info, add to change log.
   - If not, create a fresh page with the structure above.
6. Maintain cross-links: every new page lists all related pages under "Related".
7. Update index.md — add any newly created page to the right section.
8. Append to log.md.

### 8.5 Contradiction handling

When an ingest produces information that conflicts with an existing wiki page:

1. **Never silently overwrite.** Keep both versions.
2. Mark the page's status as "Contradicted".
3. Add a "Contradictions" section listing both claims with source citations.
4. Surface in the next lint run.
5. Abdul resolves by choosing which to trust; wiki_scribe updates accordingly and clears the Contradicted flag.

### 8.6 Deprecation / stale handling

- If a claim on page X is superseded by a later source, tag the sentence with `(superseded YYYY-MM-DD see [[new source]])`.
- If an entire page's subject is stale (e.g. project ended), mark `status = Stale` and freeze edits.
- Never delete pages outright — move to an `archive/` subfolder of the relevant DB.

### 8.7 Supervision modes

Configurable per page type:

| Page type | Default supervision |
|---|---|
| Source summary | Auto |
| Entity (non-VIP) | Auto |
| Concept | Auto |
| Meeting | Auto |
| Decision | Auto-draft + human approve |
| Pattern | Auto-draft + human approve |
| Entity (VIP) | Auto-draft + human approve |
| Contradiction resolution | Human only |

---

## 9. Operations that feed the wiki

| MyOS event | Wiki operation |
|---|---|
| Feed event ingested and promoted to OpenItem | Upsert Source summary + touched Entity / Concept pages |
| OpenItem transitions NEW → TRIAGED | Update archetype on Source summary page |
| OpenItem transitions → CLOSED | Create / update Decision page with resolution |
| Agent action executed | Append to the relevant Entity / Concept page change log |
| Approval given | Update Decision page with the approver and reason |
| Meeting detected (GCal event passed its end-time) | Create Meeting page from transcript (if available) or from participant list |
| Pattern detected by Reflection agent | Create / update Pattern page |
| User asks a chat query with a substantive synthesis | Offer "Save to Wiki" button → creates Concept page |

---

## 10. Success signals

How you'll know the Memex layer is working:

| Signal | Target in 3 months |
|---|---|
| Wiki page count | > 200 active pages |
| Average cross-references per page | > 3 |
| Percentage of Brain queries answered primarily from wiki (not raw) | > 60% |
| User satisfaction ("the AI actually knows our business") | Qualitative — Abdul says "yes" |
| Lint findings per week | Trending down (wiki healthy) |
| Time to answer a new synthesis query | Down from minutes to seconds |
| Wiki page edits per week | > 50 (proves ingest is active) |
| Orphan pages | < 5% of total |

---

## 11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Notion API rate limits throttle wiki updates | Batched writes + exponential backoff; fail open — drop ingest, log, retry later |
| Token cost of frequent wiki updates | Gemini 2.5 Flash is cheap; cap at ~$200/month or fail-open once cap is hit |
| LLM hallucinates facts into wiki | Every fact must cite a source ID; lint flags unsourced claims |
| LLM over-writes good pages with worse versions | Notion revision history + git backup; humans review decision / pattern pages |
| Wiki becomes too big for index.md | At ~500 pages introduce a search index (qmd or pgvector over page titles) |
| Inconsistent conventions drift the wiki | SCHEMA.md is strict; lint checks for deviation; Abdul and agent refine conventions together over time |
| Notion workspace compromised | Mirror to git repo nightly as a cold backup |
| LLM can't find right page on query | Start with index.md approach; upgrade to embedding search if precision degrades |
| Two ingests stomp on each other | Per-page advisory lock in Redis |
| Contradictions go unresolved | Lint surfaces them; Abdul reviews weekly |

---

## 12. Phased rollout

### Phase 1 — Proof of concept for one user (2-3 days)

- Write `SCHEMA.md` with minimum conventions (global).
- Create `wiki_pages`, `wiki_page_sources`, `wiki_page_links` tables.
- Build `wikiStorageService` + `wikiNotionService` (Notion API wrapper).
- Build `wiki_scribe` agent skeleton wired to Gemini Flash.
- Seed Haseeb's `user_connectors` row with v4.1 Notion token + DB IDs.
- Wire to **ONE** DB only (Decision Wiki).
- Trigger on OpenItem transitioning to CLOSED for Haseeb's user ID only.
- Run against next 20-30 of his ingests.
- Measure: do the wiki pages look useful to Abdul?

Exit criterion: Abdul looks at his Decision Wiki after a week and says "these pages actually help."

### Phase 2 — Full ingest surface per user (3-4 days)

- Extend to all 11 Notion DBs.
- Wire triggers for feed_events, agent_actions, Pub/Sub open-item-events — all scoped to the `userId` the event belongs to.
- Add per-user "MyOS Index" + "MyOS Log" auto-maintenance.
- Add cross-reference tracking via `wiki_page_links`.
- Implement `wikiPostgresService` fallback for users without Notion.

### Phase 3 — Query augmentation (2 days)

- Modify Brain Orchestrator to pre-load the querying user's wiki context.
- Add "Save to Wiki" button in Brain Query UI.
- Add per-user wiki search tool for `external_knowledge` agent.

### Phase 4 — Notion connector UX + onboarding (2 days)

- Settings tab: "Connect Notion" OAuth flow.
- On first connect, `notionConnectorService` auto-provisions 11 DBs under a root page the user picks.
- Steering Wheel Wiki tab: browse + search the user's own pages.
- Health Check: per-user wiki health component.

### Phase 5 — Lint + schema evolution (2 days)

- Nightly lint cron at 03:00 PKT, iterating per user.
- Findings posted to each user's Steering Wheel inbox.
- Track which schema conventions work, which don't — quarterly review.

### Removed

- ~~Phase: Git backup~~ — explicitly excluded per MyOS scope decision. Notion's native revision history + Postgres edit trail are sufficient.

---

## 13. Non-goals (explicitly excluded from this spec)

- **Replacing Notion.** Notion stays the primary UI for users who have it. We don't build our own wiki frontend; we render pages inside Notion plus a thin browse/search UI in the Steering Wheel Wiki tab.
- **General-purpose RAG over the wiki.** We stick to index-based lookup until scale demands otherwise.
- **Cross-user wiki sharing.** Each user has their own isolated wiki. No cross-user reads. Cross-tenant reads are impossible by construction.
- **Tenant-wide shared wiki.** MyOS is SaaS; knowledge belongs to the user who sourced it, not the tenant.
- **Auto-publishing to external surfaces.** The wiki is private to the user.
- **Git backup / export.** Explicitly out of scope.
- **Obsidian integration as a write surface.** If a user chooses Postgres-fallback, the markdown is queryable but not synced to Obsidian in this build.
- **Voice ingest.** Text first; voice via existing WhatsApp pipeline lands as raw sources that Feed Curator still promotes, wiki_scribe still indexes.

---

## 14. Glossary

- **Memex** — Vannevar Bush's 1945 concept of a personal, curated knowledge store with associative trails between documents. The direct ancestor of the LLM Wiki pattern.
- **Wiki** in this doc — the persistent, LLM-maintained layer of synthesised markdown pages, stored in Notion. Not Wikipedia; not Mediawiki.
- **Ingest** — the process of incorporating a new raw source into the wiki.
- **Lint** — periodic health check of the wiki for contradictions, orphans, stale data.
- **Orphan page** — a wiki page with zero inbound or outbound links; candidate for merge or deletion.
- **Stale claim** — a statement on a wiki page contradicted or superseded by newer sources.
- **Source citation** — an inline reference on a wiki page pointing back to the raw source (feed_event ID, Drive file ID, URL).
- **Cross-reference** — a `[[wiki-link]]` from one wiki page to another.
- **Schema** — the operating manual for the LLM wiki maintainer. `SCHEMA.md` in our repo.
- **Scribe** — the agent that writes and maintains the wiki. `wiki_scribe` in MyOS.

---

## Appendix A — The source pattern (Andrej Karpathy, verbatim)

The following is the complete text of the LLM Wiki gist by Andrej Karpathy, reproduced verbatim and attributed. This is the canonical source for the pattern this document implements.

> **LLM Wiki**
>
> A pattern for building personal knowledge bases using LLMs.
>
> This is an idea file, it is designed to be copy pasted to your own LLM Agent (e.g. OpenAI Codex, Claude Code, OpenCode / Pi, or etc.). Its goal is to communicate the high level idea, but your agent will build out the specifics in collaboration with you.
>
> **The core idea**
>
> Most people's experience with LLMs and documents looks like RAG: you upload a collection of files, the LLM retrieves relevant chunks at query time, and generates an answer. This works, but the LLM is rediscovering knowledge from scratch on every question. There's no accumulation. Ask a subtle question that requires synthesizing five documents, and the LLM has to find and piece together the relevant fragments every time. Nothing is built up. NotebookLM, ChatGPT file uploads, and most RAG systems work this way.
>
> The idea here is different. Instead of just retrieving from raw documents at query time, the LLM **incrementally builds and maintains a persistent wiki** — a structured, interlinked collection of markdown files that sits between you and the raw sources. When you add a new source, the LLM doesn't just index it for later retrieval. It reads it, extracts the key information, and integrates it into the existing wiki — updating entity pages, revising topic summaries, noting where new data contradicts old claims, strengthening or challenging the evolving synthesis. The knowledge is compiled once and then _kept current_, not re-derived on every query.
>
> This is the key difference: **the wiki is a persistent, compounding artifact.** The cross-references are already there. The contradictions have already been flagged. The synthesis already reflects everything you've read. The wiki keeps getting richer with every source you add and every question you ask.
>
> You never (or rarely) write the wiki yourself — the LLM writes and maintains all of it. You're in charge of sourcing, exploration, and asking the right questions. The LLM does all the grunt work — the summarizing, cross-referencing, filing, and bookkeeping that makes a knowledge base actually useful over time. In practice, I have the LLM agent open on one side and Obsidian open on the other. The LLM makes edits based on our conversation, and I browse the results in real time — following links, checking the graph view, reading the updated pages. Obsidian is the IDE; the LLM is the programmer; the wiki is the codebase.
>
> This can apply to a lot of different contexts. A few examples:
> - **Personal**: tracking your own goals, health, psychology, self-improvement — filing journal entries, articles, podcast notes, and building up a structured picture of yourself over time.
> - **Research**: going deep on a topic over weeks or months — reading papers, articles, reports, and incrementally building a comprehensive wiki with an evolving thesis.
> - **Reading a book**: filing each chapter as you go, building out pages for characters, themes, plot threads, and how they connect. By the end you have a rich companion wiki. Think of fan wikis like Tolkien Gateway — thousands of interlinked pages covering characters, places, events, languages, built by a community of volunteers over years. You could build something like that personally as you read, with the LLM doing all the cross-referencing and maintenance.
> - **Business/team**: an internal wiki maintained by LLMs, fed by Slack threads, meeting transcripts, project documents, customer calls. Possibly with humans in the loop reviewing updates. The wiki stays current because the LLM does the maintenance that no one on the team wants to do.
> - **Competitive analysis, due diligence, trip planning, course notes, hobby deep-dives** — anything where you're accumulating knowledge over time and want it organized rather than scattered.
>
> **Architecture**
>
> There are three layers:
>
> **Raw sources** — your curated collection of source documents. Articles, papers, images, data files. These are immutable — the LLM reads from them but never modifies them. This is your source of truth.
>
> **The wiki** — a directory of LLM-generated markdown files. Summaries, entity pages, concept pages, comparisons, an overview, a synthesis. The LLM owns this layer entirely. It creates pages, updates them when new sources arrive, maintains cross-references, and keeps everything consistent. You read it; the LLM writes it.
>
> **The schema** — a document (e.g. CLAUDE.md for Claude Code or AGENTS.md for Codex) that tells the LLM how the wiki is structured, what the conventions are, and what workflows to follow when ingesting sources, answering questions, or maintaining the wiki. This is the key configuration file — it's what makes the LLM a disciplined wiki maintainer rather than a generic chatbot. You and the LLM co-evolve this over time as you figure out what works for your domain.
>
> **Operations**
>
> **Ingest.** You drop a new source into the raw collection and tell the LLM to process it. An example flow: the LLM reads the source, discusses key takeaways with you, writes a summary page in the wiki, updates the index, updates relevant entity and concept pages across the wiki, and appends an entry to the log. A single source might touch 10-15 wiki pages. Personally I prefer to ingest sources one at a time and stay involved — I read the summaries, check the updates, and guide the LLM on what to emphasize. But you could also batch-ingest many sources at once with less supervision. It's up to you to develop the workflow that fits your style and document it in the schema for future sessions.
>
> **Query.** You ask questions against the wiki. The LLM searches for relevant pages, reads them, and synthesizes an answer with citations. Answers can take different forms depending on the question — a markdown page, a comparison table, a slide deck (Marp), a chart (matplotlib), a canvas. The important insight: **good answers can be filed back into the wiki as new pages.** A comparison you asked for, an analysis, a connection you discovered — these are valuable and shouldn't disappear into chat history. This way your explorations compound in the knowledge base just like ingested sources do.
>
> **Lint.** Periodically, ask the LLM to health-check the wiki. Look for: contradictions between pages, stale claims that newer sources have superseded, orphan pages with no inbound links, important concepts mentioned but lacking their own page, missing cross-references, data gaps that could be filled with a web search. The LLM is good at suggesting new questions to investigate and new sources to look for. This keeps the wiki healthy as it grows.
>
> **Indexing and logging**
>
> Two special files help the LLM (and you) navigate the wiki as it grows. They serve different purposes:
>
> **index.md** is content-oriented. It's a catalog of everything in the wiki — each page listed with a link, a one-line summary, and optionally metadata like date or source count. Organized by category (entities, concepts, sources, etc.). The LLM updates it on every ingest. When answering a query, the LLM reads the index first to find relevant pages, then drills into them. This works surprisingly well at moderate scale (~100 sources, ~hundreds of pages) and avoids the need for embedding-based RAG infrastructure.
>
> **log.md** is chronological. It's an append-only record of what happened and when — ingests, queries, lint passes. A useful tip: if each entry starts with a consistent prefix (e.g. `## [2026-04-02] ingest | Article Title`), the log becomes parseable with simple unix tools — `grep "^## \[" log.md | tail -5` gives you the last 5 entries. The log gives you a timeline of the wiki's evolution and helps the LLM understand what's been done recently.
>
> **Optional: CLI tools**
>
> At some point you may want to build small tools that help the LLM operate on the wiki more efficiently. A search engine over the wiki pages is the most obvious one — at small scale the index file is enough, but as the wiki grows you want proper search. qmd is a good option: it's a local search engine for markdown files with hybrid BM25/vector search and LLM re-ranking, all on-device. It has both a CLI (so the LLM can shell out to it) and an MCP server (so the LLM can use it as a native tool). You could also build something simpler yourself — the LLM can help you vibe-code a naive search script as the need arises.
>
> **Tips and tricks**
>
> - **Obsidian Web Clipper** is a browser extension that converts web articles to markdown. Very useful for quickly getting sources into your raw collection.
> - **Download images locally.** In Obsidian Settings → Files and links, set "Attachment folder path" to a fixed directory (e.g. `raw/assets/`). Then in Settings → Hotkeys, search for "Download" to find "Download attachments for current file" and bind it to a hotkey (e.g. Ctrl+Shift+D). After clipping an article, hit the hotkey and all images get downloaded to local disk. This is optional but useful — it lets the LLM view and reference images directly instead of relying on URLs that may break. Note that LLMs can't natively read markdown with inline images in one pass — the workaround is to have the LLM read the text first, then view some or all of the referenced images separately to gain additional context. It's a bit clunky but works well enough.
> - **Obsidian's graph view** is the best way to see the shape of your wiki — what's connected to what, which pages are hubs, which are orphans.
> - **Marp** is a markdown-based slide deck format. Obsidian has a plugin for it. Useful for generating presentations directly from wiki content.
> - **Dataview** is an Obsidian plugin that runs queries over page frontmatter. If your LLM adds YAML frontmatter to wiki pages (tags, dates, source counts), Dataview can generate dynamic tables and lists.
> - The wiki is just a git repo of markdown files. You get version history, branching, and collaboration for free.
>
> **Why this works**
>
> The tedious part of maintaining a knowledge base is not the reading or the thinking — it's the bookkeeping. Updating cross-references, keeping summaries current, noting when new data contradicts old claims, maintaining consistency across dozens of pages. Humans abandon wikis because the maintenance burden grows faster than the value. LLMs don't get bored, don't forget to update a cross-reference, and can touch 15 files in one pass. The wiki stays maintained because the cost of maintenance is near zero.
>
> The human's job is to curate sources, direct the analysis, ask good questions, and think about what it all means. The LLM's job is everything else.
>
> The idea is related in spirit to Vannevar Bush's Memex (1945) — a personal, curated knowledge store with associative trails between documents. Bush's vision was closer to this than to what the web became: private, actively curated, with the connections between documents as valuable as the documents themselves. The part he couldn't solve was who does the maintenance. The LLM handles that.
>
> **Note**
>
> This document is intentionally abstract. It describes the idea, not a specific implementation. The exact directory structure, the schema conventions, the page formats, the tooling — all of that will depend on your domain, your preferences, and your LLM of choice. Everything mentioned above is optional and modular — pick what's useful, ignore what isn't. For example: your sources might be text-only, so you don't need image handling at all. Your wiki might be small enough that the index file is all you need, no search engine required. You might not care about slide decks and just want markdown pages. You might want a completely different set of output formats. The right way to use this is to share it with your LLM agent and work together to instantiate a version that fits your needs. The document's only job is to communicate the pattern. Your LLM can figure out the rest.

Source: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
License: shared publicly as an idea document by Andrej Karpathy, intended to be copy-pasted into LLM agents.
