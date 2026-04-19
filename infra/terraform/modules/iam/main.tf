# ═══════════════════════════════════════════════════════════════
# IAM — Service Accounts & Roles
# 3 service accounts for separation of concerns:
#   1. tmcai-api         — Platform Layer (Express API)
#   2. tmcai-agent-worker — Agent Layer (ADK agents)
#   3. tmcai-bq-exporter — Cloud Function (PG→BQ nightly export)
# ═══════════════════════════════════════════════════════════════

variable "project_id" {
  type = string
}

# ───────────────────────────────────────
# 1. API Service Account (Platform Layer)
# ───────────────────────────────────────
resource "google_service_account" "api" {
  account_id   = "tmcai-api"
  display_name = "TMCAI API Server"
  description  = "Platform Layer: Express API, Pub/Sub publisher, Secret Manager reader"
  project      = var.project_id
}

# API SA Roles
resource "google_project_iam_member" "api_pubsub_publisher" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "api_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "api_storage_viewer" {
  project = var.project_id
  role    = "roles/storage.objectViewer"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "api_monitoring_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.api.email}"
}

resource "google_project_iam_member" "api_vertexai_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.api.email}"
}

# ───────────────────────────────────────
# 2. Agent Worker Service Account
# ───────────────────────────────────────
resource "google_service_account" "agent_worker" {
  account_id   = "tmcai-agent-worker"
  display_name = "TMCAI Agent Worker"
  description  = "Agent Layer: 7 ADK agents, Pub/Sub subscriber, Vertex AI caller"
  project      = var.project_id
}

resource "google_project_iam_member" "agent_pubsub_subscriber" {
  project = var.project_id
  role    = "roles/pubsub.subscriber"
  member  = "serviceAccount:${google_service_account.agent_worker.email}"
}

resource "google_project_iam_member" "agent_pubsub_publisher" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.agent_worker.email}"
}

resource "google_project_iam_member" "agent_vertexai_user" {
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.agent_worker.email}"
}

resource "google_project_iam_member" "agent_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.agent_worker.email}"
}

resource "google_project_iam_member" "agent_storage_reader" {
  project = var.project_id
  role    = "roles/storage.objectViewer"
  member  = "serviceAccount:${google_service_account.agent_worker.email}"
}

resource "google_project_iam_member" "agent_monitoring_writer" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.agent_worker.email}"
}

# ───────────────────────────────────────
# 3. BQ Exporter Service Account
# ───────────────────────────────────────
resource "google_service_account" "bq_exporter" {
  account_id   = "tmcai-bq-exporter"
  display_name = "TMCAI BigQuery Exporter"
  description  = "Cloud Function: nightly PG→BQ export, BQ writer, GCS staging writer"
  project      = var.project_id
}

resource "google_project_iam_member" "bq_exporter_bq_editor" {
  project = var.project_id
  role    = "roles/bigquery.dataEditor"
  member  = "serviceAccount:${google_service_account.bq_exporter.email}"
}

resource "google_project_iam_member" "bq_exporter_bq_job" {
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${google_service_account.bq_exporter.email}"
}

resource "google_project_iam_member" "bq_exporter_storage_writer" {
  project = var.project_id
  role    = "roles/storage.objectAdmin"
  member  = "serviceAccount:${google_service_account.bq_exporter.email}"
}

resource "google_project_iam_member" "bq_exporter_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.bq_exporter.email}"
}

# ───────────────────────────────────────
# Outputs
# ───────────────────────────────────────
output "api_sa_email" {
  value = google_service_account.api.email
}

output "agent_worker_sa_email" {
  value = google_service_account.agent_worker.email
}

output "bq_exporter_sa_email" {
  value = google_service_account.bq_exporter.email
}
