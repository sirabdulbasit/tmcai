-- 20260814_bpq_dedup_tenant_scope
--
-- DEF-175 / Codex iteration-41 findings 1 and 4 (MEDIUM) on DEF-174's fix.
--
-- ── Why this is a NEW migration rather than an edit to 20260813 ─────────────
--
-- 20260813_bpq_dedup_unique ran on production on 2026-08-13. Iteration 41
-- amended that file in place; Codex's finding: the deploy runner skips any
-- name already recorded in `migrations-applied`, so production would never
-- execute the amendment, while a fresh environment would run DIFFERENT SQL
-- under the SAME migration identity — two histories, one name. The amendment
-- is reverted (20260813 is byte-identical to what production ran) and the
-- forward change lives here, under its own name, which the runner WILL apply.
--
-- ── What is stated plainly, not repaired ────────────────────────────────────
--
-- The rows 20260813 expired on production carry NO audit metadata and cannot
-- be retroactively identified: the table has no updated_at, and the missing
-- audit trail is itself the defect. Bounds measured read-only on 2026-08-14:
-- ≤125 expired rows share a (user_id, dedup_key) with a sibling — an upper
-- bound dominated by natural expire-then-requeue cycles — and ≤14 match the
-- harmful delivered-unanswered shape. No restoration is attempted here or
-- anywhere: reviving a guessed row would re-send stale questions, and the
-- guess itself would be fabricated audit data. ACCEPTED LIMITATION, recorded
-- in brain_change_log DEF-174/DEF-175.
--
-- ── What this migration DOES ────────────────────────────────────────────────
--
-- Makes the live-dedup identity explicitly tenant-aware:
-- (client_number, user_id, dedup_key). The application's reads are
-- tenant-scoped per invariant #1 (brainPromptQueueService probe + P2002
-- survivor verification); the index now states the same identity instead of
-- relying on user_id being a global PK. The new index is built BEFORE the old
-- one is dropped, so there is no window without the uniqueness guarantee.
-- Idempotent: both statements are IF NOT EXISTS / IF EXISTS.

CREATE UNIQUE INDEX IF NOT EXISTS uq_bpq_dedup_live_tenant
  ON brain_prompt_queue (client_number, user_id, dedup_key)
  WHERE dedup_key IS NOT NULL AND state IN ('queued', 'awaiting_reply');

DROP INDEX IF EXISTS uq_bpq_dedup_live;
