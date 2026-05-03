-- MyOS — explicit-consent escape hatch for decision_logs + delegation_logs
-- DELETE. The immutability trigger still blocks DELETE by default, but if
-- the calling transaction sets `myos.allow_log_delete = true` (via SET LOCAL),
-- the trigger lets the DELETE through. This is how the MD-initiated delete
-- endpoints work while ALL other writers stay locked out.
--
-- SET LOCAL is scoped to the active transaction — it auto-resets on commit
-- or rollback, so the bypass can't leak into unrelated queries.

CREATE OR REPLACE FUNCTION decision_logs_immutability() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Explicit opt-in check. `true` third arg means "return NULL if unset",
    -- i.e. default-deny.
    IF current_setting('myos.allow_log_delete', true) = 'true' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'decision_logs is append-only; row % cannot be deleted', OLD.id;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Existing UPDATE rule: only `outcome` is mutable.
    IF NEW.id                IS DISTINCT FROM OLD.id
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

CREATE OR REPLACE FUNCTION delegation_logs_immutability() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('myos.allow_log_delete', true) = 'true' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'delegation_logs is append-only; row % cannot be deleted', OLD.id;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.client_number       IS DISTINCT FROM OLD.client_number
    OR NEW.user_id             IS DISTINCT FROM OLD.user_id
    OR NEW.delegatee_user_id   IS DISTINCT FROM OLD.delegatee_user_id
    OR NEW.delegatee_email     IS DISTINCT FROM OLD.delegatee_email
    OR NEW.delegatee_name      IS DISTINCT FROM OLD.delegatee_name
    OR NEW.item_type           IS DISTINCT FROM OLD.item_type
    OR NEW.task_archetype      IS DISTINCT FROM OLD.task_archetype
    OR NEW.entity_id           IS DISTINCT FROM OLD.entity_id
    OR NEW.source_ref          IS DISTINCT FROM OLD.source_ref
    OR NEW.sender_email        IS DISTINCT FROM OLD.sender_email
    OR NEW.sender_domain       IS DISTINCT FROM OLD.sender_domain
    OR NEW.subject             IS DISTINCT FROM OLD.subject
    OR NEW.delegated_by        IS DISTINCT FROM OLD.delegated_by
    OR NEW.confidence_score    IS DISTINCT FROM OLD.confidence_score
    OR NEW.agent_id            IS DISTINCT FROM OLD.agent_id
    OR NEW.trace_id            IS DISTINCT FROM OLD.trace_id
    OR NEW.dedup_hash          IS DISTINCT FROM OLD.dedup_hash
    OR NEW.created_at          IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'delegation_logs is immutable except for brief_note';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
