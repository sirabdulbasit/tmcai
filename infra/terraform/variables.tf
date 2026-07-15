# ═══════════════════════════════════════════════════════════════
# Input Variables
# ═══════════════════════════════════════════════════════════════

variable "project_id" {
  description = "GCP project ID"
  type        = string
  default     = "tmcai-491811"
}

variable "region" {
  description = "Primary GCP region"
  type        = string
  default     = "us-central1"
}

variable "environment" {
  description = "Environment: dev, staging, prod"
  type        = string
  default     = "prod"
}

variable "alert_email" {
  description = "Email for monitoring alerts"
  type        = string
  default     = "basit.ahmed@tmcltd.ai"
}

variable "pubsub_message_retention" {
  description = "Pub/Sub message retention duration"
  type        = string
  default     = "604800s" # 7 days
}

variable "bq_export_schedule" {
  description = "Cron schedule for nightly PG→BQ export"
  type        = string
  default     = "0 2 * * *" # 2:00 AM UTC daily
}

variable "use_pubsub" {
  description = "Use GCP Pub/Sub (true) or BullMQ on local Redis (false). Set false to save ~$60/mo."
  type        = bool
  default     = false  # BullMQ recommended at current scale
}
