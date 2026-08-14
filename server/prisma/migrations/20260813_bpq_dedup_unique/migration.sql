-- 20260813_bpq_dedup_unique
--
-- DEF-173 / Codex iteration-29 HIGH #3: the queue's dedup was an
-- application-level probe (SELECT then INSERT) over a NON-unique index, so two
-- concurrent producers for the same item/window could both observe "no digest
-- row" and both insert one — "one item, one voice" becomes two voices.
--
-- This enforces the semantics the probe always assumed: at most one LIVE
-- (queued/awaiting_reply) row per (user, dedup_key). Terminal rows keep their
-- keys for audit, so the index is partial. Idempotent; older live duplicates
-- are expired (never deleted) before the index builds.
--
-- ── AMENDED 2026-08-14 (DEF-174 / Codex iteration-30 HIGH) ───────────────────
--
-- The first version of step 1 had two defects:
--   a. it wrote NO audit metadata — an expired duplicate could not say who
--      expired it, why, what state it had been in, or which row survived
--      (product invariant #7: cleanup must be auditable and reversible);
--   b. it ranked survivors by `queued_at DESC` alone, so a newer `queued` row
--      could out-rank an older `awaiting_reply` one — expiring a question the
--      owner ALREADY HAS on his phone in favour of one not yet sent, orphaning
--      his eventual reply.
--
-- The first version ran on production on 2026-08-13 BEFORE this amendment.
-- Assessment (read-only, 2026-08-14): the affected rows cannot be identified
-- exactly, because the missing audit metadata is itself what would have
-- identified them (`brain_prompt_queue` has no updated_at column). Bounds:
-- ≤125 expired rows share a (user_id, dedup_key) with a sibling — an upper
-- bound dominated by NATURAL expire-then-requeue cycles — and ≤14 match the
-- harmful shape (delivered-unanswered with a newer sibling). No restoration is
-- attempted: reviving a guessed row would re-send stale questions, and the
-- guess itself would be fabricated audit data.
--
-- This amended step 1 is a PERMANENT NO-OP on any database where step 2 has
-- already built the index (the index guarantees no live duplicates exist for
-- it to match). It exists so that any environment running this migration for
-- the first time — a staging restore from a pre-index backup — expires with
-- the audit trail and the precedence production should have had. Idempotent:
-- re-running matches nothing once the duplicates are gone.

-- 1. Expire surplus live duplicates so the unique index can build.
--    Survivor precedence: awaiting_reply beats queued (a question already on
--    the owner's phone is never sacrificed to one not yet sent), then newest.
--    Every expired row records prior state, survivor, reason and actor.
WITH ranked AS (
  SELECT id, state,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, dedup_key
           ORDER BY (state = 'awaiting_reply') DESC, queued_at DESC, id DESC
         ) AS rn,
         FIRST_VALUE(id) OVER (
           PARTITION BY user_id, dedup_key
           ORDER BY (state = 'awaiting_reply') DESC, queued_at DESC, id DESC
         ) AS survivor_id
  FROM brain_prompt_queue
  WHERE dedup_key IS NOT NULL
    AND state IN ('queued', 'awaiting_reply')
)
UPDATE brain_prompt_queue q
SET state = 'expired',
    metadata = COALESCE(q.metadata, '{}'::jsonb) || jsonb_build_object(
      'dedupExpiry', jsonb_build_object(
        'by', '20260813_bpq_dedup_unique',
        'at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'priorState', r.state,
        'survivorId', r.survivor_id,
        'reason', 'surplus live duplicate of (user_id, dedup_key); expired so the unique index could build'
      )
    )
FROM ranked r
WHERE q.id = r.id AND r.rn > 1;

-- 2. The constraint the dedup probe has always believed in.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bpq_dedup_live
  ON brain_prompt_queue (user_id, dedup_key)
  WHERE dedup_key IS NOT NULL AND state IN ('queued', 'awaiting_reply');
