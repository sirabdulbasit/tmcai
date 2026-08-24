-- One canonical id for a Brain action, and a real link between a pending action and its receipt.
--
-- Owner, 2026-08-24, on a schema audit whose finding #2 read: "This is exactly how Brain can
-- execute something, fail to find its receipt later, and then deny or misreport completion."
-- That is not hypothetical here — it is DEF-238 verbatim, and `fabricated-status` is the single
-- largest live symptom class (6 of 16 signatures).
--
-- WHAT THE DATA ACTUALLY SHOWED, measured before writing this:
--   152 brain_action_artifacts, 35 brain_pending_actions
--     0 artifacts pointing at a missing pending action   → the FK below is safe
--     0 linked pairs whose two soft pointers disagree
--     5 pending actions pointing at an artifact that DOES NOT EXIST   ← the bug
--
-- Those 5 are not lost rows. They are a column with TWO MEANINGS:
--     cmsernb0o000mrto983hvi22t   a real BrainActionArtifact id (cuid)
--     19fd12e8abc16d71            a GMAIL message id
--     72ttj4kbqt8n7i3k1qh44u4u7g  a GOOGLE CALENDAR event id
-- instructionDispatcher returns `artifactId: out.eventId ?? String(r.actionId)` and
-- markCompleted() stores whatever it gets into a column that read-back treats as a receipt
-- pointer. Every one of those 5 rows is status='completed': Brain DID the thing, then filed the
-- provider's id where its own receipt id belonged. A later "did I do that?" lookup finds
-- nothing, and answers from nothing.
--
-- Idempotent by construction (AGENTS.md: hand-written, re-runnable, never `prisma migrate dev`).

-- ── 1. A home for provider/domain ids, so they stop being filed as receipts ──────────────
ALTER TABLE brain_pending_actions
  ADD COLUMN IF NOT EXISTS artifact_ext_id VARCHAR(200);

COMMENT ON COLUMN brain_pending_actions.artifact_ext_id IS
  'External/provider id of what the action produced (gmail messageId, calendar eventId, open_item id). NEVER a brain_action_artifacts.id — that is artifact_id.';

COMMENT ON COLUMN brain_pending_actions.artifact_id IS
  'brain_action_artifacts.id ONLY. If the dispatcher returned a provider id it belongs in artifact_ext_id.';

-- ── 2. The canonical action id, carried by both sides ────────────────────────────────────
-- The id is the PENDING action where a preview existed, because that is where the action
-- becomes a thing the user was told about. Direct-emit artifacts (132 of 152 — internal
-- actions that legitimately skip the preview gate) are their own action.
ALTER TABLE brain_pending_actions  ADD COLUMN IF NOT EXISTS brain_action_id VARCHAR(40);
ALTER TABLE brain_action_artifacts ADD COLUMN IF NOT EXISTS brain_action_id VARCHAR(40);

-- ── 3. Separate the two meanings in the rows that already conflated them ─────────────────
-- Only rows whose artifact_id resolves to nothing are touched; a real receipt link is left
-- exactly as it is. Re-running finds no such rows and does nothing.
UPDATE brain_pending_actions p
   SET artifact_ext_id = COALESCE(p.artifact_ext_id, p.artifact_id),
       artifact_id     = NULL
 WHERE p.artifact_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM brain_action_artifacts a WHERE a.id = p.artifact_id);

-- ── 4. Backfill the canonical id ─────────────────────────────────────────────────────────
UPDATE brain_pending_actions
   SET brain_action_id = LEFT(id, 40)
 WHERE brain_action_id IS NULL;

UPDATE brain_action_artifacts a
   SET brain_action_id = LEFT(COALESCE(a.pending_action_id, a.id), 40)
 WHERE a.brain_action_id IS NULL;

-- ── 5. Make the surviving link a REAL one ────────────────────────────────────────────────
-- Safe: measured 0 orphans on this side. SET NULL rather than CASCADE — losing a pending row
-- must never delete the evidence that the action ran, which is the whole point of this file.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'brain_action_artifacts_pending_action_id_fkey'
  ) THEN
    -- Re-check at apply time rather than trusting a measurement taken earlier: if any orphan
    -- appeared since, null it instead of failing the migration half-applied.
    UPDATE brain_action_artifacts a
       SET pending_action_id = NULL
     WHERE a.pending_action_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM brain_pending_actions p WHERE p.id = a.pending_action_id);

    ALTER TABLE brain_action_artifacts
      ADD CONSTRAINT brain_action_artifacts_pending_action_id_fkey
      FOREIGN KEY (pending_action_id) REFERENCES brain_pending_actions(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── 6. Indexes for the read-back this exists to serve ────────────────────────────────────
CREATE INDEX IF NOT EXISTS brain_pending_actions_brain_action_id_idx
  ON brain_pending_actions (brain_action_id);
CREATE INDEX IF NOT EXISTS brain_action_artifacts_brain_action_id_idx
  ON brain_action_artifacts (brain_action_id);
CREATE INDEX IF NOT EXISTS brain_pending_actions_artifact_ext_id_idx
  ON brain_pending_actions (artifact_ext_id);
