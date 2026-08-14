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
-- are expired (never deleted) before the index builds, keeping their audit
-- trail intact.

-- 1. Expire older live duplicates so the unique index can build.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY user_id, dedup_key
           ORDER BY queued_at DESC, id DESC
         ) AS rn
  FROM brain_prompt_queue
  WHERE dedup_key IS NOT NULL
    AND state IN ('queued', 'awaiting_reply')
)
UPDATE brain_prompt_queue
SET state = 'expired'
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- 2. The constraint the dedup probe has always believed in.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bpq_dedup_live
  ON brain_prompt_queue (user_id, dedup_key)
  WHERE dedup_key IS NOT NULL AND state IN ('queued', 'awaiting_reply');
