# GCP Infrastructure Handoff — Cowork → VSCode

> Generated: 2026-04-18 | Project: `tmcai-491811` | Region: `us-central1`

This document answers every infrastructure question VSCode needs to wire up the codebase.

---

## 1. Pub/Sub Topic Names (EXACT — as created in GCP)

### NAMING MISMATCH — MUST FIX

Code (`server/src/config/pubsub.ts` and `agents/src/config.py`) uses **dot-separated** names.
GCP has **`tmcai-` prefixed, hyphenated** names. Two options:

- **Option A (recommended):** Update the 2 config files to match GCP reality
- **Option B:** Delete and recreate topics with dot names in GCP

### Main Topics
| GCP Topic Name | Code Currently Expects | Fix Config To |
|---|---|---|
| `tmcai-feed-raw` | `feed.raw` | `tmcai-feed-raw` |
| `tmcai-openitems-scored` | `openitems.scored` | `tmcai-openitems-scored` |
| `tmcai-actions-approved` | `actions.approved` | `tmcai-actions-approved` |
| `tmcai-steering-snapshot` | `steering.snapshot` | `tmcai-steering-snapshot` |

### DLQ Topics
| GCP DLQ Name | Code Currently Expects |
|---|---|
| `tmcai-feed-raw-dlq` | `feed.raw.dlq` |
| `tmcai-openitems-scored-dlq` | `openitems.scored.dlq` |
| `tmcai-actions-approved-dlq` | `actions.approved.dlq` |
| `tmcai-steering-snapshot-dlq` | `steering.snapshot.dlq` |

### DLQ Monitor Subscriptions
| Subscription Name |
|---|
| `tmcai-feed-raw-dlq-monitor` |
| `tmcai-openitems-scored-dlq-monitor` |
| `tmcai-actions-approved-dlq-monitor` |
| `tmcai-steering-snapshot-dlq-monitor` |

### Files to update (Option A):
```
server/src/config/pubsub.ts        — PUBSUB_TOPICS + PUBSUB_DLQS constants
agents/src/config.py               — topic_* and sub_* defaults
docs/vscode-analysis/HASEEBOS_V15_GCP_ACTIVATION.md — all topic references
```

---

## 2. DLQ Topic Names — Confirmed

See table above. Pattern: `tmcai-{topic-key}-dlq` (e.g. `tmcai-feed-raw-dlq`).

---

## 3. Service Account Emails

| Service Account | Email | Purpose |
|---|---|---|
| TMCAI API Server | `tmcai-api@tmcai-491811.iam.gserviceaccount.com` | Platform Layer (Express server) |
| TMCAI Agent Worker | `tmcai-agent-worker@tmcai-491811.iam.gserviceaccount.com` | Agent Layer (Cloud Run / ADK agents) |
| TMCAI BQ Exporter | `tmcai-bq-exporter@tmcai-491811.iam.gserviceaccount.com` | Cloud Function (PG→BQ nightly export) |

**For `cloudbuild.yaml`:** Use `tmcai-agent-worker@tmcai-491811.iam.gserviceaccount.com`

---

## 4. IAM Roles per Service Account

### tmcai-api (Platform Layer)
- `roles/pubsub.publisher`
- `roles/secretmanager.secretAccessor`
- `roles/storage.objectViewer`
- `roles/monitoring.metricWriter`
- `roles/aiplatform.user`

### tmcai-agent-worker (Agent Layer) — used in cloudbuild.yaml
- `roles/pubsub.publisher`
- `roles/pubsub.subscriber`
- `roles/run.invoker`
- `roles/secretmanager.secretAccessor`
- `roles/aiplatform.user`
- `roles/monitoring.metricWriter`

### tmcai-bq-exporter (Cloud Function)
- `roles/bigquery.dataEditor`
- `roles/bigquery.jobUser`
- `roles/storage.objectAdmin`
- `roles/secretmanager.secretAccessor`

---

## 5. VPC Connector — NOT YET CREATED

