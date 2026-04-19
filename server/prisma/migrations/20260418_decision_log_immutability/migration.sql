-- HaseebOS v15 — decision_logs immutability (Phase 5, Decision Log L3)
-- Spec: DecisionLog is the operational L3 view. Outcome may be updated by
-- a nightly job (decisionsLogService.assessOutcomesForAllTenants), but every
-- other field is write-once. DELETE is always blocked.

CREATE OR REPLACE FUNCTION decision_logs_immutability() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'decision_logs is append-only — DELETE is not permitted';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Only the outcome column may change post-hoc.
    IF  NEW.id                IS DISTINCT FROM OLD.id
     OR NEW.user_id           IS DISTINCT FROM OLD.user_id
     OR NEW.client_number     IS DISTINCT FROM OLD.client_number
     OR NEW.session_type      IS DISTINCT FROM OLD.session_type
     OR NEW.item_type         IS DISTINCT FROM OLD.item_type
     OR NEW.entity_id         IS DISTINCT FROM OLD.entity_id
     OR NEW.connector_slug    IS DISTINCT FROM OLD.connector_slug
     OR NEW.suggested_action  IS DISTINCT FROM OLD.suggested_action
     OR NEW.user_decision     IS DISTINCT FROM OLD.user_decision
     OR NEW.action_taken      IS DISTINCT FROM OLD.action_taken
     OR NEW.is_match          IS DISTINCT FROM OLD.is_match
     OR NEW.override_reason   IS DISTINCT FROM OLD.override_reason
     OR NEW.response_time_ms  IS DISTINCT FROM OLD.response_time_ms
     OR NEW.open_item_id      IS DISTINCT FROM OLD.open_item_id
     OR NEW.confidence_score  IS DISTINCT FROM OLD.confidence_score
     OR NEW.risk_tier         IS DISTINCT FROM OLD.risk_tier
     OR NEW.input_summary     IS DISTINCT FROM OLD.input_summary
     OR NEW.output_summary    IS DISTINCT FROM OLD.output_summary
     OR NEW.duration_ms       IS DISTINCT FROM OLD.duration_ms
     OR NEW.trace_id          IS DISTINCT FROM OLD.trace_id
     OR NEW.agent_id          IS DISTINCT FROM OLD.agent_id
     OR NEW.created_at        IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'decision_logs is immutable except for the outcome column';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS decision_logs_immutability_trigger ON decision_logs;
CREATE TRIGGER decision_logs_immutability_trigger
  BEFORE UPDATE OR DELETE ON decision_logs
  FOR EACH ROW EXECUTE FUNCTION decision_logs_immutability();
