# ═══════════════════════════════════════════════════════════════
# Secret Manager — Secure credential storage
# Secrets are created empty — values must be added manually
# via: gcloud secrets versions add SECRET_NAME --data-file=secret.txt
# ═══════════════════════════════════════════════════════════════

variable "project_id" {
  type = string
}

locals {
  secrets = {
    "tmcai-pg-connection-string" = {
      description = "PostgreSQL connection string for BQ export function (format: postgresql://user:pass@host:5432/db)"
    }
    "tmcai-redis-url" = {
      description = "Redis connection URL for Ubuntu server (format: redis://host:6379)"
    }
    "tmcai-gemini-api-key" = {
      description = "Vertex AI / Gemini API key (if using API key auth instead of service account)"
    }
    "tmcai-jwt-secret" = {
      description = "JWT signing secret for TMCAI API authentication"
    }
    "tmcai-encryption-key" = {
      description = "AES-256 encryption key for PII envelope encryption"
    }
    "tmcai-webhook-secret" = {
      description = "HMAC secret for validating incoming webhooks (Gmail, Calendar push)"
    }
    "tmcai-backup-encryption-key" = {
      description = "Encryption key for GCS backup files from Ubuntu server"
    }
  }
}

resource "google_secret_manager_secret" "secrets" {
  for_each = local.secrets

  secret_id = each.key
  project   = var.project_id

  replication {
    auto {}
  }

  labels = {
    app       = "tmcai"
    component = "haseebos"
  }

  # Note: Secret VALUES are not managed by Terraform (for security).
  # Add values after terraform apply:
  #   echo -n "your-secret-value" | gcloud secrets versions add SECRET_ID --data-file=-
}

# ───────────────────────────────────────
# Outputs
# ───────────────────────────────────────
output "secret_ids" {
  value = { for k, v in google_secret_manager_secret.secrets : k => v.secret_id }
}