`cloudbuild.yaml` references: `projects/tmcai-491811/locations/us-central1/connectors/tmcai-vpc`

**This does not exist yet.** Must be created before Cloud Run deploy.

Required for: Cloud Run agents → Memorystore (Redis) private IP connectivity.

```bash
# Create VPC connector (requires Serverless VPC Access API)
gcloud services enable vpcaccess.googleapis.com
gcloud compute networks vpc-access connectors create tmcai-vpc \
  --region=us-central1 \
  --range=10.8.0.0/28 \
  --min-instances=2 \
  --max-instances=3
```

**Decision needed:** Only required if using Memorystore Redis. If agents connect to the Ubuntu server's Redis directly over public IP, VPC connector is not needed and the `--vpc-connector` flag can be removed from cloudbuild.yaml.

---

## 6. Memorystore Redis — NOT YET CREATED

**This does not exist yet.** Two approaches:

### Option A: Use Memorystore (managed Redis) — ~$50-73/mo
```bash
gcloud redis instances create tmcai-redis \
  --size=1 \
  --region=us-central1 \
  --tier=basic \
  --redis-version=redis_7_0
```
After creation, get the private IP:
```bash
gcloud redis instances describe tmcai-redis --region=us-central1 --format="value(host)"
```

### Option B: Use Ubuntu server's Redis (BullMQ approach) — $0/mo
The platform already runs Redis locally on the Ubuntu server. Cloud Run agents can connect via public endpoint. This was the **recommended approach** in the cost analysis (saves ~$60/mo, extends credit runway).

**If Option B:** Remove `--vpc-connector` from cloudbuild.yaml, set `REDIS_HOST` to Ubuntu server's public IP.

---

## 7. BigQuery PG→BQ Export Cloud Function — CODE EXISTS, NOT DEPLOYED

The Cloud Function code exists at:
```
infra/functions/bq-export/index.js      — Node.js 20 runtime
infra/functions/bq-export/package.json   — @google-cloud/bigquery, pg, etc.
```

**Not yet deployed to GCP.** Deployment command:
```bash
gcloud functions deploy tmcai-bq-export \
  --gen2 \
  --runtime=nodejs20 \
  --region=us-central1 \
  --source=./infra/functions/bq-export \
  --entry-point=exportDecisionsToBQ \
  --trigger-http \
  --service-account=tmcai-bq-exporter@tmcai-491811.iam.gserviceaccount.com \
  --memory=512Mi \
  --timeout=540 \
  --set-secrets=PG_CONNECTION_STRING=tmcai-pg-connection-string:latest
```

After deployment, update the scheduler job URI:
```bash
gcloud scheduler jobs update http tmcai-bq-export-nightly \
  --location=us-central1 \
  --uri=https://ACTUAL_FUNCTION_URL
```

**BigQuery resources ARE live:**
- 3 datasets: `tmcai_decisions`, `tmcai_shadow`, `tmcai_steering`
- 4 tables: `decision_archive` (21 cols, partitioned by created_at, clustered by tenant_id/agent_id/risk_tier), `shadow_evaluations`, `kpi_snapshots`, `agent_performance`

---

## 8. Secret Manager Secret Names

### Created in GCP (7 secrets, all empty — need values):
| Secret Name | Purpose |
|---|---|
| `tmcai-pg-connection-string` | PostgreSQL connection URI |
| `tmcai-redis-url` | Redis connection URL |
| `tmcai-gemini-api-key` | Vertex AI / Gemini API key |
| `tmcai-jwt-secret` | JWT signing secret |
| `tmcai-encryption-key` | AES-256 PII encryption key |
| `tmcai-webhook-secret` | HMAC webhook validation |
| `tmcai-backup-encryption-key` | GCS backup file encryption |

### MISSING — cloudbuild.yaml expects these but they don't exist:
| Secret Name (expected) | Must Create |
|---|---|
| `platform-api-token` | YES — used in `--set-secrets` for agent→platform auth |
| `memorystore-auth` | YES — used in `--set-secrets` for Redis auth |

