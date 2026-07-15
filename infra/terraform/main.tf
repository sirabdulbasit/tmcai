# ═══════════════════════════════════════════════════════════════
# HaseebOS v15 — Full GCP Infrastructure
# Project: tmcai-491811
# Strategy: TMCAI Hybrid (Ubuntu Server + GCP services)
# ═══════════════════════════════════════════════════════════════

terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
  }

  # Remote state in GCS (recommended for team use)
  # Uncomment after creating the state bucket:
  # backend "gcs" {
  #   bucket = "tmcai-terraform-state"
  #   prefix = "haseebos-v15"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

# ───────────────────────────────────────
# Enable required GCP APIs
# ───────────────────────────────────────
resource "google_project_service" "apis" {
  for_each = toset([
    "pubsub.googleapis.com",
    "bigquery.googleapis.com",
    "bigquerydatatransfer.googleapis.com",
    "storage.googleapis.com",
    "cloudfunctions.googleapis.com",
    "cloudscheduler.googleapis.com",
    "secretmanager.googleapis.com",
    "monitoring.googleapis.com",
    "logging.googleapis.com",
    "cloudbuild.googleapis.com",
    "run.googleapis.com",
    "aiplatform.googleapis.com",       # Vertex AI for Gemini
    "vpcaccess.googleapis.com",
    "iam.googleapis.com",
  ])

  service            = each.value
  disable_on_destroy = false
}

# ───────────────────────────────────────
# Module calls
# ───────────────────────────────────────
module "iam" {
  source     = "./modules/iam"
  project_id = var.project_id
  depends_on = [google_project_service.apis]
}

module "pubsub" {
  source     = "./modules/pubsub"
  project_id = var.project_id
  depends_on = [google_project_service.apis]
}

module "bigquery" {
  source     = "./modules/bigquery"
  project_id = var.project_id
  region     = var.region
  depends_on = [google_project_service.apis]
}

module "storage" {
  source     = "./modules/storage"
  project_id = var.project_id
  region     = var.region
  depends_on = [google_project_service.apis]
}

module "secrets" {
  source     = "./modules/secrets"
  project_id = var.project_id
  depends_on = [google_project_service.apis]
}

module "scheduler" {
  source     = "./modules/scheduler"
  project_id = var.project_id
  region     = var.region
  bq_export_function_url = module.functions.bq_export_function_url
  depends_on = [module.functions]
}

module "functions" {
  source              = "./modules/functions"
  project_id          = var.project_id
  region              = var.region
  bq_export_sa_email  = module.iam.bq_exporter_sa_email
  source_bucket       = module.storage.function_source_bucket
  depends_on          = [module.iam, module.storage]
}

module "monitoring" {
  source     = "./modules/monitoring"
  project_id = var.project_id
  depends_on = [module.pubsub, module.bigquery]
}
