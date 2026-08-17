-- DEF-190 (Codex iteration-3 directive 1) — withdrawal-notice outbox.
--
-- One row is one notice batch: a single atomic INSERT carries the immutable
-- member snapshot (item ids, titles, count) and the unique dedup identity, so
-- a partially-created batch cannot exist and a retry after any failure reuses
-- the same identity. Idempotent: safe to run repeatedly.

CREATE TABLE IF NOT EXISTS self_prune_notice_batches (
    id               TEXT PRIMARY KEY,
    client_number    VARCHAR(20) NOT NULL,
    user_id          INTEGER NOT NULL,
    batch_id         TEXT NOT NULL,
    dedup_key        VARCHAR(120) NOT NULL,
    item_ids         JSONB NOT NULL,
    titles           JSONB NOT NULL,
    count            INTEGER NOT NULL,
    state            VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at          TIMESTAMP(3),
    cancelled_reason TEXT,
    prompt_id        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS self_prune_notice_batches_dedup_uq
    ON self_prune_notice_batches (dedup_key);

CREATE INDEX IF NOT EXISTS self_prune_notice_batches_tenant_state_ix
    ON self_prune_notice_batches (client_number, user_id, state, created_at);