**Fix:** Either create these 2 new secrets, OR update cloudbuild.yaml to use existing names:
```yaml
# Option: rename in cloudbuild.yaml to use existing secrets
--set-secrets=PLATFORM_API_TOKEN=tmcai-jwt-secret:latest,REDIS_AUTH=tmcai-redis-url:latest
```

---

## 9. Artifact Registry — NOT YET CREATED

`cloudbuild.yaml` references: `us-central1-docker.pkg.dev/tmcai-491811/tmcai/agents:latest`

**This repo does not exist yet.** Create it:
```bash
gcloud services enable artifactregistry.googleapis.com
gcloud artifacts repositories create tmcai \
  --repository-format=docker \
  --location=us-central1 \
  --description="TMCAI Docker images"
```

Full URI after creation: `us-central1-docker.pkg.dev/tmcai-491811/tmcai`

---

## 10. TMC Context + KNOW Endpoint URLs — NOT GCP, EXTERNAL

These are external knowledge endpoints that the `external_knowledge.py` agent calls. They are **not part of GCP infrastructure** — they depend on your external data sources.

**Current state:** Placeholder `TODO` in the agent code.

**What's needed:**
- Base URL for the TMC knowledge API
- Auth scheme (Bearer token? mTLS? API key?)
- Endpoint paths for document search, entity lookup, etc.

**This is something you (Basit) need to provide** based on whatever knowledge base TMC uses (could be Notion, internal wiki, vector DB, etc.).

---

## Cloud Scheduler Jobs (all ENABLED)

| Job Name | Schedule | URI |
|---|---|---|
| `tmcai-bq-export-nightly` | `0 2 * * *` UTC | placeholder (update after function deploy) |
| `tmcai-shadow-evaluation` | `0 3 * * *` UTC | `https://api.tmcai.app/api/shadow/evaluate` |
| `tmcai-steering-snapshot` | `0 6 * * *` UTC | `https://api.tmcai.app/api/steering/snapshot` |

---

## Cloud Storage Buckets

| Bucket | Purpose | Lifecycle |
|---|---|---|
| `tmcai-491811-golden-datasets` | Versioned golden datasets for shadow eval | Versioned |
| `tmcai-491811-bq-staging` | Temp staging for BQ exports | Auto-delete 7 days |
| `tmcai-491811-backups` | Server backups | Nearline→Coldline@90d, delete@365d |
| `tmcai-491811-function-source` | Cloud Function source archives | — |

---

## Summary: What's LIVE vs What's MISSING

### LIVE in GCP (ready to use)
- 13 APIs enabled
- 3 service accounts + 15 IAM bindings
- 8 Pub/Sub topics (4 main + 4 DLQ) + subscriptions
- 3 BigQuery datasets + 4 partitioned/clustered tables
- 4 Cloud Storage buckets with lifecycle policies
- 7 Secret Manager secrets (empty shells)
- 3 Cloud Scheduler jobs (ENABLED)
- 1 App Engine app (for Scheduler)

### CREATED (gap filled 2026-04-18)
1. ~~**Artifact Registry repo** (`tmcai`)~~ — DONE: `us-central1-docker.pkg.dev/tmcai-491811/tmcai`
2. ~~**2 missing secrets** (`platform-api-token`, `memorystore-auth`)~~ — DONE: both created (empty, need values)
3. ~~**Artifact Registry IAM**~~ — DONE: `tmcai-agent-worker` granted `roles/artifactregistry.writer`
4. ~~**VPC Access API**~~ — DONE: `vpcaccess.googleapis.com` enabled

### STILL NEEDED
5. **Deploy BQ export Cloud Function** (code exists, not deployed)

### DECISION NEEDED (affects architecture)
4. **VPC Connector** — only if using Memorystore
5. **Memorystore Redis** — vs Ubuntu Redis (recommended: skip, use Ubuntu Redis)
6. **External Knowledge URLs** — Basit must provide

### CODE FIX NEEDED
7. **Pub/Sub topic names** — update `pubsub.ts` + `config.py` to use `tmcai-*` prefix names
