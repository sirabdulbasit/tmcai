# Cost Analysis — HaseebOS v15 vs MyOS (Current) vs MyOS (Post-Rebuild)

**Version:** 1.2 — 2026-04-17
**Purpose:** Compare the monthly running cost of (a) HaseebOS v15 as specced, (b) current TMCAI/MyOS production as it runs today, and (c) the post-rebuild TMCAI that implements HaseebOS v15 under Migration Option C.
**Source:**
- HaseebOS costs: `cowork-analysis/HaseebOS_Implementation_Plan.xlsx` (GCP Infrastructure sheet, row 118) + v15 spec LLM call-volume estimates.
- MyOS current: derived from [server/.env](../../server/.env), [docker-compose.yml](../../docker-compose.yml), and [package.json](../../server/package.json).
- Post-rebuild: HaseebOS GCP costs + MyOS preserved costs, minus overlap.

---

## 0. TMC Constraints (update v1.1)

Three resources that change the math materially:

1. **$14,000 GCP credit available.** Covers all billable Google services (Cloud Run, Pub/Sub, BigQuery, Memorystore, GCS, Vertex AI / Gemini, Cloud Functions, Monitoring, VPC, Secret Manager).
2. **Gemini (via Vertex AI) is the sole LLM provider.** All LLM calls — brain, workers, chat, RAG re-rank, embeddings — go through Gemini on GCP. **Zero spend on Anthropic, OpenAI, Groq, or OpenRouter.** Existing non-Google LLM code paths in TMCAI become dead code and will be removed or feature-flagged off.
3. **Ubuntu machine with Postgres already running.** Can host Postgres + Redis self-hosted, removing Cloud SQL and Memorystore from the GCP bill.

**Net effect:** Every operational cost except a handful of small third-party APIs (WhatsApp Meta, weather, news) bills to GCP credit. Effective out-of-pocket during the credit window drops to **~$50–150/mo** instead of the ~$325/mo assumed in v1.1.

Assumptions applied:
- Self-hosted Postgres + Redis on Ubuntu for dev and tenants 1–5.
- **LLM routing: Gemini Pro for Brain Orchestrator, Gemini Flash for all 6 worker agents.** This matches the v15 spec and is ~12× cheaper than running workers on Pro. If TMC decides to run everything on Pro instead, see §3.6 for the delta.
- Credit consumed linearly; $14K ÷ monthly GCP bill = runway in months.
- Non-Google LLM providers disabled in the post-rebuild code.

---

## 1. Assumptions

All figures are **monthly USD**, order-of-magnitude estimates, not quoted prices. GCP prices from January 2026 public pricing; LLM prices are approximate and move frequently.

| Variable | HaseebOS v15 (spec) | MyOS current | MyOS post-rebuild |
|---|---|---|---|
| Tenants | 1 (Abdul only) | Multi-tenant (assume 5 active) | Multi-tenant (assume 5 active) |
| Users per tenant | 1 | ~3 avg | ~3 avg |
| Events ingested/day/tenant | 500 | ~300 | ~500 (feed capture adds volume) |
| Agent calls/day/tenant | ~1,500 (3-agent chain × 500 events) | ~200 (chat + scheduled jobs) | ~1,500 (matches spec) |
| Avg LLM tokens/call | 5,000 (4K in + 1K out) | 6,000 (heavier RAG context) | 5,500 |
| Primary LLM | Gemini 3.1 Pro + Flash | Claude Sonnet 4 + Gemini + mixed | **Gemini 3.1 Pro (Brain) + Flash (workers) only — via Vertex AI, billed to GCP credit** |
| Hosting | Vertex AI Agent Engine + Cloud Run | 1× Cloud Run (monolith) + PM2 fork | 2× Cloud Run (Platform + Agents) |

**LLM price assumptions (per 1M tokens, USD):**

| Model | Input | Output |
|---|---|---|
| Gemini 3.1 Pro | $1.25 | $5.00 |
| Gemini 3.1 Flash | $0.075 | $0.30 |
| Claude Sonnet 4 | $3.00 | $15.00 |
| GPT-4o | $2.50 | $10.00 |
| Groq Llama 4 | $0.30 | $0.60 |
| OpenRouter free tier | $0 | $0 |

---

## 2. HaseebOS v15 — Cost (Single User, as Specced)

