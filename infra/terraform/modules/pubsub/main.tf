# ═══════════════════════════════════════════════════════════════
# Pub/Sub — 4 Topics + 4 DLQs (HaseebOS v15 Event Backbone)
# Topics: feed.raw → openitems.scored → actions.approved → steering.snapshot
# Each topic gets a dead-letter topic for failed messages
# ═══════════════════════════════════════════════════════════════

variable "project_id" {
  type = string
}

locals {
  topics = {
    "feed-raw" = {
      display    = "feed.raw"
      ordering   = true   # ordered by tenant_id
      desc       = "Raw feed events from connectors (Gmail, Calendar, WhatsApp, Drive)"
    }
    "openitems-scored" = {
      display    = "openitems.scored"
      ordering   = true   # ordered by priority_score
      desc       = "Scored and classified open items ready for action planning"
    }
    "actions-approved" = {
      display    = "actions.approved"
      ordering   = true   # ordered by risk_tier + created_at
      desc       = "Approved actions ready for execution by Action Executor agent"
    }
    "steering-snapshot" = {
      display    = "steering.snapshot"
      ordering   = false
      desc       = "Periodic KPI snapshots for Steering Wheel dashboard and Morning Brief"
    }
  }
}

# ───────────────────────────────────────
# Dead Letter Topics (one per main topic)
# ───────────────────────────────────────
resource "google_pubsub_topic" "dlq" {
  for_each = local.topics

  name    = "tmcai-${each.key}-dlq"
  project = var.project_id

  labels = {
    app         = "tmcai"
    component   = "haseebos"
    type        = "dead-letter"
    source_topic = each.key
  }

  message_retention_duration = "604800s" # 7 days retention for DLQ
}

# DLQ subscriptions (for monitoring and manual replay)
resource "google_pubsub_subscription" "dlq_sub" {
  for_each = local.topics

  name    = "tmcai-${each.key}-dlq-monitor"
  topic   = google_pubsub_topic.dlq[each.key].id
  project = var.project_id

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  retain_acked_messages      = true
  expiration_policy { ttl = "" } # Never expire

  labels = {
    app  = "tmcai"
    type = "dlq-monitor"
  }
}

# ───────────────────────────────────────
# Main Topics
# ───────────────────────────────────────
resource "google_pubsub_topic" "main" {
  for_each = local.topics

  name    = "tmcai-${each.key}"
  project = var.project_id

  message_retention_duration = "604800s" # 7 days

  labels = {
    app       = "tmcai"
    component = "haseebos"
    pipeline  = each.value.display
  }
}

# ───────────────────────────────────────
# Subscriptions with DLQ + retry policy
# ───────────────────────────────────────
resource "google_pubsub_subscription" "main" {
  for_each = local.topics

  name    = "tmcai-${each.key}-sub"
  topic   = google_pubsub_topic.main[each.key].id
  project = var.project_id

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s"
  expiration_policy { ttl = "" } # Never expire

  enable_message_ordering = each.value.ordering

  # Retry: exponential backoff 1s → 600s, max 5 attempts then DLQ
  retry_policy {
    minimum_backoff = "1s"
    maximum_backoff = "600s"
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dlq[each.key].id
    max_delivery_attempts = 5
  }

  labels = {
    app       = "tmcai"
    component = "haseebos"
  }
}

# ───────────────────────────────────────
# Outputs
# ───────────────────────────────────────
output "topic_names" {
  value = { for k, v in google_pubsub_topic.main : k => v.name }
}

output "topic_ids" {
  value = { for k, v in google_pubsub_topic.main : k => v.id }
}

output "subscription_names" {
  value = { for k, v in google_pubsub_subscription.main : k => v.name }
}

output "dlq_topic_names" {
  value = { for k, v in google_pubsub_topic.dlq : k => v.name }
}
