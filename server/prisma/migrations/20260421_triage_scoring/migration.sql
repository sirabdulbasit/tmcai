-- MyOS — Day Brief redesign backing tables.
--
-- Supports the three-section brief:
--   1. Brief (autonomous) — past-tense actions Brain took via active shadow
--      rules. Read from existing agent_actions.
--   2. My Attention — unread feed_events that Brain has suggested an action
--      for. Each MD click writes an append-only decision_log (for reply /
--      ignore / open-item) or delegation_log (for delegate) with a
--      canonical dedup_hash. Score = COUNT GROUP BY dedup_hash.
--   3. Open Items — existing open_items table, with Brain-suggested next
--      actions (same learning loop).
--
-- Rule mining job later reads the hash distributions and auto-promotes
-- high-score, high-consistency patterns into shadow_rules.

-- ─── 1. dedup_hash on decision_logs ──────────────────────────────
-- Stays NULL for legacy (pre-hash) rows. New rows compute sha256 over
-- (user_id, item_type, action_taken, archetype, sender_domain) in the
-- service layer at insert time.
-- NOTE: decision_logs has an immutability trigger — ADD COLUMN is allowed,
-- UPDATE is not. Column defaults to NULL; we never backfill.
ALTER TABLE "decision_logs"
  ADD COLUMN IF NOT EXISTS "dedup_hash" VARCHAR(64);

CREATE INDEX IF NOT EXISTS "decision_logs_client_user_dedup_idx"
  ON "decision_logs" ("client_number", "user_id", "dedup_hash");

-- ─── 2. delegation_logs table ────────────────────────────────────
-- Append-only log of every delegation the MD (or Brain) has ever
-- performed. Dedup_hash groups "same archetype delegated to same person"
-- so the score is a simple COUNT GROUP BY.
CREATE TABLE IF NOT EXISTS "delegation_logs" (
  "id"                   TEXT PRIMARY KEY,
  "client_number"        VARCHAR(20) NOT NULL,
  "user_id"              INTEGER NOT NULL,           -- the delegator (MD)
  "delegatee_user_id"    INTEGER,                    -- internal TMC user if known
  "delegatee_email"      VARCHAR(200),               -- external / unknown user
  "delegatee_name"       VARCHAR(200),
  "item_type"            VARCHAR(30) NOT NULL,       -- email | whatsapp | task | meeting
  "task_archetype"       VARCHAR(40),                -- reply | follow_up | review | approval | status_update | introduction | other
  "entity_id"            TEXT,                       -- optional: open_item / feed_event id
  "source_ref"           VARCHAR(500),               -- gmail thread, whatsapp session, etc.
  "sender_email"         VARCHAR(200),               -- who originally sent the email we're delegating about
  "sender_domain"        VARCHAR(100),
  "subject"              TEXT,
  "brief_note"           TEXT,                       -- MD's note on why
  "delegated_by"         VARCHAR(20) NOT NULL DEFAULT 'user', -- user | brain
  "confidence_score"     DOUBLE PRECISION,           -- if brain-auto
  "agent_id"             VARCHAR(50),
  "trace_id"             VARCHAR(64),
  -- canonical signature over (user_id, item_type, task_archetype,
  --  delegatee_key, sender_domain) — delegatee_key = delegatee_user_id
  --  or lowercased delegatee_email. Score = COUNT GROUP BY.
  "dedup_hash"           VARCHAR(64) NOT NULL,
  "created_at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "delegation_logs_client_user_idx"
  ON "delegation_logs" ("client_number", "user_id", "created_at");
CREATE INDEX IF NOT EXISTS "delegation_logs_dedup_idx"
  ON "delegation_logs" ("client_number", "user_id", "dedup_hash");
CREATE INDEX IF NOT EXISTS "delegation_logs_archetype_idx"
  ON "delegation_logs" ("client_number", "user_id", "task_archetype", "created_at");

-- delegation_logs is also append-only for audit. Add an immutability trigger
-- mirroring decision_logs so delegatee_email / subject / etc. can never be
-- retroactively edited.
CREATE OR REPLACE FUNCTION delegation_logs_immutability() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'delegation_logs is append-only; row % cannot be deleted', OLD.id;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Allow only `brief_note` to be amended (MD can add color after the fact).
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

DROP TRIGGER IF EXISTS delegation_logs_immutability_trigger ON delegation_logs;
CREATE TRIGGER delegation_logs_immutability_trigger
  BEFORE DELETE OR UPDATE ON delegation_logs
  FOR EACH ROW EXECUTE FUNCTION delegation_logs_immutability();

-- ─── 3. Per-user soft-hide index table ─────────────────────────
-- When the MD hides a pattern from My Attention section (e.g. a recurring
-- newsletter they want Brain to stop asking about), insert a row here. The
-- append-only logs stay intact for audit; the UI just filters them out.
CREATE TABLE IF NOT EXISTS "pattern_hidden" (
  "user_id"        INTEGER NOT NULL,
  "client_number"  VARCHAR(20) NOT NULL,
  "source"         VARCHAR(20) NOT NULL,  -- decision | delegation
  "dedup_hash"     VARCHAR(64) NOT NULL,
  "reason"         TEXT,
  "hidden_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("user_id", "source", "dedup_hash")
);
CREATE INDEX IF NOT EXISTS "pattern_hidden_client_idx"
  ON "pattern_hidden" ("client_number", "source");
