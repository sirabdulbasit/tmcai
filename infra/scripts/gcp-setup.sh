#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# HaseebOS v15 — GCP Infrastructure Quick Setup
# Alternative to Terraform: run directly in Cloud Shell or terminal
# Project: tmcai-491811
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

PROJECT_ID="tmcai-491811"
REGION="us-central1"
ALERT_EMAIL="basit.ahmed@tmcltd.ai"

echo "═══════════════════════════════════════════════════"
echo " HaseebOS v15 — GCP Infrastructure Setup"
echo " Project: $PROJECT_ID  |  Region: $REGION"
echo "═══════════════════════════════════════════════════"

# ───────────────────────────────────────
# 0. Set project & enable APIs
# ───────────────────────────────────────
echo ""
echo "▸ Step 1/8: Setting project & enabling APIs..."
gcloud config set project $PROJECT_ID

APIS=(
  pubsub.googleapis.com
  bigquery.googleapis.com
  bigquerydatatransfer.googleapis.com
  storage.googleapis.com
  cloudfunctions.googleapis.com
  cloudscheduler.googleapis.com
  secretmanager.googleapis.com
  monitoring.googleapis.com
  logging.googleapis.com
  cloudbuild.googleapis.com
  run.googleapis.com
  aiplatform.googleapis.com
  vpcaccess.googleapis.com
  iam.googleapis.com
)

for api in "${APIS[@]}"; do
  echo "  Enabling $api..."
  gcloud services enable "$api" --quiet
done
echo "  ✓ All APIs enabled"

# ───────────────────────────────────────
# 1. Service Accounts
# ───────────────────────────────────────
echo ""
echo "▸ Step 2/8: Creating service accounts..."

# API Server SA
gcloud iam service-accounts create tmcai-api \
  --display-name="TMCAI API Server" \
  --description="Platform Layer: Express API, Pub/Sub publisher, Vertex AI user" \
  2>/dev/null || echo "  tmcai-api already exists"

for role in roles/pubsub.publisher roles/secretmanager.secretAccessor roles/storage.objectViewer roles/monitoring.metricWriter roles/aiplatform.user; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:tmcai-api@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="$role" --quiet --no-user-output-enabled
done

# Agent Worker SA
gcloud iam service-accounts create tmcai-agent-worker \
  --display-name="TMCAI Agent Worker" \
  --description="Agent Layer: 7 ADK agents, Pub/Sub sub, Vertex AI caller" \
  2>/dev/null || echo "  tmcai-agent-worker already exists"

for role in roles/pubsub.subscriber roles/pubsub.publisher roles/aiplatform.user roles/secretmanager.secretAccessor roles/storage.objectViewer roles/monitoring.metricWriter; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:tmcai-agent-worker@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="$role" --quiet --no-user-output-enabled
done

# BQ Exporter SA
gcloud iam service-accounts create tmcai-bq-exporter \
  --display-name="TMCAI BigQuery Exporter" \
  --description="Cloud Function: nightly PG→BQ export" \
  2>/dev/null || echo "  tmcai-bq-exporter already exists"

for role in roles/bigquery.dataEditor roles/bigquery.jobUser roles/storage.objectAdmin roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:tmcai-bq-exporter@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="$role" --quiet --no-user-output-enabled
done

echo "  ✓ 3 service accounts created with roles"

# ───────────────────────────────────────
# 2. Pub/Sub Topics + DLQs + Subscriptions
# ───────────────────────────────────────
echo ""
echo "▸ Step 3/8: Creating Pub/Sub topics..."

TOPICS=("feed-raw" "openitems-scored" "actions-approved" "steering-snapshot")

