-- ============================================================
-- 20260505_retrieval_feedback
--
-- Per-(user, page) feedback signal for retrieval re-ranking. Each row
-- accumulates positive_uses and negative_uses; the re-ranker reads the
-- pair via a smoothed score and multiplies it onto vector similarity
-- before final ranking.
--
-- Signal sources (recordPositiveSignal / recordNegativeSignal in
-- retrievalFeedbackService):
--   - 👍 on a chat_answer with cited wiki_pages → +1 to each cited page
--   - 👍 on a retry chat_answer (corrected version) → +1 to each cited
--     page (those were the RIGHT pages once steered)
--   - 👎 on a chat_answer whose diagnosis category is in
--     {wrong_source, retrieval_miss} → -1 to each cited page
--
-- Other diagnosis categories (wrong_tone, too_verbose, hallucination)
-- don't penalise retrieval — those are composer issues, not retrieval
-- issues.
--
-- The smoothed score (computed in code, not DB):
--   net = (pos - neg) / (pos + neg + 5)
--   boost = clamp(net, -0.4, +0.4)
-- The +5 prior weight makes small samples close to zero; high counts
-- in one direction approach ±0.4 asymptotically.
--
-- Re-ranker multiplies vector_similarity by (1 + boost). So a strongly
-- positive page gets up to 40% bonus on its similarity; a strongly
-- negative page gets up to 40% penalty. The boost is bounded to keep
-- the vector signal dominant — feedback steers, doesn't override.
-- ============================================================

CREATE TABLE IF NOT EXISTS retrieval_feedback (
  id                BIGSERIAL PRIMARY KEY,
  client_number     VARCHAR(20) NOT NULL,
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- wiki_pages.id (text) — the candidate page being scored. Not a FK
  -- because the wiki page may be deleted while the feedback signal
  -- should survive (the DELETE-CASCADE-on-user already covers tenant
  -- offboarding).
  page_id           TEXT NOT NULL,
  positive_uses     INTEGER NOT NULL DEFAULT 0,
  negative_uses     INTEGER NOT NULL DEFAULT 0,
  last_positive_at  TIMESTAMP,
  last_negative_at  TIMESTAMP,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMP NOT NULL DEFAULT now(),
  updated_at        TIMESTAMP NOT NULL DEFAULT now()
);

-- One row per (user, page) — positive_uses and negative_uses accumulate
-- via UPDATE rather than INSERT, so we need uniqueness here.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rf_user_page
  ON retrieval_feedback (user_id, page_id);

-- Re-ranker fetches boosts in one query keyed by user + page-id-set.
CREATE INDEX IF NOT EXISTS idx_rf_user_lookup
  ON retrieval_feedback (user_id, page_id);

-- Tenant audit / "what is Brain learning?" view.
CREATE INDEX IF NOT EXISTS idx_rf_tenant
  ON retrieval_feedback (client_number, updated_at DESC);
