# ═══════════════════════════════════════════════════════════════
# Cloud Scheduler — Cron Jobs
#   1. Nightly BQ export trigger (02:00 UTC)
#   2. Shadow scoring evaluation (03:00 UTC)
#   3. Steering snapshot generation (06:00 UTC)
# ═══════════════════════════════════════════════════════════════

variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

variable "bq_export_function_url" {
  type        = string
  description = "URL of the BQ export Cloud Function"
}

# ───────────────────────────────────────
# 1. Nightly PG → BQ Export (02:00 UTC)
# ───────────────────────────────────────
resource "google_cloud_scheduler_job" "bq_export_nightly" {
  name        = "tmcai-bq-export-nightly"
  description = "Triggers nightly PostgreSQL → BigQuery incremental export of DecisionLog"
  schedule    = "0 2 * * *"  # 02:00 UTC daily
  time_zone   = "UTC"
  project     = var.project_id
  region      = var.region

  retry_config {
    retry_count          = 3
    max_retry_duration   = "3600s"
    min_backoff_duration = "60s"
    max_backoff_duration = "300s"
  }

  http_target {
    http_method = "POST"
    uri         = var.bq_export_function_url

    body = base64encode(jsonencode({
      export_type = "incremental"
      tables      = ["DecisionLog"]
      since       = "last_export"
    }))

    headers = {
      "Content-Type" = "application/json"
    }

    oidc_token {
      service_account_email = "${var.project_id}@appspot.gserviceaccount.com"
    }
  }
}

# ───────────────────────────────────────
# 2. Shadow Scoring Evaluation (03:00 UTC)
# ───────────────────────────────────────
resource "google_cloud_scheduler_job" "shadow_evaluation" {
  name        = "tmcai-shadow-evaluation"
  description = "Triggers shadow scoring evaluation of DRAFT and SHADOW rules against golden dataset"
  schedule    = "0 3 * * *"  # 03:00 UTC daily
  time_zone   = "UTC"
  project     = var.project_id
  region      = var.region

  retry_config {
    retry_count          = 2
    min_backoff_duration = "120s"
    max_backoff_duration = "600s"
  }

  # Calls the TMCAI API on Ubuntu server
  http_target {
    http_method = "POST"
    uri         = "https://api.tmcai.app/api/shadow/evaluate"  # Update with actual API URL

    body = base64encode(jsonencode({
      scope      = "all_tenants"
      rule_states = ["DRAFT", "SHADOW"]
    }))

    headers = {
      "Content-Type" = "application/json"
    }
  }
}

# ───────────────────────────────────────
# 3. Steering Snapshot (06:00 UTC — before morning brief)
# ───────────────────────────────────────
resource "google_cloud_scheduler_job" "steering_snapshot" {
  name        = "tmcai-steering-snapshot"
  description = "Generates daily steering KPI snapshot for Morning Brief and Steering Wheel dashboard"
  schedule    = "0 6 * * *"  # 06:00 UTC daily (before users wake up)
  time_zone   = "UTC"
  project     = var.project_id
  region      = var.region

  retry_config {
    retry_count          = 2
    min_backoff_duration = "60s"
    max_backoff_duration = "300s"
  }

  http_target {
    http_method = "POST"
    uri         = "https://api.tmcai.app/api/steering/snapshot"  # Update with actual API URL

    body = base64encode(jsonencode({
      scope = "all_tenants"
      type  = "daily"
    }))

    headers = {
      "Content-Type" = "application/json"
    }
  }
}

# ───────────────────────────────────────
# Outputs
# ───────────────────────────────────────
output "scheduler_jobs" {
  value = {
    bq_export    = google_cloud_scheduler_job.bq_export_nightly.name
    shadow_eval  = google_cloud_scheduler_job.shadow_evaluation.name
    steering     = google_cloud_scheduler_job.steering_snapshot.name
  }
}
