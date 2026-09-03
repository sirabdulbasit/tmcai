-- DEF-306 — put the prompt's subject where every reader can see it.
--
-- The owner quoted a due-nudge and asked "from where you get it?", and Brain answered
-- "The record doesn't show where it originally came from". Three things were true at once:
--
--   1. the item held source_feed='gchat' with a message ref and a 2026-08-29 date
--   2. the open-items block is a 30-row window and that item ranked 63rd of 93 active items,
--      so it was never in front of the model
--   3. the dispatch-ledger block DID name the nudge, but joined on open_item_id, which is NULL
--      on preactive_due_nudge rows because that producer records its subject in
--      metadata.openItemId and writes nothing to the column
--
-- The reader is fixed in code by using promptSubjectItemId, the accessor DEF-120 built for
-- exactly this. This migration fixes the DATA, for two separate reasons.
--
-- FIRST, the column is the typed, indexed path and several readers use it directly. Measured
-- before writing: 77 rows have a recoverable subject and a NULL column, 47 of those resolve to
-- a live open item, and where BOTH the column and metadata are set they NEVER disagree -- so
-- deriving one from the other is safe rather than a guess.
--
-- SECOND, and this is the owner-visible half: 13 of those rows are still queued or awaiting a
-- reply, and 68 carry side_effect kind 'noop'. A due-nudge with a noop side effect OFFERS to
-- mark the item done and can do nothing about it -- which is DEF-278 word for word, still live
-- in rows enqueued before that fix shipped on 2026-09-02. Repairing them makes the offer honest:
-- if he replies "done" to the reminder he was sent, something happens.
--
-- Scoped to preactive_due_nudge only. Rewriting an arbitrary prompt's side effect would be
-- inventing a capability its author never declared.
--
-- Idempotent: both statements stop matching once a row is repaired.

-- 1. The subject column, from wherever the producer actually recorded it.
UPDATE brain_prompt_queue b
   SET open_item_id = COALESCE(b.metadata->>'openItemId', split_part(b.dedup_key, ':', 2))
 WHERE b.open_item_id IS NULL
   AND COALESCE(b.metadata->>'openItemId', split_part(b.dedup_key, ':', 2)) IS NOT NULL
   AND EXISTS (
     SELECT 1 FROM open_items oi
      WHERE oi.id = COALESCE(b.metadata->>'openItemId', split_part(b.dedup_key, ':', 2))
        AND oi.client_number = b.client_number
   );

-- 2. The promise gets its dispatcher back, for live due-nudges only.
UPDATE brain_prompt_queue b
   SET side_effect = jsonb_build_object('kind', 'action_status_update', 'openItemId', b.open_item_id)
 WHERE b.metadata->>'source' = 'preactive_due_nudge'
   AND b.state IN ('queued', 'awaiting_reply')
   AND b.open_item_id IS NOT NULL
   AND COALESCE(b.side_effect->>'kind', 'noop') = 'noop';
