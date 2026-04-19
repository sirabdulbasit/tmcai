-- AlterTable
ALTER TABLE "agent_actions" ADD COLUMN     "dependency_graph_id" TEXT,
ADD COLUMN     "executed_by_agent" VARCHAR(50),
ADD COLUMN     "idempotency_key" VARCHAR(128),
ADD COLUMN     "risk_tier" VARCHAR(10),
ADD COLUMN     "undo_status" VARCHAR(20);

-- AlterTable
ALTER TABLE "decision_logs" ADD COLUMN     "agent_id" VARCHAR(50),
ADD COLUMN     "confidence_score" DOUBLE PRECISION,
ADD COLUMN     "duration_ms" INTEGER,
ADD COLUMN     "input_summary" TEXT,
ADD COLUMN     "output_summary" TEXT,
ADD COLUMN     "risk_tier" VARCHAR(10),
ADD COLUMN     "trace_id" VARCHAR(64);

-- AlterTable
ALTER TABLE "open_items" ADD COLUMN     "archetype" VARCHAR(30),
ADD COLUMN     "dedup_hash" VARCHAR(64),
ADD COLUMN     "enrichment_data" JSONB,
ADD COLUMN     "shadow_score" DOUBLE PRECISION,
ADD COLUMN     "source_feed_event_id" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "agent_config_overrides" JSONB,
ADD COLUMN     "kill_switch_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notification_preferences" JSONB,
ADD COLUMN     "risk_tolerance" VARCHAR(10);

