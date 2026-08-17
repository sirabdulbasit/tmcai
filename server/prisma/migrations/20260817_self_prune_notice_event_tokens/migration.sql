-- DEF-202 (Codex iteration-4 HIGH 2 and HIGH 3) — the withdrawal EVENT, not the item.
--
-- `self_prune_notice_batches` claimed membership by item id, so once a batch was
-- sent that item was consumed forever: a restored-and-re-withdrawn item could
-- never form a new batch, and the old sent batch's clear would erase the NEW
-- owed flag as if it belonged to the old announcement. Identity now belongs to
-- the withdrawal event, minted on the row when the debt is recorded.
--
-- Nullable and additive: a pre-existing row simply claims no event token, so
-- existing debt is neither lost nor double-announced across the changeover.
-- Idempotent: safe to run repeatedly.

ALTER TABLE self_prune_notice_batches
    ADD COLUMN IF NOT EXISTS event_tokens JSONB;