From cowork analysis + LLM volume math for 1 user.

### 2.1 GCP Infrastructure

| Category | Low | High | Detail |
|---|---|---|---|
| Pub/Sub (4 topics + 4 DLQs) | $40 | $135 | feed.raw, openitems.scored, actions.approved, steering.snapshot |
| BigQuery (3 datasets + export jobs) | $40 | $180 | decision_archive, shadow_evaluation, steering_analytics |
| Memorystore Redis (Standard HA, 1–5 GB) | $50 | $150 | kill switch, idempotency, circuit breakers, rate limits |
| Cloud Storage (3 buckets) | $2 | $15 | golden datasets, doc uploads, BQ staging |
| Cloud Run (agent worker + API) | $100 | $500 | 2× services, autoscale 1–10 instances |
| Cloud Functions (BQ export) | $5 | $20 | Nightly incremental export |
| Monitoring + Logging | $20 | $80 | Custom dashboard, 7+ alerts, BQ log sink |
| VPC + IAM + Secret Manager | $11 | $35 | VPC connector, SAs, secrets |
| **Subtotal GCP** | **$268** | **$1,115** | |

### 2.2 LLM Costs (Gemini only)

- **Brain Orchestrator (Gemini 3.1 Pro):** ~500 calls/day (one per triaged event) × 5K tokens = 2.5M tokens/day split 80/20 in/out
  - Input: 2.0M/day × 30 × $1.25/1M = **$75/mo**
  - Output: 0.5M/day × 30 × $5.00/1M = **$75/mo**
- **Workers (Gemini 3.1 Flash × 6 agents):** ~1,000 calls/day × 3K tokens = 3M tokens/day
  - Input: 2.4M/day × 30 × $0.075/1M = **$5/mo**
  - Output: 0.6M/day × 30 × $0.30/1M = **$5/mo**
- **Memory Bank writes + embedding:** ~$10/mo

**LLM subtotal:** **~$170/mo** (single user)

### 2.3 Third-party APIs

- TMC Context + KNOW (internal, no external cost)
- WhatsApp Business API: ~$0.005/message × 500/day × 30 = **~$75/mo** (conversation pricing varies by region)
- Meta Cloud API: free tier likely covers 1 user
- News / Weather: Abdul's WeatherAPI key already paid (~$0–10/mo)

**Third-party subtotal:** **~$75–85/mo**

### 2.4 HaseebOS v15 Total (1 user)

| Category | Low | High |
|---|---|---|
| GCP Infrastructure | $268 | $1,115 |
| LLM (Gemini Pro + Flash) | $150 | $200 |
| Third-party APIs | $75 | $85 |
| **Total** | **$493** | **$1,400** |

**Midpoint: ~$950/mo for 1 user.**

---

## 3. MyOS Current (TMCAI Today) — Cost

Rough estimate based on what's actually provisioned and used.

### 3.1 Infrastructure (current)

| Category | Monthly | Detail |
|---|---|---|
| Hosting (single Cloud Run or VPS for monolith) | $50–150 | Express + PM2 fork mode, 1 GB heap |
| Postgres (Cloud SQL small instance) | $50–100 | Single instance, no HA, no read replica |
| Redis (provisioned but unused by app code) | ~$0 | Docker Compose — only idle LRU cache; no Memorystore |
| GCS (document uploads) | $5–20 | Existing uploaded documents |
| Secret Manager | $1–3 | Few secrets |
| Monitoring (basic) | $0–10 | Default Cloud Monitoring |
| **Subtotal** | **$106–283** | |

### 3.2 GCP Services (actually called)

| Category | Monthly | Detail |
|---|---|---|
| BigQuery reads (business data queries) | $10–40 | From `bigQueryConnector` — reads only |
| Vertex AI embeddings | $5–20 | RAG pipeline embeddings |
| Google Cloud Speech / TTS (optional voice) | $0–15 | If voice features enabled |
| **Subtotal** | **$15–75** | |

### 3.3 LLM Costs (multi-provider, 5 tenants × 3 users × 200 calls/day avg)

~3,000 calls/day × 6K tokens = 18M tokens/day = 540M tokens/mo

