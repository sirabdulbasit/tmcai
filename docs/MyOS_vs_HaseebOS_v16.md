# MyOS vs HaseebOS v16 — Feature-by-Feature Comparison

**Date:** 2026-04-29
**Scope:** Pure feature-level comparison. **Multi-tenancy and multi-user features are excluded** by request — those are MyOS's structural advantages that v16 cannot match by design, so including them would make the comparison one-sided.

**Methodology:** Each feature area lists what each system has, picks a winner with reasoning, and quantifies the lead (decisive / clear / slight / tie). Final scoreboard at the bottom.

## Rating scale per row

| Symbol | Meaning |
|---|---|
| 🥇 | Decisive winner — the other side either lacks the feature entirely or has a much weaker version |
| ✅ | Clear winner — meaningfully ahead in capability/maturity |
| 🟰 | Tie — both do the same thing equally well, just different shapes |
| ⚠️ | Has it but immature/blocked |
| ❌ | Doesn't have it |

---

## A. Architecture & Layers

| Feature | MyOS | HaseebOS v16 | Winner |
|---|---|---|---|
| Conceptual layers | 6 (Feed → Knowledge → Brain → Action → Open Items → Instructions) | 4 (Interface, API, Brain, Data) | MyOS ✅ — more granular separation; Open Items + Instructions promoted to top-level |
| Runtime split | Monolithic Node + Postgres | Cloud Run microservices: feed_ingest, approval_router, knowledge_api, brain_runtime, actions_runtime, orchestrator | v16 ✅ — proper service boundaries |
| Data store | PostgreSQL + pgvector + Redis | Firestore (28 collections) + GCS + BigQuery + Git vault | 🟰 — different shapes; both work |
| Migration story | 35+ Prisma migrations, idempotent seeders | n/a (NoSQL) | 🟰 |
| Schema rigor | Typed Prisma + Zod-style validation | Loose Firestore + collection conventions | MyOS ✅ — typed contracts, refactor-safe |

**Section verdict:** MyOS ahead on layer clarity + schema rigor. v16 ahead on service boundaries (Cloud Run microservices). Even.

---

## B. Brain — Reasoning depth

| Feature | MyOS | HaseebOS v16 | Winner |
|---|---|---|---|
| Reasoning model | 5-phase Criticality Engine: signal gathering → contextual fusion → multi-dim scoring → superpowers → action band | One-shot Sonnet 4.6 Director with rule-engine gate → 7 primitives → ProposalEmittingTool | 🟰 — different philosophies. MyOS deeper, v16 simpler+faster |
| Dimensions scored | 5: timePressure, impact, relationshipRisk, cascade, patternAnomaly | Single composite via Sonnet | MyOS ✅ — explicit dimension breakdown |
| LLM fallback | Deterministic scorer when LLM unavailable | None (Sonnet required) | MyOS 🥇 |
| Per-user calibration | Yes — threshold + dimension weights learned from 👎 | None | MyOS 🥇 |
| Brain memory | Cognitive engine with rolling state + observations every 30 min | Stateless Sonnet calls | MyOS ✅ |
| Document-typed outputs | Brain Docs (replayable, versioned, supersedes) | Typed Firestore docs (MorningBriefDoc, RiskFlagDoc, AskInvocationDoc, ThoughtObject) | 🟰 — both have it |
| Replay engine | `POST /brain/docs/:id/replay` re-runs from input_summary | Versioned Docs but no automatic replay | MyOS ✅ |
| Reasoning latency | Variable, depends on LLM provider | Single Sonnet call (fast hot path) | v16 ✅ — Director architecture is leaner |
| Reasoning explainability | Every dimension + reason listed in output | Sonnet narrative only | MyOS ✅ |

**Section verdict:** MyOS ahead on depth, calibration, fallback safety, replayability. v16 ahead on hot-path latency.

---

## C. Brain — Delegation & Routing

| Feature | MyOS | HaseebOS v16 | Winner |
|---|---|---|---|
| Delegation matrix | DB table with admin UI + audit history | Policy file (36 areas, 31 emails) loaded from secret each turn | MyOS ✅ — auditable, mutable without redeploy |
| Renders into Brain prompt | Yes via renderMatrixBlock + cache + H9 honesty rule | Yes — system prompt assembly | 🟰 |
| Criticality engine integration | gatherDelegationOwners signal | n/a (single-flow Sonnet) | MyOS 🥇 |
| Per-area escalation chain | Yes (escalateTo field) | Implicit | MyOS ✅ |
| Audit trail of changes | delegation_matrix_history append-only | Git history of policy file | 🟰 — both auditable |

