# ═══════════════════════════════════════════════════════════════
# Monitoring — Alert Policies + Notification Channel
# Covers: Pub/Sub DLQ depth, BQ export failures,
#         agent errors, kill switch triggers
# ═══════════════════════════════════════════════════════════════

variable "project_id" {
  type = string
}

# ───────────────────────────────────────
# Notification Channel (Email)
# ───────────────────────────────────────
resource "google_monitoring_notification_channel" "email" {
  display_name = "TMCAI Alerts Email"
  type         = "email"
  project      = var.project_id

  labels = {
    email_address = "basit.ahmed@tmcltd.ai"
  }
}

# ───────────────────────────────────────
# Alert 1: Pub/Sub DLQ Depth > 100
# ───────────────────────────────────────
resource "google_monitoring_alert_policy" "dlq_depth" {
  display_name = "TMCAI: Pub/Sub DLQ Messages > 100"
  project      = var.project_id
  combiner     = "OR"

  conditions {
    display_name = "DLQ message count exceeds 100"

    condition_threshold {
      filter          = "resource.type = \"pubsub_subscription\" AND resource.labels.subscription_id = monitoring.regex.full_match(\"tmcai-.*-dlq-monitor\") AND metric.type = \"pubsub.googleapis.com/subscription/num_undelivered_messages\""
      comparison      = "COMPARISON_GT"
      threshold_value = 100
      duration        = "300s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]

  alert_strategy {
    auto_close = "1800s"
  }

  documentation {
    content   = "Pub/Sub Dead Letter Queue has accumulated >100 messages. This means messages are failing to process after 5 retries. Check: 1) Agent worker health, 2) Recent deployments, 3) DLQ subscription for error patterns."
    mime_type = "text/markdown"
  }
}

# ───────────────────────────────────────
# Alert 2: Pub/Sub Backlog > 1000
# ───────────────────────────────────────
resource "google_monitoring_alert_policy" "pubsub_backlog" {
  display_name = "TMCAI: Pub/Sub Backlog > 1000 messages"
  project      = var.project_id
  combiner     = "OR"

  conditions {
    display_name = "Subscription backlog exceeds 1000"

    condition_threshold {
      filter          = "resource.type = \"pubsub_subscription\" AND resource.labels.subscription_id = monitoring.regex.full_match(\"tmcai-.*-sub\") AND metric.type = \"pubsub.googleapis.com/subscription/num_undelivered_messages\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1000
      duration        = "600s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]

  alert_strategy {
    auto_close = "3600s"
  }

  documentation {
    content   = "Pub/Sub subscription backlog exceeds 1000 messages. Consumers may be down or processing too slowly. Check agent worker processes on Ubuntu server."
    mime_type = "text/markdown"
  }
}

# ───────────────────────────────────────
# Alert 3: BQ Export Function Failures
# ───────────────────────────────────────
resource "google_monitoring_alert_policy" "bq_export_failure" {
  display_name = "TMCAI: BQ Export Function Failed"
  project      = var.project_id
  combiner     = "OR"

  conditions {
    display_name = "Cloud Function execution failed"

    condition_threshold {
      filter          = "resource.type = \"cloud_function\" AND resource.labels.function_name = \"tmcai-bq-export\" AND metric.type = \"cloudfunctions.googleapis.com/function/execution_count\" AND metric.labels.status != \"ok\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]

  alert_strategy {
    auto_close = "3600s"
  }

  documentation {
    content   = "Nightly PG→BQ export Cloud Function has failed. Decision archive may be missing recent data. Check: 1) PostgreSQL connectivity from Cloud Function, 2) BigQuery write permissions, 3) Function logs in Cloud Logging."
    mime_type = "text/markdown"
  }
}

# ───────────────────────────────────────
# Alert 4: High Error Rate on Cloud Functions
# ───────────────────────────────────────
resource "google_monitoring_alert_policy" "function_error_rate" {
  display_name = "TMCAI: Cloud Function Error Rate > 10%"
  project      = var.project_id
  combiner     = "OR"

  conditions {
    display_name = "Function error rate exceeds 10%"

    condition_threshold {
      filter          = "resource.type = \"cloud_function\" AND resource.labels.function_name = monitoring.regex.full_match(\"tmcai-.*\") AND metric.type = \"cloudfunctions.googleapis.com/function/execution_count\" AND metric.labels.status != \"ok\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.1
      duration        = "600s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_RATE"
        cross_series_reducer = "REDUCE_SUM"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]

  documentation {
    content   = "Cloud Function error rate exceeds 10% over the last 10 minutes. Investigate function logs."
    mime_type = "text/markdown"
  }
}

# ───────────────────────────────────────
# Alert 5: BigQuery Billing Spike
# ───────────────────────────────────────
resource "google_monitoring_alert_policy" "bq_bytes_scanned" {
  display_name = "TMCAI: BigQuery Daily Scan > 50GB"
  project      = var.project_id
  combiner     = "OR"

  conditions {
    display_name = "BQ bytes scanned exceeds 50GB/day"

    condition_threshold {
      filter          = "resource.type = \"bigquery_project\" AND metric.type = \"bigquery.googleapis.com/query/scanned_bytes\""
      comparison      = "COMPARISON_GT"
      threshold_value = 53687091200  # 50 GB in bytes
      duration        = "0s"

      aggregations {
        alignment_period   = "86400s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  notification_channels = [google_monitoring_notification_channel.email.id]

  documentation {
    content   = "BigQuery has scanned over 50GB today. This could indicate: 1) Unpartitioned queries, 2) Full table scans, 3) Unexpected query patterns. First 1TB/mo is free, but monitor to stay within credit budget."
    mime_type = "text/markdown"
  }
}
