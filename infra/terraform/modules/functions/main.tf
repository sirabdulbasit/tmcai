# ═══════════════════════════════════════════════════════════════
# Cloud Functions — Nightly PG→BQ Export
# Lightweight function triggered by Cloud Scheduler
# Connects to Ubuntu PostgreSQL via public IP, exports to BigQuery
# ═══════════════════════════════════════════════════════════════

variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "bq_export_sa_email" {
  type        = string
  description = "Service account email for BQ exporter"
}

variable "source_bucket" {
  type        = string
  description = "GCS bucket for function source code"
}

# ───────────────────────────────────────
# Function source code (placeholder zip)
# The actual function code lives in infra/functions/bq-export/
# and must be zipped and uploaded to GCS before terraform apply
# ───────────────────────────────────────
resource "google_storage_bucket_object" "bq_export_source" {
  name   = "bq-export/function-source.zip"
  bucket = var.source_bucket
  source = "${path.module}/../../functions/bq-export/function-source.zip"

  # This will fail if the zip doesn't exist yet — that's expected.
  # Run: cd infra/functions/bq-export && zip -r function-source.zip . && mv function-source.zip ../../terraform/modules/functions/
  # Or use the gcloud script which handles this automatically.

  lifecycle {
    ignore_changes = [
      detect_md5hash, # Allow updates without Terraform noticing
    ]
  }
}

# ───────────────────────────────────────
# Cloud Function: PG → BQ Nightly Export
# ───────────────────────────────────────
resource "google_cloudfunctions2_function" "bq_export" {
  name     = "tmcai-bq-export"
  location = var.region
  project  = var.project_id

  description = "Nightly incremental export from PostgreSQL DecisionLog to BigQuery decision_archive"

  build_config {
    runtime     = "nodejs20"
    entry_point = "exportDecisionsToBQ"

    source {
      storage_source {
        bucket = var.source_bucket
        object = google_storage_bucket_object.bq_export_source.name
      }
    }
  }

  service_config {
    max_instance_count    = 1  # Only one export at a time
    min_instance_count    = 0  # Scale to zero when idle
    available_memory      = "512Mi"
    timeout_seconds       = 540 # 9 minutes max
    service_account_email = var.bq_export_sa_email

    environment_variables = {
      GCP_PROJECT_ID  = var.project_id
      BQ_DATASET      = "tmcai_decisions"
      BQ_TABLE        = "decision_archive"
      STAGING_BUCKET  = "${var.project_id}-bq-staging"
      # PG connection comes from Secret Manager
      PG_SECRET_NAME  = "tmcai-pg-connection-string"
    }
  }

  labels = {
    app       = "tmcai"
    component = "haseebos"
    purpose   = "bq-export"
  }
}

# ───────────────────────────────────────
# Outputs
# ───────────────────────────────────────
output "bq_export_function_url" {
  value = google_cloudfunctions2_function.bq_export.service_config[0].uri
}

output "bq_export_function_name" {
  value = google_cloudfunctions2_function.bq_export.name
}
