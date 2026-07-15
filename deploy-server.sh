#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# deploy-server.sh — Deploy tmcai-server to Cloud Run (L1/L2)
# Run from: tmcai/ directory (where Dockerfile lives)
# Prereqs: gcloud CLI authenticated, Docker running
# ─────────────────────────────────────────────────────────────
set -euo pipefail

PROJECT="tmcai-491811"
REGION="us-central1"
SERVICE="tmcai-server"
SA="tmcai-api@${PROJECT}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/tmcai/${SERVICE}:latest"

echo "=== Step 1: Build & push Docker image ==="
gcloud builds submit \
  --tag="${IMAGE}" \
  --project="${PROJECT}" \
  --timeout=600s \
  .

echo "=== Step 2: Deploy to Cloud Run ==="
gcloud run deploy "${SERVICE}" \
  --image="${IMAGE}" \
  --region="${REGION}" \
  --project="${PROJECT}" \
  --platform=managed \
  --service-account="${SA}" \
  --port=4002 \
  --cpu=2 \
  --memory=2Gi \
  --min-instances=0 \
  --max-instances=10 \
  --timeout=300s \
  --concurrency=80 \
  --allow-unauthenticated \
  --set-env-vars="NODE_ENV=production,GCP_PROJECT_ID=${PROJECT},GCP_LOCATION=${REGION},PORT=4002" \
  --set-secrets="\
DATABASE_URL=tmcai-pg-connection-string:latest,\
REDIS_URL=tmcai-redis-url:latest,\
GEMINI_API_KEY=tmcai-gemini-api-key:latest,\
JWT_SECRET=tmcai-jwt-secret:latest,\
ENCRYPTION_KEY=tmcai-encryption-key:latest,\
FEED_INTEGRITY_SECRET=tmcai-feed-integrity-secret:latest,\
SLACK_SIGNING_SECRET=tmcai-slack-signing-secret:latest,\
WEBHOOK_SECRET=tmcai-webhook-secret:latest,\
PLATFORM_API_TOKEN=platform-api-token:latest,\
KNOW_API_KEY=tmcai-know-api-key:latest,\
TMC_CONTEXT_API_KEY=tmcai-tmc-context-api-key:latest,\
BACKUP_ENCRYPTION_KEY=tmcai-backup-encryption-key:latest\
"

echo ""
echo "=== Deploy complete ==="
URL=$(gcloud run services describe "${SERVICE}" --region="${REGION}" --project="${PROJECT}" --format='value(status.url)')
echo "Service URL: ${URL}"
echo ""
echo "=== Step 3: Verify health ==="
curl -s "${URL}/api/health" | head -c 200
echo ""
echo ""
echo "=== Step 4: Update Pub/Sub push subscriptions (optional) ==="
echo "To convert pull subs to push subs pointing at this service:"
echo "  gcloud pubsub subscriptions modify-push-config tmcai-open-item-events-sub --push-endpoint=${URL}/api/v1/pubsub/open-item-events"
echo "  gcloud pubsub subscriptions modify-push-config tmcai-action-executed-events-sub --push-endpoint=${URL}/api/v1/pubsub/action-executed-events"
echo "  gcloud pubsub subscriptions modify-push-config tmcai-steering-wheel-events-sub --push-endpoint=${URL}/api/v1/pubsub/steering-wheel-events"
echo "  gcloud pubsub subscriptions modify-push-config tmcai-decision-recorded-sub --push-endpoint=${URL}/api/v1/pubsub/decision-recorded"