for topic in "${TOPICS[@]}"; do
  # DLQ topic
  gcloud pubsub topics create "tmcai-${topic}-dlq" \
    --message-retention-duration=7d \
    --labels=app=tmcai,type=dead-letter \
    2>/dev/null || echo "  tmcai-${topic}-dlq already exists"

  # DLQ subscription
  gcloud pubsub subscriptions create "tmcai-${topic}-dlq-monitor" \
    --topic="tmcai-${topic}-dlq" \
    --ack-deadline=60 \
    --message-retention-duration=7d \
    --retain-acked-messages \
    --expiration-period=never \
    2>/dev/null || echo "  tmcai-${topic}-dlq-monitor already exists"

  # Main topic
  gcloud pubsub topics create "tmcai-${topic}" \
    --message-retention-duration=7d \
    --labels=app=tmcai,component=haseebos \
    2>/dev/null || echo "  tmcai-${topic} already exists"

  # Main subscription with DLQ
  ORDERING_FLAG=""
  if [[ "$topic" != "steering-snapshot" ]]; then
    ORDERING_FLAG="--enable-message-ordering"
  fi

  gcloud pubsub subscriptions create "tmcai-${topic}-sub" \
    --topic="tmcai-${topic}" \
    --ack-deadline=60 \
    --message-retention-duration=7d \
    --expiration-period=never \
    --dead-letter-topic="tmcai-${topic}-dlq" \
    --max-delivery-attempts=5 \
    --min-retry-delay=1s \
    --max-retry-delay=600s \
    $ORDERING_FLAG \
    2>/dev/null || echo "  tmcai-${topic}-sub already exists"
done

echo "  ✓ 4 topics + 4 DLQs + 8 subscriptions created"

# ───────────────────────────────────────
# 3. BigQuery Datasets + Tables
# ───────────────────────────────────────
echo ""
echo "▸ Step 4/8: Creating BigQuery datasets & tables..."

# Decisions dataset
bq mk --dataset \
  --description="Immutable Layer 1 decision archive — nightly CDC from PostgreSQL" \
  --location=$REGION \
  --label=app:tmcai --label=component:haseebos \
  "${PROJECT_ID}:tmcai_decisions" 2>/dev/null || echo "  tmcai_decisions already exists"

# Decision archive table
bq mk --table \
  --time_partitioning_field=created_at \
  --time_partitioning_type=DAY \
  --clustering_fields=tenant_id,agent_id,risk_tier \
  --description="Immutable decision log archive (Layer 1)" \
  "${PROJECT_ID}:tmcai_decisions.decision_archive" \
  id:STRING,tenant_id:STRING,agent_id:STRING,agent_type:STRING,decision_type:STRING,input_summary:STRING,output_summary:STRING,reasoning:STRING,confidence_score:FLOAT,risk_tier:STRING,action_taken:STRING,outcome:STRING,user_feedback:STRING,duration_ms:INTEGER,trace_id:STRING,model_version:STRING,tokens_used:INTEGER,cost_usd:FLOAT,metadata:JSON,created_at:TIMESTAMP,exported_at:TIMESTAMP \
  2>/dev/null || echo "  decision_archive table already exists"

# Shadow dataset
bq mk --dataset \
  --description="Shadow scoring: evaluation results, golden dataset scoring" \
  --location=$REGION \
  --label=app:tmcai --label=component:haseebos \
  "${PROJECT_ID}:tmcai_shadow" 2>/dev/null || echo "  tmcai_shadow already exists"

# Shadow evaluations table
bq mk --table \
  --time_partitioning_field=evaluated_at \
  --time_partitioning_type=DAY \
  --clustering_fields=tenant_id,agent_id,rule_state \
  --description="Shadow rule evaluation results" \
  "${PROJECT_ID}:tmcai_shadow.shadow_evaluations" \
  id:STRING,tenant_id:STRING,rule_id:STRING,rule_state:STRING,agent_id:STRING,model_version:STRING,golden_dataset_id:STRING,input_hash:STRING,expected_output:STRING,actual_output:STRING,match_score:FLOAT,passed:BOOLEAN,evaluation_details:JSON,evaluated_at:TIMESTAMP \
  2>/dev/null || echo "  shadow_evaluations table already exists"

