# ═══════════════════════════════════════════════════════════════
# BigQuery — 3 Datasets + Tables for HaseebOS v15
#   1. tmcai_decisions — Immutable decision archive (Layer 1)
#   2. tmcai_shadow    — Shadow scoring + golden dataset results
#   3. tmcai_steering  — KPI snapshots + trend analytics
# ═══════════════════════════════════════════════════════════════

variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

# ───────────────────────────────────────
# Dataset: Decisions (Layer 1 — Immutable Archive)
# ───────────────────────────────────────
resource "google_bigquery_dataset" "decisions" {
  dataset_id    = "tmcai_decisions"
  friendly_name = "TMCAI Decision Archive"
  description   = "Immutable Layer 1 decision log — nightly CDC from PostgreSQL DecisionLog table. NEVER delete or modify rows."
  location      = var.region
  project       = var.project_id

  default_table_expiration_ms = null # Never expire — immutable archive

  labels = {
    app       = "tmcai"
    component = "haseebos"
    layer     = "decision-archive"
  }
}

resource "google_bigquery_table" "decision_archive" {
  dataset_id          = google_bigquery_dataset.decisions.dataset_id
  table_id            = "decision_archive"
  project             = var.project_id
  deletion_protection = true # Prevent accidental deletion

  time_partitioning {
    type  = "DAY"
    field = "created_at"
  }

  clustering = ["tenant_id", "agent_id", "risk_tier"]

  schema = jsonencode([
    { name = "id",                type = "STRING",    mode = "REQUIRED", description = "Decision UUID from PostgreSQL" },
    { name = "tenant_id",         type = "STRING",    mode = "REQUIRED", description = "Tenant identifier" },
    { name = "agent_id",          type = "STRING",    mode = "REQUIRED", description = "Agent that made the decision" },
    { name = "agent_type",        type = "STRING",    mode = "NULLABLE", description = "brain_orchestrator, feed_curator, triage_analyst, etc." },
    { name = "decision_type",     type = "STRING",    mode = "REQUIRED", description = "Type of decision made" },
    { name = "input_summary",     type = "STRING",    mode = "NULLABLE", description = "Summarized input context" },
    { name = "output_summary",    type = "STRING",    mode = "NULLABLE", description = "Summarized output/action" },
    { name = "reasoning",         type = "STRING",    mode = "NULLABLE", description = "LLM reasoning chain" },
    { name = "confidence_score",  type = "FLOAT64",   mode = "NULLABLE", description = "Model confidence 0.0-1.0" },
    { name = "risk_tier",         type = "STRING",    mode = "NULLABLE", description = "LOW, MEDIUM, HIGH" },
    { name = "action_taken",      type = "STRING",    mode = "NULLABLE", description = "Actual action executed" },
    { name = "outcome",           type = "STRING",    mode = "NULLABLE", description = "Result of the action" },
    { name = "user_feedback",     type = "STRING",    mode = "NULLABLE", description = "User approval/override/rejection" },
    { name = "duration_ms",       type = "INT64",     mode = "NULLABLE", description = "Processing time in milliseconds" },
    { name = "trace_id",          type = "STRING",    mode = "NULLABLE", description = "Global trace ID for request correlation" },
    { name = "model_version",     type = "STRING",    mode = "NULLABLE", description = "LLM model used (gemini-2.5-pro, etc.)" },
    { name = "tokens_used",       type = "INT64",     mode = "NULLABLE", description = "Total tokens consumed" },
    { name = "cost_usd",          type = "FLOAT64",   mode = "NULLABLE", description = "Estimated cost in USD" },
    { name = "metadata",          type = "JSON",      mode = "NULLABLE", description = "Additional structured metadata" },
    { name = "created_at",        type = "TIMESTAMP", mode = "REQUIRED", description = "When decision was made (partition key)" },
    { name = "exported_at",       type = "TIMESTAMP", mode = "REQUIRED", description = "When exported from PG to BQ" },
  ])

  labels = {
    app   = "tmcai"
    layer = "l1-immutable"
  }
}

# Layer 2 — Curated training set (view over decision_archive with labels)
resource "google_bigquery_table" "decision_curated" {
  dataset_id = google_bigquery_dataset.decisions.dataset_id
  table_id   = "decision_curated_v"
  project    = var.project_id

  view {
    query          = <<-SQL
      SELECT *
      FROM `${var.project_id}.tmcai_decisions.decision_archive`
      WHERE user_feedback IS NOT NULL
        AND user_feedback != ''
        AND confidence_score IS NOT NULL
      ORDER BY created_at DESC
    SQL
    use_legacy_sql = false
  }

  labels = {
    app   = "tmcai"
    layer = "l2-curated"
  }
}

# ───────────────────────────────────────
# Dataset: Shadow Scoring
# ───────────────────────────────────────
resource "google_bigquery_dataset" "shadow" {
  dataset_id    = "tmcai_shadow"
  friendly_name = "TMCAI Shadow Scoring"
  description   = "Probabilistic Shadowing: shadow evaluation results, golden dataset scoring, rule lifecycle tracking"
  location      = var.region
  project       = var.project_id

  default_table_expiration_ms = null

  labels = {
    app       = "tmcai"
    component = "haseebos"
    layer     = "shadow-scoring"
  }
}

