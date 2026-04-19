-- HaseebOS v15 L5.4 — BigQuery decision archive (immutable audit)
-- Created once per project by cowork/GCP; the sink only appends.
-- Partitioned daily so Reflection can scan a single day cheaply.

CREATE SCHEMA IF NOT EXISTS tmcai_decisions;

CREATE TABLE IF NOT EXISTS tmcai_decisions.decision_archive (
  tenant_id        STRING,
  decision_id      STRING NOT NULL,
  trace_id         STRING,
  agent_name       STRING,
  decision_type    STRING,
  input_summary    STRING,
  output_summary   STRING,
  risk_tier        STRING,
  action_id        INT64,
  open_item_id     STRING,
  feed_event_id    STRING,
  entity_id        STRING,
  outcome          STRING,    -- success | failure | overridden
  reason           STRING,
  rule_version     STRING,
  shadow_mode      STRING,    -- DRAFT | SHADOW | ACTIVE
  recorded_at      TIMESTAMP
)
PARTITION BY DATE(recorded_at)
CLUSTER BY tenant_id, agent_name;

-- L5.5 — Curated training-set view.
-- Joins decisions with outcomes (+3 days of subsequent status transitions) so
-- Rule Miner can train on (context → decision → confirmed outcome) triples.
CREATE OR REPLACE VIEW tmcai_decisions.decision_training AS
WITH positive AS (
  SELECT
    tenant_id,
    decision_id,
    open_item_id,
    action_id,
    recorded_at,
    'confirmed' AS confirmation
  FROM tmcai_decisions.decision_archive
  WHERE outcome = 'success' AND open_item_id IS NOT NULL
),
negative AS (
  SELECT
    tenant_id,
    decision_id,
    open_item_id,
    action_id,
    recorded_at,
    'overridden' AS confirmation
  FROM tmcai_decisions.decision_archive
  WHERE outcome IN ('failure', 'overridden')
)
SELECT
  a.tenant_id,
  a.decision_id,
  a.trace_id,
  a.agent_name,
  a.decision_type,
  a.input_summary,
  a.output_summary,
  a.risk_tier,
  a.action_id,
  a.open_item_id,
  a.feed_event_id,
  a.entity_id,
  a.rule_version,
  a.shadow_mode,
  COALESCE(p.confirmation, n.confirmation, 'unknown') AS label,
  a.recorded_at
FROM tmcai_decisions.decision_archive a
LEFT JOIN positive p USING (tenant_id, decision_id)
LEFT JOIN negative n USING (tenant_id, decision_id)
WHERE a.shadow_mode IN ('SHADOW', 'ACTIVE'); -- DRAFT is too noisy for training
