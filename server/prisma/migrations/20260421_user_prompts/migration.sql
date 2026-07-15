-- MyOS — user-authored prompts.
--
-- Natural-language rules the MD writes that get injected into Brain's
-- triage / draft-reply / delegation prompts as extra context.
--
-- These are free-text steerings, not structured rules. Example:
--   "Always loop Umair in on Acme-related emails"
--   "If sender is from pasha.org.pk, add to Open Items (don't reply)"
--   "Keep all replies under 4 sentences, direct tone"
--
-- Scope controls where the prompt is used:
--   triage       — prepended when Brain classifies new feed_events
--   draft_reply  — prepended when LLM composes a reply
--   delegation   — prepended when LLM writes a forward cover-note
--   global       — used in all three above

CREATE TABLE IF NOT EXISTS "user_prompts" (
  "id"              SERIAL PRIMARY KEY,
  "client_number"   VARCHAR(20) NOT NULL,
  "user_id"         INTEGER     NOT NULL,
  "scope"           VARCHAR(20) NOT NULL DEFAULT 'global',
  "text"            TEXT        NOT NULL,
  "is_active"       BOOLEAN     NOT NULL DEFAULT true,
  "priority"        INTEGER     NOT NULL DEFAULT 0,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "user_prompts_client_user_idx"
  ON "user_prompts" ("client_number", "user_id", "is_active");
CREATE INDEX IF NOT EXISTS "user_prompts_scope_idx"
  ON "user_prompts" ("client_number", "user_id", "scope");
