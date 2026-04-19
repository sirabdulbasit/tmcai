#!/usr/bin/env bash
# HaseebOS v15 — populate Secret Manager shells from local .env + generate new randoms.
#
# Prereqs:
#   - gcloud CLI authenticated (gcloud auth login)
#   - Project set: gcloud config set project tmcai-491811
#   - server/.env exists with DATABASE_URL, GEMINI_API_KEY, ENCRYPTION_KEY
#
# Usage (safe default = dry-run, prints what would happen):
#   bash scripts/populate-gcp-secrets.sh
#
# To actually write:
#   bash scripts/populate-gcp-secrets.sh --apply
#
# Re-run idempotently — gcloud creates a new version per add, older versions stay.

set -euo pipefail

APPLY=false
if [[ "${1:-}" == "--apply" ]]; then APPLY=true; fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_ROOT/server/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Cannot extract existing secrets." >&2
  exit 1
fi

# Extract from server/.env. Each helper strips surrounding quotes.
read_env() {
  grep -E "^$1=" "$ENV_FILE" | head -1 | sed -E 's/^[^=]+=//; s/^"//; s/"$//'
}

PG_URL="$(read_env DATABASE_URL)"
GEMINI_KEY="$(read_env GEMINI_API_KEY)"
ENCRYPTION_KEY="$(read_env ENCRYPTION_KEY)"

# Generate new randoms (64-char hex = 256 bits)
rand() { openssl rand -hex 32; }
PLATFORM_TOKEN="$(rand)"
JWT_SECRET="$(rand)"
WEBHOOK_SECRET="$(rand)"
BACKUP_KEY="$(rand)"

echo "=== Secret population plan ==="
echo ""
echo "From server/.env:"
echo "  tmcai-pg-connection-string → ${PG_URL:0:40}…"
echo "  tmcai-gemini-api-key       → ${GEMINI_KEY:0:12}…"
echo "  tmcai-encryption-key       → ${ENCRYPTION_KEY:0:12}…"
echo ""
echo "Newly generated:"
echo "  platform-api-token         → ${PLATFORM_TOKEN:0:16}… (64 hex chars)"
echo "  tmcai-jwt-secret           → ${JWT_SECRET:0:16}… (64 hex chars)"
echo "  tmcai-webhook-secret       → ${WEBHOOK_SECRET:0:16}… (64 hex chars)"
echo "  tmcai-backup-encryption-key→ ${BACKUP_KEY:0:16}… (64 hex chars)"
echo ""
echo "Skipped (you must provide — Ubuntu Redis password):"
echo "  tmcai-redis-url            → YOUR-UBUNTU-REDIS-PASSWORD"
echo "  memorystore-auth           → same value"
echo ""

if ! $APPLY; then
  echo "Dry-run. Re-run with --apply to write to Secret Manager."
  echo ""
  echo "IMPORTANT: before --apply, set the Redis password manually:"
  echo "  echo -n 'your-ubuntu-redis-password' | \\"
  echo "    gcloud secrets versions add tmcai-redis-url  --data-file=-"
  echo "  echo -n 'your-ubuntu-redis-password' | \\"
  echo "    gcloud secrets versions add memorystore-auth --data-file=-"
  echo ""
  echo "Also add the platform-api-token to your platform server env (it must MATCH):"
  echo "  PLATFORM_API_TOKEN=$PLATFORM_TOKEN"
  exit 0
fi

# Apply
apply_secret() {
  local name="$1" value="$2"
  if [[ -z "$value" ]]; then
    echo "  [skip] $name — empty value"
    return
  fi
  echo -n "$value" | gcloud secrets versions add "$name" --data-file=- --quiet >/dev/null
  echo "  [ok]   $name"
}

echo "=== Writing to Secret Manager ==="
apply_secret tmcai-pg-connection-string "$PG_URL"
apply_secret tmcai-gemini-api-key "$GEMINI_KEY"
apply_secret tmcai-encryption-key "$ENCRYPTION_KEY"
apply_secret platform-api-token "$PLATFORM_TOKEN"
apply_secret tmcai-jwt-secret "$JWT_SECRET"
apply_secret tmcai-webhook-secret "$WEBHOOK_SECRET"
apply_secret tmcai-backup-encryption-key "$BACKUP_KEY"

echo ""
echo "=== Done. Save this platform-api-token in your platform server's env ==="
echo "PLATFORM_API_TOKEN=$PLATFORM_TOKEN"
echo ""
echo "Next: set the Ubuntu Redis password manually:"
echo "  echo -n 'your-pass' | gcloud secrets versions add tmcai-redis-url  --data-file=-"
echo "  echo -n 'your-pass' | gcloud secrets versions add memorystore-auth --data-file=-"