Split across providers (rough from env + tier system):
- **Claude Sonnet 4 (~30%):** 162M tokens → 130M in × $3/1M + 32M out × $15/1M = $390 + $480 = **$870/mo**
- **Gemini Flash (~35%):** 189M tokens → 150M in × $0.075 + 38M out × $0.30 = $11 + $11 = **$22/mo**
- **GPT-4o (~15%):** 81M tokens → 65M in × $2.50 + 16M out × $10 = $163 + $160 = **$323/mo**
- **Groq (~15%):** 81M tokens → $48/mo
- **OpenRouter free (~5%):** $0

**LLM subtotal:** **~$1,260/mo** across 5 tenants (~$252/tenant)

### 3.4 Third-party APIs

- WeatherAPI: $0 (free tier or very cheap)
- NewsAPI: $0 (free) to $50 (paid tier)
- WhatsApp (WebjsProvider used — no API cost, only infra): $0
- Anthropic + OpenAI + Groq + OpenRouter accounts (already in LLM)

**Third-party subtotal:** **~$0–50/mo**

### 3.5 MyOS Current Total (5 tenants, ~15 users)

| Category | Monthly |
|---|---|
| Infrastructure | $106–283 |
| GCP services (reads, embeddings) | $15–75 |
| LLM (multi-provider) | $1,200–1,400 |
| Third-party APIs | $0–50 |
| **Total** | **$1,321–1,808** |

**Midpoint: ~$1,560/mo for 5 tenants ≈ $310/tenant/mo.**

---

## 4. MyOS Post-Rebuild (TMCAI + v15 features) — Cost

Migration Option C preserves TMCAI's multi-tenant platform; adds HaseebOS v15 GCP infra and 7-agent ADK layer.

### 4.1 Infrastructure (shared across tenants)

| Category | Low | High | Delta vs current | Notes |
|---|---|---|---|---|
| Cloud Run (Platform API) | $100 | $300 | +$50 | Slightly larger; handles Pub/Sub webhooks |
| Cloud Run (Agent Worker — new) | $150 | $500 | +$150–500 | NEW. Min 1 instance, max 10 |
| Cloud SQL HA (primary + standby + replica) | $200 | $400 | +$150 | Upgrade from single-instance |
| Memorystore Redis (now used) | $50 | $150 | +$50–150 | NEW actual usage |
| Pub/Sub (4 topics + DLQs) | $40 | $135 | +$40 | NEW |
| BigQuery (archive + analytics) | $40 | $180 | +$30 | Extends current read usage with writes |
| Cloud Storage (golden datasets + staging) | $5 | $20 | +$3 | +2 new buckets |
| Cloud Functions (BQ export) | $5 | $20 | +$5 | NEW |
| Monitoring + Logging | $25 | $100 | +$20 | Expanded coverage |
| VPC + IAM + Secrets | $11 | $35 | +$10 | Plus 2 new SAs |
| **Subtotal shared infra** | **$626** | **$1,840** | **+$508 to +$1,572** | |

### 4.2 LLM Costs (per tenant, v15-aligned, Gemini-only)

All LLM calls route to Gemini via Vertex AI → GCP credit. No Claude/GPT fallback spend.

Per tenant (3 users, 500 events/day triaged, 1,500 agent calls/day):
- **Brain Orchestrator (Gemini Pro) — 500 calls/day/tenant × 5K tokens:**
  - 2M in/day × 30 × $1.25/1M = $75
  - 0.5M out/day × 30 × $5/1M = $75
  - = **$150/tenant/mo**
- **Workers (Gemini Flash × 6 agents) — 1,000 calls/day/tenant × 3K tokens:**
  - 2.4M in × 30 × $0.075 = $5
  - 0.6M out × 30 × $0.30 = $5
  - = **$10/tenant/mo**
- **Embeddings + Memory Bank:** ~$15/tenant/mo (all via Vertex AI)

**LLM per tenant: ~$175/mo, all billed to GCP credit.** For 5 tenants: **~$875/mo GCP credit draw, $0 cash.**

### 4.3 Alternative — All-Pro routing (if TMC chooses)

