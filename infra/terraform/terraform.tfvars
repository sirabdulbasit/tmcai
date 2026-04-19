# ═══════════════════════════════════════════════════════════════
# TMCAI HaseebOS v15 — Terraform Variables
# Update these values for your environment
# ═══════════════════════════════════════════════════════════════

project_id  = "tmcai-491811"
region      = "us-central1"
environment = "prod"
alert_email = "basit.ahmed@tmcltd.ai"

# Pub/Sub: set to false to use BullMQ on local Redis (saves ~$60/mo)
# Set to true only if you need cloud-native Pub/Sub
use_pubsub = false

# BQ export schedule (UTC)
bq_export_schedule = "0 2 * * *"

# Message retention (7 days)
pubsub_message_retention = "604800s"
