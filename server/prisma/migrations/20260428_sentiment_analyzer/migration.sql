-- Tier 2 — Sentiment + urgency analyzer.
--
-- Today the criticality engine reasons about tone implicitly via its
-- 5-dim LLM fusion. That blends tone into the composite score but
-- doesn't expose it as an independent signal. Adding explicit per-message
-- sentiment + urgency unlocks:
--   · Risk Radar can flag "Faisal sounds frustrated this week"
--   · Gate engine rules can match "sentiment >= 0.6 AND urgency < 0.3"
--   · Auto-response trigger ladder can fire on (urgent + positive + low risk)
--   · Per-entity rolling tone tracking ("typical = collaborative;
--     this week = hostile" → anomaly signal)
--
-- Storage: 4 columns added to `feed_events` populated by sentimentService
-- as an async post-ingest enrichment. The classifier is run once per
-- event; results are cached on the row so downstream consumers (Risk
-- Radar, criticality engine, Brain composer) just read.

ALTER TABLE feed_events
  -- -1.0 (very negative) .. +1.0 (very positive). NULL = not yet analyzed.
  ADD COLUMN IF NOT EXISTS sentiment_score NUMERIC(4,3),
  -- 0.0 .. 1.0. How time-sensitive the message is, independent of tone.
  -- A polite "could you confirm by EOD?" can be high urgency + neutral
  -- sentiment; a frustrated rant about an old issue is negative sentiment
  -- + low urgency.
  ADD COLUMN IF NOT EXISTS urgency_score NUMERIC(4,3),
  -- One-word tone bucket for fast filtering: 'collaborative' | 'neutral'
  -- | 'frustrated' | 'hostile' | 'transactional' | 'positive_warm'.
  ADD COLUMN IF NOT EXISTS tone VARCHAR(30),
  -- Free-text 1-2 sentence rationale from the classifier. Audit + UI hover.
  ADD COLUMN IF NOT EXISTS sentiment_rationale TEXT,
  -- When was the analysis run? NULL = not yet enriched.
  ADD COLUMN IF NOT EXISTS sentiment_analyzed_at TIMESTAMPTZ;

-- Index on (client_number, sentiment_analyzed_at IS NULL) so the
-- backfill worker can find unanalyzed rows fast.
CREATE INDEX IF NOT EXISTS feed_events_sentiment_pending_idx
  ON feed_events (client_number, created_at DESC)
  WHERE sentiment_analyzed_at IS NULL;

-- Index for "show me everything that came in angry today" queries on
-- the user-facing UI.
CREATE INDEX IF NOT EXISTS feed_events_sentiment_lookup_idx
  ON feed_events (client_number, user_id, sentiment_score, created_at DESC)
  WHERE sentiment_score IS NOT NULL;