If every agent uses Gemini Pro (not the spec'd Pro+Flash split):

Per tenant (1,500 calls/day × 5K tokens):
- Input: 6M/day × 30 × $1.25/1M = $225
- Output: 1.5M/day × 30 × $5/1M = $225
- = **$450/tenant/mo**

For 5 tenants: **~$2,250/mo GCP credit draw.** That's 2.6× the Pro+Flash split and burns the $14K credit in ~4 months instead of ~7.

**Recommendation:** keep the spec's split. Worker agents do narrow, well-structured tasks — Flash is fit-for-purpose and you lose very little quality.

### 4.4 Third-party APIs

| Category | Monthly | Delta |
|---|---|---|
| WhatsApp Business (Meta only after dropping WebjsProvider) | $50–200 | +$50–200 |
| WeatherAPI / NewsAPI | $0–50 | unchanged |
| **Subtotal** | **$50–250** | **+$50–200** |

### 4.5 MyOS Post-Rebuild Total (5 tenants, Gemini-only via Vertex AI)

| Category | Low | High | Billing |
|---|---|---|---|
| Shared infrastructure | $626 | $1,840 | GCP credit |
| LLM (Gemini Pro+Flash, 5 tenants) | $800 | $950 | GCP credit |
| Third-party APIs (non-Google) | $50 | $250 | Cash out-of-pocket |
| **Total** | **$1,476** | **$3,040** | — |
| **Of which GCP-credit-covered** | $1,426 | $2,790 | |
| **Cash out-of-pocket** | $50 | $250 | |

**Midpoint: ~$2,250/mo total for 5 tenants ≈ $450/tenant/mo.** Of that, **~$100/mo is cash** (the rest is credit-covered).

If Pro-only routing (§4.3) is used: total rises to ~$3,625/mo, GCP draw ~$3,575, cash still ~$50–100.

---

## 5. Side-by-Side Comparison

### 5.1 Monthly Totals

| Scenario | Users | Sticker total | Cash out-of-pocket | GCP credit draw |
|---|---|---|---|---|
| **HaseebOS v15 (spec, single user)** | 1 | ~$950 | $75 (WhatsApp) | $875 |
| **MyOS current (5 tenants × 3 users, Claude+GPT mix)** | ~15 | ~$1,560 | $1,260 | $300 |
| **MyOS post-rebuild, full GCP (Cloud SQL HA)** | ~15 | ~$2,790 | $50–$250 | $2,540 |
| **MyOS post-rebuild, self-hosted DB+Redis on Ubuntu** | ~15 | ~$2,250 | $50–$250 | $2,000 |
| **MyOS post-rebuild, all Gemini Pro (not spec split)** | ~15 | ~$3,625 | $50–$250 | $3,375 |

### 5.2 Cost Delta — Current vs Post-Rebuild

| Category | Current | Post-rebuild | Delta | Driver |
|---|---|---|---|---|
| Hosting (Cloud Run) | $50–150 | $250–800 | +$200–650 | Added Agent Worker service |
| Database | $50–100 | $200–400 | +$150–300 | Upgrade to HA + replica |
| Redis | ~$0 | $50–150 | +$50–150 | Now actually used |
| Pub/Sub | $0 | $40–135 | +$40–135 | NEW |
| BigQuery | $10–40 | $40–180 | +$30–140 | Writes + archive |
| Cloud Run Agent Worker | $0 | $150–500 | +$150–500 | NEW service |
| Cloud Functions | $0 | $5–20 | +$5–20 | NEW BQ export |
| Monitoring / IAM / VPC | $1–13 | $36–135 | +$35–122 | Broader coverage |
| **Infra delta** | — | — | **+$660–$2,020** | |
| LLM | $1,260 | $1,125 | **–$135** | Gemini-first saves ~10% |
| Third-party | $0–50 | $50–250 | +$50–200 | Meta WhatsApp real traffic |
| **Net Delta** | — | — | **+$575–$2,085** | |

**Short version:** The rebuild adds roughly **$600–$2,000/mo** of infrastructure on top of MyOS-current, partially offset by a small LLM saving from Gemini-first routing.

### 5.3 Cost Delta — HaseebOS (1 user) vs Post-Rebuild (5 tenants)

Per-user cost falls dramatically when TMCAI's multi-tenant amortization is preserved:

- HaseebOS single user: **$950/user**
- Post-rebuild per user: **$169/user** (5 tenants × 3 users)

This is the single biggest reason to choose Migration Option C: **you get v15 compliance without the v15 single-user cost structure.**

### 5.4 Break-even: how many tenants justify the rebuild?

With shared infra of ~$1,230/mo midpoint + $225/tenant LLM:

- **1 tenant** (HaseebOS-like): $1,455/mo
- **3 tenants:** $1,905/mo → $635/tenant
- **5 tenants:** $2,355/mo → $471/tenant
- **10 tenants:** $3,480/mo → $348/tenant
- **20 tenants:** $5,730/mo → $287/tenant

Break-even vs current MyOS ($312/tenant) is around **8–9 tenants**. Below that, the rebuild costs more per tenant; above that, it's cheaper.

With self-hosted DB + Redis on Ubuntu (~$650/mo infra savings), break-even drops to **~4–5 tenants**.

### 5.5 Self-Hosted Postgres + Redis Savings (Ubuntu machine)

| Component | Cloud SQL HA + Memorystore | Self-hosted on Ubuntu | Saving |
|---|---|---|---|
| Postgres HA (primary + standby + replica) | $200–$400 | $0 (sunk cost, existing machine) | $200–$400 |
| Memorystore Redis (Standard HA, 1 GB) | $50–$150 | $0 (same Ubuntu box) | $50–$150 |
| Backups (Cloud SQL automated) | included | ~$10 (GCS bucket, pg_dump nightly) | — |
| **Monthly saving** | — | — | **$240–$540** |

**Caveats (flag for later migration):**
- Ubuntu machine is single-point-of-failure. One bad reboot or disk failure = downtime.
- No automatic point-in-time-recovery unless WAL archiving is set up to GCS (recommended: add this).
- Memory contention if DB + Redis + any other services share the same box.
- When TMC signs a customer with an uptime SLA (e.g. 99.9%), plan to migrate to Cloud SQL HA — at that point the savings narrow to just Redis (~$50–150/mo).

**Recommendation:** Stay self-hosted through Phase 7 supervised dry-run. Migrate to Cloud SQL HA the month before the first paying customer goes live, not before.

### 5.6 GCP Credit Runway ($14K, Gemini-only LLM)

| Scenario | GCP monthly draw | Cash/mo | Credit runway | After credit |
|---|---|---|---|---|
| HaseebOS v15 (1 user) | $875 | $75 | **~16 months** | $950/mo total |
| MyOS current (5 tenants, Claude+GPT) | $300 | $1,260 | ~47 months | (cash burn continues) |
| MyOS post-rebuild, full GCP (Cloud SQL HA) | $2,540 | $50–250 | **~5.5 months** | $2,790/mo total |
| **MyOS post-rebuild, self-hosted DB+Redis** | **$2,000** | **$50–250** | **~7 months** | **$2,250/mo total** |
| MyOS post-rebuild, all-Pro routing | $3,375 | $50–250 | ~4.2 months | $3,625/mo total |

**Runway interpretation:**
- **Recommended path (self-hosted DB + Pro/Flash split) stretches credit to ~7 months.**
- Switching to all-Pro cuts runway by ~40% for modest quality gains on worker agents — not worth it.
- The credit window aligns with Phases 1–5 of the implementation plan (~16 weeks for foundation → agents → service extensions).

### 5.7 Effective Monthly Cash Cost During Credit Period

With Gemini-only routing, the cash burn during the credit window is **just non-Google third-party APIs**:

| Scenario | Cash/mo during credit | After credit depletion |
|---|---|---|
| HaseebOS v15 (1 user) | $75 (WhatsApp) | $950 |
| MyOS current (5 tenants) | $1,260 | $1,560 |
| MyOS post-rebuild, full GCP | $50–250 | $2,790 |
| **MyOS post-rebuild, self-hosted DB** | **$50–250** | **$2,250** |

**The credit + self-hosted DB + Gemini-only combination drops effective cash cost from $1,260 (MyOS today) to ~$150 during the rebuild period — an ~88% reduction** while delivering v15 compliance.

---

## 6. Cost Risks & Wild Cards

| Risk | Potential impact | Mitigation |
|---|---|---|
| **Gemini pricing hike** | $150–$400/mo if Pro doubles | Multi-provider fallback stays in the code — switch workers to OpenRouter free tier or Groq for non-critical paths |
| **Cloud Run agent worker cold starts** | Higher min-instance count → +$100–200/mo | Tune with actual traffic; HaseebOS spec assumes min=1 |
| **BigQuery query cost** (if analytics usage explodes) | $50–300/mo | Flat-rate BQ pricing if query volume >$500/mo |
| **WhatsApp Business API tier change** | $100–300/mo at higher volumes | Conversation-based billing; monitor volume |
| **Pub/Sub volume spike** (feed captures more than 500 events/day) | $100–400/mo | Set quotas, throttle at adapter layer |
| **Memorystore HA tier** | +$100/mo if sized up | Standard HA at 1 GB should suffice for idempotency/kill-switch keys |
| **Third-party LLM providers retire cheaper models** | $200–500/mo on current bill | We already budget Gemini-first; less exposed post-rebuild |

---

## 7. Where TMCAI Saves Money vs a Clean HaseebOS Build

Option C (recommended) preserves several TMCAI assets that a clean HaseebOS rebuild would have to re-buy or re-build:

| TMCAI feature | Cost to rebuild from scratch | Saving by keeping |
|---|---|---|
| Multi-tenant SaaS architecture | 4–6 engineer-weeks | ~$30K (one-time) |
| PII masking with Gemini NER (11 entity types) | 2 engineer-weeks + compliance review | ~$15K (one-time) + legal exposure reduction |
| 50+ connector types (Salesforce, HubSpot, Jira, etc.) | 8–12 engineer-weeks | ~$60K (one-time) |
| RAG pipeline (hybrid search, cross-encoder re-rank, PII-aware) | 4 engineer-weeks | ~$25K (one-time) |
| White-label + API gateway | 3 engineer-weeks | ~$20K (one-time) |
| **One-time savings preserved** | — | **~$150K** |

At 1 engineer-month = ~$15K fully loaded, keeping the TMCAI platform layer represents **~10 months of dev effort preserved** — roughly the entire HaseebOS v15 build timeline.

---

## 8. Recommendation

**Ship Migration Option C.** The operational cost increase (~$600–$2,000/mo on infra) is dwarfed by:
1. The one-time saving of preserving ~10 engineer-months of TMCAI work (§7)
2. The multi-tenant amortization that brings per-user cost from $950 (HaseebOS single-user) to ~$170 (TMCAI with ≥5 tenants)
3. The LLM saving (~$135/mo) from Gemini-first routing

**Recommended cost monitoring plan:**
- Set GCP budget alerts at 50%, 80%, 100% of $3,500/mo ceiling
- Weekly review of BigQuery query spend during the first 8 weeks post-launch
- Monthly LLM token usage review per tenant (already tracked in `tokenUsageService.ts`)
- Reforecast at end of Phase 7 supervised dry-run using actual 4-week data

---

## 9. One-Number Summary

### Sticker price (no credit, 5 tenants)

| | Monthly |
|---|---|
| Keep MyOS as-is | **~$1,560** |
| Build HaseebOS v15 fresh (1 user only) | **~$950** |
| Ship Option C, full GCP (Cloud SQL HA, Gemini only) | **~$2,790** |
| **Ship Option C, self-hosted DB + Gemini only (recommended)** | **~$2,250** |
| Ship Option C, all Gemini Pro (not spec split) | ~$3,625 |

### Effective cash cost during $14K credit window

| | Cash/mo | Credit runway |
|---|---|---|
| Keep MyOS as-is | **~$1,260** | — |
| **Ship Option C + self-hosted DB + Gemini only** | **~$150** | **~7 months on the credit** |

**With your constraints (Gemini-only via GCP + $14K credit + self-hosted Ubuntu DB), the rebuild cash burn during the build window is ~$150/mo — an ~88% reduction from current MyOS.** After the credit depletes (~7 months), run-rate is $2,250/mo total. Break-even with current MyOS is ~5 tenants.

**Recommendation:**
1. Start Phase 1 immediately.
2. Keep Gemini Pro for Brain Orchestrator only; workers on Flash per spec.
3. Consume the GCP credit on Phases 1–5 (foundation → agents → service extensions).
4. Delete or feature-flag-off all Claude/OpenAI/Groq/OpenRouter code paths before Phase 4 so there's no accidental non-Google billing.
5. Delay Cloud SQL HA migration until first paying customer with a documented SLA.
6. Plan customer revenue to start before month 7 so non-credit operations are cash-flow positive.
