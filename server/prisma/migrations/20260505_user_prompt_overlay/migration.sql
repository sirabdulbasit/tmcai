-- ============================================================
-- 20260505_user_prompt_overlay
--
-- Per-user prompt overlay — a growing personal addendum to Brain's
-- composer system prompt. Each row is one one-line directive derived
-- either from feedback diagnosis (auto-promoted when the same category
-- recurs) or hand-typed by the user on the Settings page.
--
-- Rules are visible to the user — they can review, edit, disable, or
-- delete any rule. Reset button on the UI clears the whole overlay.
-- The composer reads ACTIVE rules and prepends them to its system
-- prompt under "Personal preferences" so the LLM corrects course on
-- every subsequent answer, not just the immediate retry.
--
-- Auto-promote heuristic (in userPromptOverlayService.maybePromote):
--   - Diagnosis confidence ≥ 0.7
--   - Category in the promotable set (wrong_tone, too_verbose, too_terse,
--     wrong_person_scope, missed_context, hallucination)
--   - Same category has at least one prior matching diagnosis in the
--     last 14 days for the same user (i.e. this is the SECOND time
--     Brain has missed in this way — pattern, not one-off).
-- ============================================================

CREATE TABLE IF NOT EXISTS user_prompt_overlay (
  id              BIGSERIAL PRIMARY KEY,
  client_number   VARCHAR(20) NOT NULL,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  rule_text       TEXT NOT NULL,
  source          VARCHAR(30) NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('feedback_diagnosis','manual','system_seed')),
  -- The diagnosis wiki page that triggered the auto-promote, if any.
  source_diagnosis_id  TEXT,
  -- Category from the diagnosis ('wrong_tone' / 'too_verbose' / …).
  -- For manual rules, user picks from the same enum or 'custom'.
  category        VARCHAR(40) NOT NULL DEFAULT 'custom',

  active          BOOLEAN NOT NULL DEFAULT TRUE,
  -- Free-form audit metadata (e.g. promote-trigger details).
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Telemetry: how often this rule has been injected into a composer
  -- system prompt. The composer increments lazily via a single UPDATE
  -- per turn, so high counts mean "Brain leans on this every answer".
  hits_count      INTEGER NOT NULL DEFAULT 0,
  last_hit_at     TIMESTAMP,

  created_at      TIMESTAMP NOT NULL DEFAULT now(),
  updated_at      TIMESTAMP NOT NULL DEFAULT now()
);

-- Composer fetches ALL active rules for the user; this index drives
-- that and the Settings list-view.
CREATE INDEX IF NOT EXISTS idx_upo_user_active
  ON user_prompt_overlay (client_number, user_id, active, updated_at DESC);

-- Auto-promote dedups on (user_id, source_diagnosis_id) — never two
-- rules for the same diagnosis page.
CREATE UNIQUE INDEX IF NOT EXISTS uq_upo_diagnosis_source
  ON user_prompt_overlay (user_id, source_diagnosis_id)
  WHERE source_diagnosis_id IS NOT NULL;

-- Tenant audit.
CREATE INDEX IF NOT EXISTS idx_upo_tenant
  ON user_prompt_overlay (client_number, created_at DESC);
