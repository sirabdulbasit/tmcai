-- HaseebOS v15 L5.6 — Operational view over decision_logs for the Steering Wheel.
-- Shows the last 30 days of decisions with joined OpenItem / Entity context so
-- the UI can render timelines without additional joins. Always fresh (view).

CREATE OR REPLACE VIEW decision_operational AS
SELECT
  d.id               AS decision_id,
  d.client_number,
  d.user_id,
  d.trace_id,
  d.agent_id         AS agent_name,
  d.item_type        AS decision_type,
  d.risk_tier,
  d.user_decision    AS outcome,
  d.override_reason  AS reason,
  d.input_summary,
  d.output_summary,
  d.confidence_score,
  d.duration_ms,
  d.created_at       AS recorded_at,
  d.open_item_id,
  o.title            AS open_item_title,
  o.status           AS open_item_status,
  o.priority         AS open_item_priority,
  o.archetype        AS open_item_archetype,
  d.entity_id,
  e.name             AS entity_name,
  e.entity_type      AS entity_type
FROM decision_logs d
LEFT JOIN open_items o
  ON o.id = d.open_item_id AND o.client_number = d.client_number
LEFT JOIN entities e
  ON e.id = d.entity_id AND e.client_number = d.client_number
WHERE d.created_at > NOW() - INTERVAL '30 days';
