# ═══════════════════════════════════════════════════════════════
# Cloud Storage — 3 Buckets
#   1. Golden Datasets (shadow scoring reference data)
#   2. BQ Staging (export staging area with auto-cleanup)
#   3. Backups (Ubuntu server disaster recovery)
# ═══════════════════════════════════════════════════════════════

variable "project_id" {
  type = string
}

variable "region" {
  type = string
}

# ───────────────────────────────────────
# 1. Golden Dataset Bucket
# ───────────────────────────────────────
resource "google_storage_bucket" "golden_datasets" {
  name          = "${var.project_id}-golden-datasets"
  location      = var.region
  project       = var.project_id
  storage_class = "STANDARD"

  uniform_bucket_level_access = true

  versioning {
    enabled = true # Keep history of golden dataset changes
  }

  labels = {
    app       = "tmcai"
    component = "haseebos"
    purpose   = "golden-datasets"
  }
}

# ───────────────────────────────────────
# 2. BQ Export Staging Bucket
# ───────────────────────────────────────
resource "google_storage_bucket" "bq_staging" {
  name          = "${var.project_id}-bq-staging"
  location      = var.region
  project       = var.project_id
  storage_class = "STANDARD"

  uniform_bucket_level_access = true

  # Auto-delete staging files after 7 days
  lifecycle_rule {
    condition {
      age = 7
    }
    action {
      type = "Delete"
    }
  }

  labels = {
    app       = "tmcai"
    component = "haseebos"
    purpose   = "bq-staging"
  }
}

# ───────────────────────────────────────
# 3. Backup Bucket (Ubuntu DR)
# ───────────────────────────────────────
resource "google_storage_bucket" "backups" {
  name          = "${var.project_id}-backups"
  location      = var.region
  project       = var.project_id
  storage_class = "NEARLINE" # Cheaper for infrequent access

  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  # Move to Coldline after 90 days, delete after 365
  lifecycle_rule {
    condition {
      age = 90
    }
    action {
      type          = "SetStorageClass"
      storage_class = "COLDLINE"
    }
  }

  lifecycle_rule {
    condition {
      age = 365
    }
    action {
      type = "Delete"
    }
  }

  labels = {
    app     = "tmcai"
    purpose = "disaster-recovery"
  }
}

# ───────────────────────────────────────
# 4. Cloud Function Source Bucket
# ───────────────────────────────────────
resource "google_storage_bucket" "function_source" {
  name          = "${var.project_id}-function-source"
  location      = var.region
  project       = var.project_id
  storage_class = "STANDARD"

  uniform_bucket_level_access = true

  labels = {
    app     = "tmcai"
    purpose = "cloud-function-source"
  }
}

# ───────────────────────────────────────
# Outputs
# ───────────────────────────────────────
output "golden_dataset_bucket" {
  value = google_storage_bucket.golden_datasets.name
}

output "bq_staging_bucket" {
  value = google_storage_bucket.bq_staging.name
}

output "backup_bucket" {
  value = google_storage_bucket.backups.name
}

output "function_source_bucket" {
  value = google_storage_bucket.function_source.name
}
