-- Living Assistant Standard §6 — the record that makes scoring real.
--
-- Owner, 2026-08-07: "first describe the Standard how brain should think, react
-- and take action like living assistant ... and then analyze brain every
-- response as per that standard and keep analyzing through armed/alive watcher".
--
-- Why a table and not a log line: the same reason brain_health_findings exists.
-- A score in a rotating log tells whoever happens to be reading. A score in a
-- row can be grouped by criterion, trended over time, and turned into a finding
-- when the same weakness keeps recurring. Without that, this is scoring for its
-- own sake — which is exactly what gapDetectionJob already does, persisting
-- "gap candidates for admin review" that no reviewer has ever read.
--
-- EVERY response is scored, not a sample: the defect that only appears on the
-- turn nobody sampled is the one that reaches the user.
--
-- Additive, idempotent, no backfill — past turns cannot be honestly scored
-- after the fact.

CREATE TABLE IF NOT EXISTS brain_response_evaluations (
  id             TEXT PRIMARY KEY,
  client_number  VARCHAR(20)  NOT NULL,
  user_id        INTEGER      NOT NULL,
  -- Which surface the turn happened on. The standard applies everywhere, but a
  -- WhatsApp reply and a Day Brief fail in different ways, and pooling them
  -- would hide both.
  surface        VARCHAR(24)  NOT NULL DEFAULT 'whatsapp',
  -- Correlation back to the actual exchange, so a bad score can be read in
  -- context rather than argued about in the abstract.
  message_id     TEXT,
  user_message   TEXT,
  brain_response TEXT,
  -- 0-100, the mean of the criterion scores. Bands (standard §3):
  -- >=85 good, 70-84 acceptable, 50-69 weak, <50 defect.
  overall_score  INTEGER      NOT NULL,
  -- Per-criterion detail: { "C1": { "score": 90, "reason": "..." }, ... }
  -- JSONB rather than 8 columns: the criteria are a standard that will grow,
  -- and adding C9 must not require a migration on the hot path.
  criteria       JSONB        NOT NULL,
  -- The criteria that scored below band, extracted for cheap grouping. This is
  -- the column the learning loop reads: "which criterion keeps failing?" must
  -- not require unnesting JSON across every row.
  weak_criteria  TEXT[]       NOT NULL DEFAULT '{}',
  -- One line on what would have made this response better. The most useful
  -- field for a human or an agent reading a bad turn.
  improvement    TEXT,
  -- Which model judged, so a scoring shift can be told apart from a behaviour
  -- shift. Without it, "Brain got worse on Tuesday" is unfalsifiable.
  judge_provider VARCHAR(32),
  -- Set once this evaluation contributed to a finding, so the same weak turn is
  -- not counted twice toward the same recurring failure.
  finding_id     TEXT,
  evaluated_at   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- "How is Brain doing lately, for this user?" — the trend read, and the one the
-- daily report is built from.
CREATE INDEX IF NOT EXISTS brain_response_evaluations_recent_ix
  ON brain_response_evaluations (client_number, user_id, evaluated_at DESC);

-- "Show me the bad turns." Partial, because good turns are the overwhelming
-- majority and indexing them buys nothing.
CREATE INDEX IF NOT EXISTS brain_response_evaluations_weak_ix
  ON brain_response_evaluations (client_number, overall_score, evaluated_at DESC)
  WHERE overall_score < 70;

-- "Which criterion keeps failing?" — GIN over the array so the learning loop can
-- ask that question directly instead of scanning.
CREATE INDEX IF NOT EXISTS brain_response_evaluations_criteria_ix
  ON brain_response_evaluations USING GIN (weak_criteria);