-- CreateTable
CREATE TABLE "feed_events" (
    "id" TEXT NOT NULL,
    "client_number" VARCHAR(20) NOT NULL,
    "source_type" VARCHAR(30) NOT NULL,
    "source_id" VARCHAR(500) NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'new',
    "trace_id" VARCHAR(64),
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feed_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_memory" (
    "id" TEXT NOT NULL,
    "client_number" VARCHAR(20) NOT NULL,
    "agent_id" VARCHAR(50) NOT NULL,
    "memory_key" VARCHAR(200) NOT NULL,
    "memory_value" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_memory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_dependencies" (
    "id" SERIAL NOT NULL,
    "client_number" VARCHAR(20) NOT NULL,
    "parent_action_id" INTEGER NOT NULL,
    "child_action_id" INTEGER NOT NULL,
    "dependency_type" VARCHAR(30) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_dependencies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shadow_scores" (
    "id" TEXT NOT NULL,
    "client_number" VARCHAR(20) NOT NULL,
    "model_version" VARCHAR(50) NOT NULL,
    "agent_id" VARCHAR(50) NOT NULL,
    "rule_id" TEXT,
    "golden_dataset_id" TEXT,
    "score" DOUBLE PRECISION NOT NULL,
    "evaluation_details" JSONB NOT NULL,
    "evaluated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shadow_scores_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "golden_dataset" (
    "id" TEXT NOT NULL,
    "client_number" VARCHAR(20) NOT NULL,
    "category" VARCHAR(50) NOT NULL,
    "input_hash" VARCHAR(64) NOT NULL,
    "input_text" TEXT,
    "expected_output" JSONB NOT NULL,
    "score_threshold" DOUBLE PRECISION NOT NULL,
    "risk_tier" VARCHAR(10) NOT NULL,
    "cloud_storage_ref" VARCHAR(500),
    "last_evaluated_at" TIMESTAMP(3),
    "curated_by" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "golden_dataset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "kpi_values" (
    "id" SERIAL NOT NULL,
    "client_number" VARCHAR(20) NOT NULL,
    "metric_type" VARCHAR(50) NOT NULL,
    "metric_value" DOUBLE PRECISION NOT NULL,
    "dimensions" JSONB,
    "period_start" TIMESTAMP(3) NOT NULL,
    "period_end" TIMESTAMP(3) NOT NULL,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kpi_values_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_config_overrides" (
    "id" SERIAL NOT NULL,
    "client_number" VARCHAR(20) NOT NULL,
    "agent_type" VARCHAR(50) NOT NULL,
    "config_key" VARCHAR(100) NOT NULL,
    "config_value" JSONB NOT NULL,
    "override_reason" TEXT,
    "updated_by" INTEGER,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_config_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_queue" (
    "id" SERIAL NOT NULL,
    "client_number" VARCHAR(20) NOT NULL,
    "recipient_id" INTEGER NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "scheduled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "action_undo_log" (
    "id" SERIAL NOT NULL,
    "client_number" VARCHAR(20) NOT NULL,
    "action_id" INTEGER NOT NULL,
    "reverse_operation" JSONB NOT NULL,
    "diff_snapshot" JSONB,
    "executed_by" INTEGER,
    "undone_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "action_undo_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rule_lifecycle" (
    "id" TEXT NOT NULL,
    "client_number" VARCHAR(20) NOT NULL,
    "rule_name" VARCHAR(200) NOT NULL,
    "state" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "entered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "golden_score" DOUBLE PRECISION,
    "drift_std" DOUBLE PRECISION,
    "frozen" BOOLEAN NOT NULL DEFAULT false,
    "frozen_reason" TEXT,
    "rule_spec" JSONB NOT NULL,
    "risk_tier" VARCHAR(10) NOT NULL,
    "author_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rule_lifecycle_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feed_events_client_number_status_idx" ON "feed_events"("client_number", "status");

-- CreateIndex
CREATE INDEX "feed_events_client_number_source_type_created_at_idx" ON "feed_events"("client_number", "source_type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "feed_events_client_number_content_hash_key" ON "feed_events"("client_number", "content_hash");

-- CreateIndex
CREATE INDEX "agent_memory_expires_at_idx" ON "agent_memory"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_memory_client_number_agent_id_memory_key_key" ON "agent_memory"("client_number", "agent_id", "memory_key");

-- CreateIndex
CREATE INDEX "action_dependencies_client_number_parent_action_id_idx" ON "action_dependencies"("client_number", "parent_action_id");

-- CreateIndex
CREATE INDEX "action_dependencies_child_action_id_idx" ON "action_dependencies"("child_action_id");

-- CreateIndex
CREATE UNIQUE INDEX "action_dependencies_parent_action_id_child_action_id_key" ON "action_dependencies"("parent_action_id", "child_action_id");

-- CreateIndex
CREATE INDEX "shadow_scores_client_number_agent_id_evaluated_at_idx" ON "shadow_scores"("client_number", "agent_id", "evaluated_at");

-- CreateIndex
CREATE INDEX "shadow_scores_rule_id_evaluated_at_idx" ON "shadow_scores"("rule_id", "evaluated_at");

-- CreateIndex
CREATE INDEX "golden_dataset_client_number_category_risk_tier_idx" ON "golden_dataset"("client_number", "category", "risk_tier");

-- CreateIndex
CREATE UNIQUE INDEX "golden_dataset_client_number_input_hash_key" ON "golden_dataset"("client_number", "input_hash");

-- CreateIndex
CREATE INDEX "kpi_values_client_number_metric_type_period_start_idx" ON "kpi_values"("client_number", "metric_type", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "agent_config_overrides_client_number_agent_type_config_key_key" ON "agent_config_overrides"("client_number", "agent_type", "config_key");

-- CreateIndex
CREATE INDEX "notification_queue_client_number_status_scheduled_at_idx" ON "notification_queue"("client_number", "status", "scheduled_at");

-- CreateIndex
CREATE INDEX "notification_queue_recipient_id_idx" ON "notification_queue"("recipient_id");

-- CreateIndex
CREATE INDEX "action_undo_log_client_number_created_at_idx" ON "action_undo_log"("client_number", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "action_undo_log_action_id_key" ON "action_undo_log"("action_id");

-- CreateIndex
CREATE INDEX "rule_lifecycle_client_number_state_idx" ON "rule_lifecycle"("client_number", "state");

-- CreateIndex
CREATE UNIQUE INDEX "rule_lifecycle_client_number_rule_name_key" ON "rule_lifecycle"("client_number", "rule_name");

-- CreateIndex
CREATE UNIQUE INDEX "agent_actions_idempotency_key_key" ON "agent_actions"("idempotency_key");

-- CreateIndex
CREATE INDEX "agent_actions_dependency_graph_id_idx" ON "agent_actions"("dependency_graph_id");

-- CreateIndex
CREATE INDEX "agent_actions_executed_by_agent_idx" ON "agent_actions"("executed_by_agent");

-- CreateIndex
CREATE INDEX "decision_logs_trace_id_idx" ON "decision_logs"("trace_id");

-- CreateIndex
CREATE INDEX "decision_logs_client_number_risk_tier_idx" ON "decision_logs"("client_number", "risk_tier");

-- CreateIndex
CREATE INDEX "open_items_client_number_dedup_hash_idx" ON "open_items"("client_number", "dedup_hash");

-- CreateIndex
CREATE INDEX "open_items_source_feed_event_id_idx" ON "open_items"("source_feed_event_id");