# Steering dataset
bq mk --dataset \
  --description="Steering Wheel KPI history and trend analytics" \
  --location=$REGION \
  --label=app:tmcai --label=component:haseebos \
  "${PROJECT_ID}:tmcai_steering" 2>/dev/null || echo "  tmcai_steering already exists"

# KPI snapshots table
bq mk --table \
  --time_partitioning_field=snapshot_at \
  --time_partitioning_type=DAY \
  --clustering_fields=tenant_id,metric_type \
  --description="Steering Wheel KPI snapshots" \
  "${PROJECT_ID}:tmcai_steering.kpi_snapshots" \
  id:STRING,tenant_id:STRING,metric_type:STRING,metric_value:FLOAT,period_start:TIMESTAMP,period_end:TIMESTAMP,trend:STRING,anomaly:BOOLEAN,agent_id:STRING,details:JSON,snapshot_at:TIMESTAMP \
  2>/dev/null || echo "  kpi_snapshots table already exists"

# Agent performance table
bq mk --table \
  --time_partitioning_field=recorded_at \
  --time_partitioning_type=DAY \
  --clustering_fields=tenant_id,agent_type \
  --description="Agent performance metrics" \
  "${PROJECT_ID}:tmcai_steering.agent_performance" \
  id:STRING,tenant_id:STRING,agent_type:STRING,actions_taken:INTEGER,actions_success:INTEGER,actions_failed:INTEGER,avg_latency_ms:FLOAT,tokens_consumed:INTEGER,cost_usd:FLOAT,recorded_at:TIMESTAMP \
  2>/dev/null || echo "  agent_performance table already exists"

echo "  ✓ 3 datasets + 4 tables created"

# ───────────────────────────────────────
# 4. Cloud Storage Buckets
# ───────────────────────────────────────
echo ""
echo "▸ Step 5/8: Creating Cloud Storage buckets..."

# Golden datasets bucket
gcloud storage buckets create "gs://${PROJECT_ID}-golden-datasets" \
  --location=$REGION \
  --uniform-bucket-level-access \
  --enable-autoclass \
  2>/dev/null || echo "  golden-datasets bucket already exists"

# BQ staging bucket (7-day lifecycle)
gcloud storage buckets create "gs://${PROJECT_ID}-bq-staging" \
  --location=$REGION \
  --uniform-bucket-level-access \
  2>/dev/null || echo "  bq-staging bucket already exists"

# Set lifecycle on staging bucket
cat > /tmp/lifecycle.json << 'LCEOF'
{
  "rule": [
    {
      "action": {"type": "Delete"},
      "condition": {"age": 7}
    }
  ]
}
LCEOF
gcloud storage buckets update "gs://${PROJECT_ID}-bq-staging" --lifecycle-file=/tmp/lifecycle.json --quiet

# Backup bucket (Nearline)
gcloud storage buckets create "gs://${PROJECT_ID}-backups" \
  --location=$REGION \
  --storage-class=NEARLINE \
  --uniform-bucket-level-access \
  2>/dev/null || echo "  backups bucket already exists"

# Function source bucket
gcloud storage buckets create "gs://${PROJECT_ID}-function-source" \
  --location=$REGION \
  --uniform-bucket-level-access \
  2>/dev/null || echo "  function-source bucket already exists"

echo "  ✓ 4 buckets created"

# ───────────────────────────────────────
# 5. Secret Manager
# ───────────────────────────────────────
echo ""
echo "▸ Step 6/8: Creating Secret Manager secrets..."

SECRETS=(
  "tmcai-pg-connection-string"
  "tmcai-redis-url"
  "tmcai-gemini-api-key"
  "tmcai-jwt-secret"
  "tmcai-encryption-key"
  "tmcai-webhook-secret"
  "tmcai-backup-encryption-key"
)

for secret in "${SECRETS[@]}"; do
  gcloud secrets create "$secret" \
    --replication-policy="automatic" \
    --labels=app=tmcai,component=haseebos \
    2>/dev/null || echo "  $secret already exists"