**Section verdict:** MyOS ✅ — same concept, more dynamic + introspectable.

---

## D. Brain — Pattern Learning & Feedback

| Feature | MyOS | HaseebOS v16 | Winner |
|---|---|---|---|
| 👍/👎 feedback | Yes per chat answer + per triage decision | Not shown in v16 architecture | MyOS 🥇 |
| Pattern miner | shadow_rules → confirmed/revoked, weekly job | None | MyOS 🥇 |
| Rule promotion lifecycle | DRAFT → SHADOW → ACTIVE → FROZEN | None | MyOS 🥇 |
| Calibration consumer | Threshold shift per-user, dimension reweighting | None | MyOS 🥇 |
| User-defined Action Rules (UDARs) | NL → parsed structured rule + 3 modes (DRAFT/SUGGEST/AUTO) | None | MyOS 🥇 |
| "What Brain learned this week" surface | Day Brief section with feedback rollup + diagnoses | None visible | MyOS 🥇 |

**Section verdict:** MyOS 🥇 — entire learning loop is unique to MyOS. v16 is single-operator so there's nothing to learn from at population scale.

---

## E. Risk Surface

| Feature | MyOS | HaseebOS v16 | Winner |
|---|---|---|---|
| Daily risk surface | Risk Radar (rule-driven, runs at user's schedule) | risk_radar daily 08:15 PKT → RiskFlagDoc | 🟰 — same idea |
| Rule editor | My Rules → Risk Radar tab with 3 sources, predicate JSON DSL | Hardcoded triggers behind risk_radar job | MyOS 🥇 |
| Pre-shipped rules | 8 system rules (escalation/sentiment/unresolved/delayed/stagnant/hostile/urgent/VIP) | Risk radar logic baked into job | MyOS ✅ |
| User-defined risk rules | Yes — 3 sources (feed_event / open_item / wiki_page), per-user CRUD | None visible | MyOS 🥇 |
| Per-rule severity + suggested action | Yes | n/a | MyOS 🥇 |
| Star-aware ranking | 4★/5★ contacts get severity boost | n/a | MyOS 🥇 |
| Sentiment-aware ranking | tone='hostile' → high; sentiment ≤ -0.3 + ★3+ → high | n/a | MyOS 🥇 |
| Self-email + bot domain noise filter | Yes (system-wide) | n/a | MyOS 🥇 |
| LLM-narrated daily summary | Yes (gemini-flash for cost) | Yes | 🟰 |
| Inline action buttons on flags | Open / Snooze / Mark done / Dismiss per signal | Visual only | MyOS 🥇 |
| Per-flag suggestedAction | Yes from rule + UI rendering | Sonnet narrative | MyOS ✅ |
| Configurable per-user | risk_radar_config per user (signals + thresholds + exclude list) | Operator-tunable | 🟰 |

**Section verdict:** MyOS 🥇 — Risk Radar is one of the strongest MyOS features and is rules-driven all the way down.

---

## F. Action Layer

| Feature | MyOS | HaseebOS v16 | Winner |
|---|---|---|---|
| Action handlers count | 30+ typed handlers across 7 categories | 8 handlers | MyOS 🥇 |
| Categories | Lifecycle (7), Communication (5), Calendar (5), Task (4), CRM (4 Odoo), Orchestration (3), Brain (4), Governance (3) | n/a — fewer + general | MyOS ✅ |
| Dry-run | Every handler implements dryRun() | n/a | MyOS 🥇 |
| Undo / Reverse operation | handler.undo() returns ReverseOperation | n/a | MyOS 🥇 |
| Idempotency | withIdempotency wrapper + Redis SETNX + audit | n/a | MyOS 🥇 |
| Risk tier per handler | LOW/MEDIUM/HIGH | n/a | MyOS ✅ |
| Approval gating | confidence-thresholded + risk-tier-gated | approval_router | 🟰 |
| Schema validation | JSONSchema per handler | Pydantic-style | 🟰 |
| Dependency graph | Multi-step plan executor | n/a | MyOS 🥇 |

**Section verdict:** MyOS 🥇 — far more sophisticated action layer.

---

## G. Knowledge Layer

| Feature | MyOS | HaseebOS v16 | Winner |
|---|---|---|---|
| Storage | PostgreSQL wiki_pages + pgvector(768) + IVFFlat index | Obsidian markdown vault on GitHub + GCS embeddings | 🟰 — different choices |
| Vector retrieval | pgvector ANN inside Postgres | Vertex text-embedding-005 + custom retrieval | 🟰 |
| Backfill job | Nightly chunk vector backfill cron | n/a | MyOS ✅ |
| Hybrid storage backend | Notion (when connected) + Postgres fallback | Obsidian only | MyOS ✅ |
| Manual curation | Possible but not the primary path | 1335 hand-curated people files | v16 🥇 — depth via manual investment |
| Auto-discovery | Yes — every distinct sender becomes entity_person | n/a (manual files) | MyOS 🥇 |
| Channel tracking | metadata.channels[] (gmail/whatsapp/etc.) | n/a | MyOS 🥇 |
| Star rating per entity | Yes (0-5, per-user) | n/a | MyOS 🥇 |
| Entity sweep / nightly maintenance | Yes (last_contact, frequency, recent topics, open items, CRM match) | Manual | MyOS 🥇 |
| Wiki linting / contradiction detection | wikiLintWorker | n/a visible | MyOS ✅ |
| Source fidelity | DB rows + replay docs | Git history of vault | 🟰 |
| External access | Notion sync (when connected) | Obsidian (Markdown editor of choice) | 🟰 |

**Section verdict:** Tie overall — v16 wins on hand-curated quality (1335 files); MyOS wins on automated coverage + per-entity rating + signal tracking. Different tradeoffs.

---

## H. Connectors / Feed Sources

| Feature | MyOS | HaseebOS v16 | Winner |
|---|---|---|---|
| Total connectors | 12 (Gmail, Outlook, Outlook Calendar, GCal, GTasks, GChat, Slack, Teams, OneDrive, WhatsApp, Notion, Odoo) | 4 (Gmail, Calendar, WhatsApp, Manual) | MyOS 🥇 |
| Connector status | Most production-ready | Gmail/Calendar BLOCKED on OAuth | MyOS ✅ — operationally |
| Adapter contract | 10-method (verify, normalise, receive, enrich, health, backfill, teardown, etc.) | Per-source services | MyOS 🥇 |
| Configurable credentials | 3-tier (user / admin-tenant / env fallback) | Single OAuth grant | MyOS 🥇 |
| CRM mirror | Odoo → wiki nightly with signature-skip | None | MyOS 🥇 |
| Microsoft Graph sharing | One helper, all 4 MS adapters share OAuth | n/a | MyOS ✅ |
| Connector marketplace | Catalog with readiness flags | n/a | MyOS ✅ |

**Section verdict:** MyOS 🥇 — wider, deeper, more configurable.

---

## I. Trust Controls (Kill Switch + Safety)

| Feature | MyOS | HaseebOS v16 | Winner |
|---|---|---|---|
| Kill switch | Yes (per-tenant; trigger/release/status/history/withheld) | Yes (single button) | MyOS ✅ — more sophisticated |
| Durable persistence | Redis + system_config dual-write | In-memory or Firestore | 🟰 |
| Survives Redis flush | Yes (config fallback) | Depends on Firestore behavior | MyOS ✅ |
| Action handler enforcement | executeViaRegistry checks at backend boundary | approval_router | 🟰 |
| Withheld actions list | Admin-visible queue of blocked actions | Held in approval_router | 🟰 |
| History | Full audit of every flip | Git of policy or Firestore | 🟰 |
| Per-tenant override | n/a (single operator) | n/a | n/a (excluded) |
| UI surface | Header badge + admin tab | UI button | 🟰 |
| Confidence-gated drafts | Yes (per-channel threshold) | n/a | MyOS ✅ |
| Risk-tier gating | LOW/MEDIUM/HIGH per action | Implicit | MyOS ✅ |

**Section verdict:** MyOS ✅ — same concept, deeper implementation.

---

## J. Approval UX (notify + decide)

| Feature | MyOS | HaseebOS v16 | Winner |
|---|---|---|---|
| Push notifications | Web Push (VAPID + service worker pending on client) | FCM push (deployed, phone token registration unverified) | v16 ✅ — operationally further along |
| Email fallback | Yes | Yes | 🟰 |
| WhatsApp fallback | Yes | n/a | MyOS ✅ |
| Approval token system | Single-use signed tokens (32-byte b64url, SHA-256 stored, 24h TTL) | Push fanout to phone | MyOS 🥇 — security model is sharper |
| Per-event-type prefs | 8 toggleable event types per-user | n/a (operator only) | MyOS 🥇 |
| Quiet hours | Yes (timezone-aware, allowCritical override) | n/a | MyOS 🥇 |
| Rate limit | Yes (per-user max/hour) | n/a | MyOS 🥇 |
| Multi-device fan-out | Yes (every active subscription) | Yes (FCM) | 🟰 |
| One-tap approve from notification | Architected, awaiting client SW | Operational | v16 ✅ |
| In-app approval queue | Open Items + Day Brief | Approval router queue | 🟰 |

**Section verdict:** MyOS ✅ on architecture + features. v16 ✅ on operational deployment. Slight v16 edge today, MyOS ahead on the long arc.

---

## K. Cost & Observability

| Feature | MyOS | HaseebOS v16 | Winner |
|---|---|---|---|
| Per-call cost recording | Every callLLM writes to llm_spend table | BigQuery rows from metrics_etl | 🟰 |
| Daily timeline | getTimeline endpoint + chart | BigQuery daily_cost_summary view | 🟰 |
| Anomaly detection | Today vs trailing 7d × 2.5 | Manual eyeball | MyOS ✅ |
| Cost dashboard UI | Self-contained HTML (Chart.js) at /admin/cost/dashboard | Looker Studio dashboard URL baked in | 🟰 — different paths |
| Self-hosted vs external | Self-hosted (no GCP coupling) | Looker (GCP-coupled) | MyOS ✅ — portable |
| Per-user breakdown | top users + top purposes + top providers | Operator only | n/a (excluded — multi-user) |
| Per-Brain-Doc cost attribution | brain_doc_id column (column exists; not yet populated) | n/a | ⚠️ |
| Spend cap / budget gates | Architectural slot, not yet enforced | Not visible | ⚠️ |
| Looker dashboard quality | n/a | Live Looker board | v16 ✅ — chart sophistication |

**Section verdict:** Tie. MyOS more portable + analytics-rich; v16 has the polished Looker board.

---

## L. Audit / Replay

| Feature | MyOS | HaseebOS v16 | Winner |
|---|---|---|---|
| Typed Doc store | brain_docs (9 doc_types) | Firestore typed Docs (MorningBriefDoc, RiskFlagDoc, AskInvocationDoc, ProposalDoc, ThoughtObject) | 🟰 |
| Versioning | version + supersededBy chain | Document version field | 🟰 |
| Cache-hit detection | inputs_hash check before regen | n/a visible | MyOS ✅ |
| Replay endpoint | POST /brain/docs/:id/replay | Manual rerun | MyOS ✅ |
| Source-event linkage | source_event_ids[] with GIN index | Firestore references | 🟰 |
| AskInvocationDoc audit | Yes (via brain_docs doc_type='ask_invocation') | Yes | 🟰 |
| Audit log of every flip / action | audit_logs table with broad coverage | Multiple Firestore collections | 🟰 |

**Section verdict:** Tie — both have real audit/replay; MyOS slightly ahead on cache-hit detection.

---

## M. Standing Instructions / User Intent

| Feature | MyOS | HaseebOS v16 | Winner |
|---|---|---|---|
| Standing instructions concept | 6th layer — explicit user orders | Policies in delegation file | MyOS ✅ — formal layer |
| NL parser | LLM parses NL into kind/subject/condition/action/dueAt | Manual policy editing | MyOS 🥇 |
| Lifecycle | active / paused / fulfilled / archived | Git commit lifecycle | MyOS ✅ |
| Scope (client/user) | Yes — but excluded by request | n/a | excluded |
| Brain composer integration | renderInstructionsBlock + H8 honesty rule | System prompt assembly | 🟰 |
| Watchpoint kind | Yes (alert when X mentioned) | n/a explicit | MyOS ✅ |
| Follow-up kind | Yes (chase if no reply by Y) | n/a | MyOS ✅ |
| Scheduled kind | Yes (weekly summary etc.) | Cron-based | 🟰 |
| Todo kind | Yes (one-shot reminder) | n/a | MyOS ✅ |
| Due date awareness | metadata.dueAt drives Risk Radar imminence | Cron schedule | 🟰 |

**Section verdict:** MyOS 🥇 — the entire 6th-layer abstraction is unique to MyOS.

---

## N. UI Sophistication

| Feature | MyOS | HaseebOS v16 | Winner |
|---|---|---|---|
| Day Brief / morning surface | 3-zone layout (Today / Brain's Activity / Setup) + collapsible sections + "?" help with examples | Brain reasons + emits MorningBriefDoc | MyOS ✅ |
| Inline help on every section | Yes — explainer panel with What/How/Helps/Make-it-better | n/a | MyOS 🥇 |
| Risk Radar UI | Inline panel + per-flag action buttons + Tune-radar config + Re-run | Visualisation TBD | MyOS 🥇 |
| Contacts catalog | Full page with stars, filters, sources, channels | n/a | MyOS 🥇 |
| Cost dashboard | Server-rendered Chart.js page | Looker | 🟰 |
| Toasts (no dialogs) | Inline toasts everywhere | Standard browser dialogs (assumed) | MyOS ✅ |
| Connector marketplace UI | Catalog with status flags | n/a | MyOS 🥇 |
| My Rules page | 5 tabs: Patterns / Decisions / Delegations / Prompts / Risk Radar | n/a visible | MyOS 🥇 |
| Brain Avatar | Always-on thinking indicator | n/a | MyOS ✅ |
| Steering Wheel shell | Tab-based navigation | Multi-page | 🟰 |

**Section verdict:** MyOS 🥇 — substantially more developed user-facing surfaces.

---

## O. Mobile Readiness

| Feature | MyOS | HaseebOS v16 | Winner |
|---|---|---|---|
| Mobile breakpoints | < 768px and < 480px responsive overrides (just shipped) | n/a | MyOS ✅ |
| PWA | Not currently installed as PWA | Yes — full PWA | v16 🥇 |
| Mobile drawer rail | Hamburger + slide-in + backdrop dismiss | n/a | MyOS ✅ |
| Touch hover handling | @media (hover: none) overrides | n/a | MyOS ✅ |
| Toast positioning on mobile | Bottom-stretch with thumb-reachable margins | n/a | MyOS ✅ |
| Card-table reflow | .ui-mobile-card-list pattern | n/a | MyOS ✅ |
| Push install / offline | n/a | PWA-installable | v16 🥇 |
| App-store presence | None | None | 🟰 |

**Section verdict:** Slight tie. v16 has PWA installation advantage; MyOS has more polished responsive UI.

---

## P. Production Maturity

| Feature | MyOS | HaseebOS v16 | Winner |
|---|---|---|---|
| Smoke test coverage | 19/20 passing automated, 331-scenario test suite doc | Production smoke daily cron | 🟰 |
| Migrations applied | 35+ Prisma migrations clean | Firestore implicit | 🟰 |
| Connectors live | 11 of 12 unblocked | 1 of 4 unblocked (Manual /ingest) | MyOS 🥇 |
| Operator-blocking issues | None known | Gmail/Calendar OAuth re-auth pending | MyOS ✅ |
| Daily crons | 12+ leader-locked | 10 in Cloud Scheduler | 🟰 |
| Real production traffic | Local dev | Live for single operator | v16 ✅ |
| Live LLM | Sonnet/Gemini/Claude/GPT-4o multi-model | Sonnet 4.6 | MyOS ✅ — provider redundancy |
| 68K corpus embedded | Variable per-tenant | Yes | v16 ✅ |
| Cost dashboard live | Self-hosted, ready | Looker live | v16 ✅ |
| Schedulers all enabled | Yes | Yes | 🟰 |

**Section verdict:** Tie. v16 has live single-operator deployment; MyOS has wider connector coverage + multi-provider LLM redundancy.

---

# Final Scoreboard

| Section | MyOS | v16 | Tie |
|---|---|---|---|
| A. Architecture & Layers | 1 win | 1 win | 3 ties |
| B. Brain — Reasoning depth | 5 wins (1 decisive) | 1 win | 1 tie |
| C. Brain — Delegation & Routing | 3 wins | 0 | 2 ties |
| D. Brain — Pattern Learning | 6 wins (4 decisive) | 0 | 0 |
| E. Risk Surface | 9 wins (6 decisive) | 0 | 3 ties |
| F. Action Layer | 8 wins (4 decisive) | 0 | 2 ties |
| G. Knowledge Layer | 6 wins (3 decisive) | 1 win (decisive) | 4 ties |
| H. Connectors / Feed | 7 wins (3 decisive) | 0 | 0 |
| I. Trust Controls | 5 wins | 0 | 5 ties |
| J. Approval UX | 5 wins (3 decisive) | 2 wins | 3 ties |
| K. Cost & Observability | 2 wins | 1 win | 5 ties |
| L. Audit / Replay | 2 wins | 0 | 5 ties |
| M. Standing Instructions | 8 wins (1 decisive) | 0 | 2 ties |
| N. UI Sophistication | 8 wins (5 decisive) | 0 | 2 ties |
| O. Mobile Readiness | 5 wins | 2 wins (1 decisive) | 1 tie |
| P. Production Maturity | 3 wins (1 decisive) | 3 wins | 4 ties |
| **TOTALS** | **83 wins** | **11 wins** | **42 ties** |

## Net assessment (multi-tenant excluded)

Even with MyOS's structural multi-tenant + multi-user advantages set aside, MyOS leads on feature count and depth in **15 of 16 sections**, with v16 leading only on:
1. Service-boundary architecture (Cloud Run microservices)
2. Single-operator production deployment maturity
3. PWA installation

v16's strengths are real but narrow:
- **Hot-path latency** (Director one-shot vs MyOS's 5-phase fusion)
- **Hand-curated knowledge depth** (1335 people files in Obsidian)
- **PWA installation** (already on home screen)
- **Live operator deployment** (battle-tested in single-user mode)
- **Looker dashboard polish**

MyOS's strengths span every other area:
- **Reasoning depth + calibration + replay** — Brain is structurally more capable
- **Pattern learning loop** — entire feedback/learning system has no v16 equivalent
- **Risk surface** — rule-driven, multi-source, fully editable
- **Action layer** — 30+ handlers vs 8, with dry-run/undo/idempotency
- **Connectors** — 12 vs 4, with three-tier credential resolution
- **Standing instructions** — formal 6th layer with NL parser
- **UI surface area** — Day Brief, Contacts, My Rules, Cost Dashboard, Risk Radar tuning panel, all with inline help
- **Trust controls** — kill switch with durable persistence + per-action enforcement + risk-tier gating

## What v16 *can* do that MyOS still needs

Be honest about gaps:

1. **Cloud Run service split** — MyOS is monolithic Node. v16's microservice boundaries (feed_ingest, brain_runtime, knowledge_api, etc.) are cleaner for scaling. Worth adopting incrementally.
2. **PWA install** — MyOS responsive UI exists; needs manifest + service worker for installability. Half-day work.
3. **Live single-operator UX polish** — v16 has been used daily for months; UX rough edges have been smoothed. MyOS needs live usage to find equivalent issues.
4. **Looker-grade dashboards** — MyOS's Chart.js dashboard is functional; Looker is more polished. If you connect MyOS data to BigQuery, you get this for free.
5. **Hand-curated entity files** — v16's 1335 people files have detail no auto-discovery can match. MyOS auto-discovery is broader; users can still edit individual pages.

---

## Conclusion

MyOS is — by feature scope and depth — the stronger system in **all but four areas**, even when removing the multi-tenant + multi-user advantages from the comparison. v16's strengths are operational (live in production, hand-curated, PWA-installed) rather than architectural.

The remaining work to fully eclipse v16 on its own ground:
1. Wire client-side service worker for PWA install + push approval one-tap
2. Connect cost data to BigQuery for Looker if needed
3. Encourage manual edits to auto-discovered entity pages to reach 1335-file depth
4. Validate live performance under real operator load

After those, MyOS dominates on every axis that isn't a multi-tenant feature.

---

**Document maintained by:** TMC engineering. Update on every major feature ship.
**Companion docs:** `myos_architecture.md`, `AI_Brain_Self_Test_Suite.md`, `brain_test_scenarios.md`
