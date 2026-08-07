-- Layer 1 of self-healing: make diagnostic truth QUERYABLE.
--
-- Every defect on 2026-08-06/07 reached us because the owner reported it.
-- Seven health jobs were running and not one raised a thing. The two most
-- important pieces of evidence that day —
--
--   `inbound consume failed, reason: illegal_transition`   (DEF-064)
--   Hamna's 14:00 reply, which produced no row at all      (DEF-080)
--
-- existed ONLY in pm2 logs: unqueryable, rotated, gone. Nothing could reason
-- over them, so each break had to be found by hand, one at a time, over about
-- ten rounds. A system cannot heal what it cannot query.
--
-- This is deliberately NOT an eighth job. The existing seven fail for three
-- reasons (HANDOFF 2026-08-07 §5): they watch components instead of outcomes,
-- they write to tables nobody opens, and they cannot see meaning. This table
-- fixes the FIRST of those and is the prerequisite for the other two — a
-- finding here is what the self-heal pass reads, what the perturbation
-- generator learns from, and what the notify stage summarises.
--
-- Additive, idempotent, no backfill: historical failures are genuinely
-- unrecoverable, and inventing rows for them would be the fabrication this
-- table exists to prevent.

CREATE TABLE IF NOT EXISTS brain_health_findings (
  id                TEXT PRIMARY KEY,
  client_number     VARCHAR(20)  NOT NULL,
  -- Stable class key, e.g. 'reply_consume_failed', 'raw_query_failed',
  -- 'ask_never_notified', 'llm_judgement_fallback'. The recurrence table in
  -- brain_evaluation_chart.md §3 is built by grouping on this: a class that
  -- reappears means the earlier fix did not close it, which forbids another
  -- patch on the reported instance.
  kind              VARCHAR(64)  NOT NULL,
  severity          VARCHAR(16)  NOT NULL DEFAULT 'warn',
  -- Where it happened, and to WHICH ask. `subject_type`/`subject_id` are what
  -- let a finding be joined back to the delegation thread, prompt or message
  -- it belongs to — the join whose absence made "she answered and he never
  -- heard about it" unanswerable.
  source            VARCHAR(64)  NOT NULL,
  subject_type      VARCHAR(32),
  subject_id        TEXT,
  user_id           INTEGER,
  summary           TEXT         NOT NULL,
  -- The state at the time. Whatever the diagnosing agent will wish it had:
  -- the thread state that refused the transition, the failing query code, the
  -- LLM error behind a silent fallback.
  evidence          JSONB,
  -- Healing lifecycle. `open` -> `healed` (a repair rule fixed it) or
  -- `resolved` (a code fix shipped). `heal_attempts` exists so a rule that
  -- cannot fix something stops trying and escalates instead of looping.
  status            VARCHAR(16)  NOT NULL DEFAULT 'open',
  heal_attempts     INTEGER      NOT NULL DEFAULT 0,
  healed_at         TIMESTAMP(3),
  heal_action       VARCHAR(64),
  -- Was the OWNER told about this finding? Same discipline as
  -- delegation_threads.owner_notified_at (DEF-081): stamped only after a
  -- CONFIRMED send, never at enqueue. Written is not delivered.
  notified_at       TIMESTAMP(3),
  -- Set once a DEF row exists in brain_change_log.md, so a finding cannot be
  -- silently dropped without becoming a tracked defect.
  def_id            VARCHAR(16),
  first_seen_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- A failure firing every 90 seconds for 24 hours (DEF-085) is ONE finding
  -- seen 960 times, not 960 findings. Collapsing it is what keeps the table
  -- readable enough to act on.
  occurrences       INTEGER      NOT NULL DEFAULT 1,
  created_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- The dedup target: one open row per (tenant, kind, subject). This is what
-- turns a log storm into a single actionable finding with a counter.
CREATE UNIQUE INDEX IF NOT EXISTS brain_health_findings_open_uq
  ON brain_health_findings (client_number, kind, COALESCE(subject_id, ''))
  WHERE status = 'open';

-- "What is wrong right now?" — the self-heal pass's primary read.
CREATE INDEX IF NOT EXISTS brain_health_findings_open_ix
  ON brain_health_findings (client_number, severity, last_seen_at DESC)
  WHERE status = 'open';

-- "What has he not been told about?" — the notify stage's read. Partial on the
-- null case for the same reason as delegation_threads_unnotified_ix.
CREATE INDEX IF NOT EXISTS brain_health_findings_unnotified_ix
  ON brain_health_findings (client_number, notified_at)
  WHERE notified_at IS NULL AND status = 'open';

-- Recurrence: is this class coming back? Drives the circling-vs-progressing
-- verdict that CLAUDE.md requires be said out loud before coding.
CREATE INDEX IF NOT EXISTS brain_health_findings_kind_ix
  ON brain_health_findings (client_number, kind, first_seen_at DESC);