done

echo "  ✓ ${#SECRETS[@]} secrets created (add values with: gcloud secrets versions add SECRET_NAME --data-file=-)"

# ───────────────────────────────────────
# 6. Cloud Scheduler Jobs
# ───────────────────────────────────────
echo ""
echo "▸ Step 7/8: Creating Cloud Scheduler jobs..."

# Note: These use placeholder URLs — update after deploying the Cloud Function and API
gcloud scheduler jobs create http tmcai-bq-export-nightly \
  --schedule="0 2 * * *" \
  --time-zone="UTC" \
  --uri="https://placeholder-update-after-function-deploy.cloudfunctions.net/tmcai-bq-export" \
  --http-method=POST \
  --headers="Content-Type=application/json" \
  --message-body='{"export_type":"incremental","tables":["DecisionLog"],"since":"last_export"}' \
  --location=$REGION \
  2>/dev/null || echo "  tmcai-bq-export-nightly already exists"

gcloud scheduler jobs create http tmcai-shadow-evaluation \
  --schedule="0 3 * * *" \
  --time-zone="UTC" \
  --uri="https://api.tmcai.app/api/shadow/evaluate" \
  --http-method=POST \
  --headers="Content-Type=application/json" \
  --message-body='{"scope":"all_tenants","rule_states":["DRAFT","SHADOW"]}' \
  --location=$REGION \
  2>/dev/null || echo "  tmcai-shadow-evaluation already exists"

gcloud scheduler jobs create http tmcai-steering-snapshot \
  --schedule="0 6 * * *" \
  --time-zone="UTC" \
  --uri="https://api.tmcai.app/api/steering/snapshot" \
  --http-method=POST \
  --headers="Content-Type=application/json" \
  --message-body='{"scope":"all_tenants","type":"daily"}' \
  --location=$REGION \
  2>/dev/null || echo "  tmcai-steering-snapshot already exists"

echo "  ✓ 3 scheduler jobs created"

# ───────────────────────────────────────
# 7. Summary
# ───────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
echo " ✅ GCP Infrastructure Setup Complete!"
echo "═══════════════════════════════════════════════════"
echo ""
echo " Resources created:"
echo "   • 3 Service Accounts (tmcai-api, tmcai-agent-worker, tmcai-bq-exporter)"
echo "   • 4 Pub/Sub Topics + 4 DLQs + 8 Subscriptions"
echo "   • 3 BigQuery Datasets + 4 Tables (partitioned + clustered)"
echo "   • 4 Cloud Storage Buckets"
echo "   • 7 Secret Manager Secrets (empty — add values manually)"
echo "   • 3 Cloud Scheduler Jobs"
echo ""
echo " Next steps:"
echo "   1. Add secret values:"
echo "      echo -n 'postgresql://...' | gcloud secrets versions add tmcai-pg-connection-string --data-file=-"
echo "   2. Deploy the BQ export Cloud Function:"
echo "      cd infra/functions/bq-export && gcloud functions deploy tmcai-bq-export \\"
echo "        --gen2 --runtime=nodejs20 --entry-point=exportDecisionsToBQ \\"
echo "        --region=$REGION --memory=512Mi --timeout=540s \\"
echo "        --service-account=tmcai-bq-exporter@${PROJECT_ID}.iam.gserviceaccount.com"
echo "   3. Update Cloud Scheduler with actual function URL"
echo "   4. Generate service account keys for Ubuntu server:"
echo "      gcloud iam service-accounts keys create tmcai-key.json \\"
echo "        --iam-account=tmcai-api@${PROJECT_ID}.iam.gserviceaccount.com"
echo ""
echo " Estimated monthly cost: ~\$86/mo (BullMQ) or ~\$146/mo (with Pub/Sub)"
echo " All covered by GCP \$14K credit — \$0 out-of-pocket"
echo "═══════════════════════════════════════════════════"