resource "google_bigquery_table" "shadow_evaluations" {
  dataset_id = google_bigquery_dataset.shadow.dataset_id
  table_id   = "shadow_evaluations"
  project    = var.project_id

  time_partitioning {
    type  = "DAY"
    field = "evaluated_at"
  }

  clustering = ["tenant_id", "agent_id", "rule_state"]

  schema = jsonencode([
    { name = "id",                 type = "STRING",    mode = "REQUIRED" },
    { name = "tenant_id",          type = "STRING",    mode = "REQUIRED" },
    { name = "rule_id",            type = "STRING",    mode = "REQUIRED" },
    { name = "rule_state",         type = "STRING",    mode = "REQUIRED", description = "DRAFT, SHADOW, ACTIVE, DEPRECATED, ARCHIVED" },
    { name = "agent_id",           type = "STRING",    mode = "REQUIRED" },
    { name = "model_version",      type = "STRING",    mode = "NULLABLE" },
    { name = "golden_dataset_id",  type = "STRING",    mode = "NULLABLE" },
    { name = "input_hash",         type = "STRING",    mode = "REQUIRED" },
    { name = "expected_output",    type = "STRING",    mode = "NULLABLE" },
    { name = "actual_output",      type = "STRING",    mode = "NULLABLE" },
    { name = "match_score",        type = "FLOAT64",   mode = "REQUIRED", description = "0.0-1.0 match against golden dataset" },
    { name = "passed",             type = "BOOLEAN",   mode = "REQUIRED" },
    { name = "evaluation_details", type = "JSON",      mode = "NULLABLE" },
    { name = "evaluated_at",       type = "TIMESTAMP", mode = "REQUIRED" },
  ])

  labels = {
    app   = "tmcai"
    layer = "shadow"
  }
}

# ───────────────────────────────────────
# Dataset: Steering
# ───────────────────────────────────────
resource "google_bigquery_dataset" "steering" {
  dataset_id    = "tmcai_steering"
  friendly_name = "TMCAI Steering Analytics"
  description   = "Steering Wheel KPI history, trend analytics, Morning Brief data, agent performance metrics"
  location      = var.region
  project       = var.project_id

  default_table_expiration_ms = null

  labels = {
    app       = "tmcai"
    component = "haseebos"
    layer     = "steering"
  }
}

resource "google_bigquery_table" "kpi_snapshots" {
  dataset_id = google_bigquery_dataset.steering.dataset_id
  table_id   = "kpi_snapshots"
  project    = var.project_id

  time_partitioning {
    type  = "DAY"
    field = "snapshot_at"
  }

  clustering = ["tenant_id", "metric_type"]

  schema = jsonencode([
    { name = "id",            type = "STRING",    mode = "REQUIRED" },
    { name = "tenant_id",     type = "STRING",    mode = "REQUIRED" },
    { name = "metric_type",   type = "STRING",    mode = "REQUIRED", description = "response_time, resolution_rate, escalation_rate, etc." },
    { name = "metric_value",  type = "FLOAT64",   mode = "REQUIRED" },
    { name = "period_start",  type = "TIMESTAMP", mode = "REQUIRED" },
    { name = "period_end",    type = "TIMESTAMP", mode = "REQUIRED" },
    { name = "trend",         type = "STRING",    mode = "NULLABLE", description = "UP, DOWN, STABLE" },
    { name = "anomaly",       type = "BOOLEAN",   mode = "NULLABLE", description = "True if >2σ deviation" },
    { name = "agent_id",      type = "STRING",    mode = "NULLABLE" },
    { name = "details",       type = "JSON",      mode = "NULLABLE" },
    { name = "snapshot_at",   type = "TIMESTAMP", mode = "REQUIRED" },
  ])

  labels = {
    app   = "tmcai"
    layer = "steering"
  }
}

resource "google_bigquery_table" "agent_performance" {
  dataset_id = google_bigquery_dataset.steering.dataset_id
  table_id   = "agent_performance"
  project    = var.project_id

  time_partitioning {
    type  = "DAY"
    field = "recorded_at"
  }

  clustering = ["tenant_id", "agent_type"]

  schema = jsonencode([
    { name = "id",              type = "STRING",    mode = "REQUIRED" },
    { name = "tenant_id",       type = "STRING",    mode = "REQUIRED" },
    { name = "agent_type",      type = "STRING",    mode = "REQUIRED" },
    { name = "actions_taken",   type = "INT64",     mode = "REQUIRED" },
    { name = "actions_success", type = "INT64",     mode = "REQUIRED" },
    { name = "actions_failed",  type = "INT64",     mode = "REQUIRED" },
    { name = "avg_latency_ms",  type = "FLOAT64",   mode = "NULLABLE" },
    { name = "tokens_consumed", type = "INT64",     mode = "NULLABLE" },
    { name = "cost_usd",        type = "FLOAT64",   mode = "NULLABLE" },
    { name = "recorded_at",     type = "TIMESTAMP", mode = "REQUIRED" },
  ])

  labels = {
    app   = "tmcai"
    layer = "steering"
  }
}

# ───────────────────────────────────────
# Outputs
# ───────────────────────────────────────
output "decisions_dataset_id" {
  value = google_bigquery_dataset.decisions.dataset_id
}

output "shadow_dataset_id" {
  value = google_bigquery_dataset.shadow.dataset_id
}

output "steering_dataset_id" {
  value = google_bigquery_dataset.steering.dataset_id
}
