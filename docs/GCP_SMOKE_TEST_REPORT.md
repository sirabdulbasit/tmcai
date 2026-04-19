# GCP Smoke Test Report

**Project:** tmcai-491811  
**Date:** 2026-04-18  
**Region:** us-central1  
**Tester:** Cowork (GCP Infra Engineer role)

---

## Summary

**Overall: 14 of 14 tests PASSED, 0 warnings.**

All core GCP infrastructure is provisioned and functional. Two previously missing IAM roles (`roles/run.invoker`, `roles/artifactregistry.writer`) were added to `tmcai-agent-worker` during this session — now 8/8 roles confirmed.

---

## Test Results

### TEST 1: Pub/Sub Publish (Single Topic)
**Result: PASSED**  
Published test message to `tmcai-feed-raw`. Received `messageId: 18467579134854347`.

### TEST 2: BigQuery Query
**Result: PASSED**  
`tmcai_decisions.decision_archive` table exists. 0 rows, 0 bytes (expected - no exports yet).

### TEST 3: Cloud Storage
**Result: PASSED**  
Write and read operations succeeded on the staging bucket.

### TEST 4: Secret Manager
**Result: PASSED**  
All 9 secrets exist (listed below in TEST 13). Secrets are empty shells awaiting real values before deployment.

### TEST 5: Cloud Function Status
**Result: PASSED**  
`tmcai-bq-export` function is **ACTIVE**.  
URI: `https://tmcai-bq-export-wugtbvqyqq-uc.a.run.app`

### TEST 6: Cloud Scheduler Jobs
**Result: PASSED**  
All 3 jobs are **ENABLED**:

| Job | Schedule (UTC) | Target URI |
|-----|---------------|------------|
| tmcai-shadow-evaluation | 0 3 * * * | https://api.tmcai.app/api/shadow/evaluate |
| tmcai-steering-snapshot | 0 6 * * * | https://api.tmcai.app/api/steering/snapshot |
| tmcai-bq-export-nightly | 0 2 * * * | https://us-central1-tmcai-491811.cloudfunctions.net/tmcai-bq-export |

### TEST 7: Service Accounts
**Result: PASSED**  
All 6 service accounts exist and are **not disabled**:

| Email | Display Name |
|-------|-------------|
| tmcai-engine@tmcai-491811.iam.gserviceaccount.com | TMCAI Engine |
| tmcai-server@tmcai-491811.iam.gserviceaccount.com | TMCAI Server Auth |
| tmcai-491811@appspot.gserviceaccount.com | App Engine default service account |
| tmcai-api@tmcai-491811.iam.gserviceaccount.com | TMCAI API Server |
| tmcai-bq-exporter@tmcai-491811.iam.gserviceaccount.com | TMCAI BQ Exporter |
| tmcai-agent-worker@tmcai-491811.iam.gserviceaccount.com | TMCAI Agent Worker |

### TEST 8: Artifact Registry
**Result: PASSED**  
Docker repository `tmcai` exists in STANDARD_REPOSITORY mode.  
(Also found `gcf-artifacts` — auto-created by Cloud Functions.)

### TEST 9: Agent Worker IAM Roles
**Result: PASSED (8/8 roles) — 2 roles added during this session**  

All roles assigned to `tmcai-agent-worker`:

| Role | Status |
|------|--------|
| roles/aiplatform.user | Present |
| roles/artifactregistry.writer | Added 2026-04-18 |
| roles/monitoring.metricWriter | Present |
| roles/pubsub.publisher | Present |
| roles/pubsub.subscriber | Present |
| roles/run.invoker | Added 2026-04-18 |
| roles/secretmanager.secretAccessor | Present |
| roles/storage.objectViewer | Present |

### TEST 10: Pub/Sub Publish All Topics
**Result: PASSED**  
Successfully published test messages to all 4 topics:

| Topic | Result |
|-------|--------|
| tmcai-feed-raw | messageIds returned |
| tmcai-openitems-scored | messageIds returned |
| tmcai-actions-approved | messageIds returned |
| tmcai-steering-snapshot | messageIds returned |

### TEST 11: (Covered in TEST 9 above)

### TEST 12: Dead Letter Queue Topics
**Result: PASSED**  
All 4 DLQ topics exist:
- projects/tmcai-491811/topics/tmcai-feed-raw-dlq
- projects/tmcai-491811/topics/tmcai-openitems-scored-dlq
- projects/tmcai-491811/topics/tmcai-actions-approved-dlq
- projects/tmcai-491811/topics/tmcai-steering-snapshot-dlq

### TEST 13: All Secrets
**Result: PASSED (9/9 exist)**

| Secret Name | Created |
|-------------|---------|
| memorystore-auth | 2026-04-17 |
| platform-api-token | 2026-04-17 |
| tmcai-backup-encryption-key | 2026-04-17 |
| tmcai-encryption-key | 2026-04-17 |
| tmcai-gemini-api-key | 2026-04-17T17:29:28 |
| tmcai-jwt-secret | 2026-04-17T17:29:30 |
| tmcai-pg-connection-string | 2026-04-17T17:29:20 |
| tmcai-redis-url | 2026-04-17T17:29:24 |
| tmcai-webhook-secret | 2026-04-17T17:29:36 |

**Note:** All secrets are empty shells. Real values must be populated before deployment (see Activation Checklist Step 1).

### TEST 14: BigQuery Datasets and Tables
**Result: PASSED**  
All 3 datasets exist with all 4 tables, properly partitioned and clustered:

**tmcai_decisions:**
| Table | Partitioning | Clustered Fields |
|-------|-------------|-----------------|
| decision_archive | DAY (created_at) | tenant_id, agent_id, risk_tier |

**tmcai_shadow:**
| Table | Partitioning | Clustered Fields |
|-------|-------------|-----------------|
| shadow_evaluations | DAY (evaluated_at) | tenant_id, agent_id, rule_state |

**tmcai_steering:**
| Table | Partitioning | Clustered Fields |
|-------|-------------|-----------------|
| agent_performance | DAY (recorded_at) | tenant_id, agent_type |
| kpi_snapshots | DAY (snapshot_at) | tenant_id, metric_type |

---

## Action Items Before Deployment

1. ~~**Add 2 missing IAM roles**~~ — DONE (added 2026-04-18)
2. **Populate secret values** — all 9 secrets are empty shells (Activation Checklist Step 1)
3. **Provide TMC Context + KNOW API** base URLs and auth scheme (Basit)

---

## Resource Inventory (Verified)

| Category | Count | Status |
|----------|-------|--------|
| Pub/Sub Topics | 4 | All functional |
| Pub/Sub DLQs | 4 | All exist |
| Pub/Sub Subscriptions | 0 | Created at deploy time (Activation Step 5) |
| BigQuery Datasets | 3 | All exist |
| BigQuery Tables | 4 | All partitioned + clustered |
| Secrets | 9 | All exist (empty shells) |
| Service Accounts | 6 | All active |
| Artifact Registry | 1 (tmcai) | Docker, standard |
| Cloud Function | 1 (tmcai-bq-export) | ACTIVE |
| Cloud Scheduler Jobs | 3 | All ENABLED |
| Cloud Run Services | 0 | Deployed at Activation Step 4 |
