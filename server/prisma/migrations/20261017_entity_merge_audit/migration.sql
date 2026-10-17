-- DEF-339 / Codex it-79(5) directive #1 — the merge's rollback record becomes durable.
--
-- DEF-338 (D-120) made the hourly identity merge SUCCEED for the first time ever, which means
-- `DELETE FROM entities` now actually runs on the owner's production contacts, driven by a
-- duplicate-detection path (`proposeEntityMerges`) whose precision has never been observed
-- live — every prior merge aborted on 23505/23503 before deleting anything.
--
-- `mergeEntities` has always COMPUTED a full rollback record — the deleted entity rows, every
-- repointed reference, the survivor's pre-merge state — and its own docstring promises
-- "REVERSIBLE ... a merge that cannot be undone is a deletion wearing a nicer word". But the
-- scheduler caller DISCARDED that record, logging only the ids. A wrong high-confidence
-- auto-merge would permanently lose a contact's identity fields (name/email/phone),
-- recoverable only by id from a log line, which is not recovery.
--
-- This table is where the record now lands, written INSIDE the merge transaction: if the
-- audit INSERT fails, the merge rolls back — no deletion can commit without its receipt, by
-- construction (the no-claim-without-a-receipt guardrail applied to Brain's own unattended
-- mutation). Rows are never updated or deleted by runtime code; they ARE the recovery path.

CREATE TABLE IF NOT EXISTS entity_merge_audit (
  id            TEXT PRIMARY KEY,
  client_number VARCHAR(20) NOT NULL,
  survivor_id   TEXT NOT NULL,
  merged_ids    TEXT[] NOT NULL,
  reason        TEXT NOT NULL,
  rollback      JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_entity_merge_audit_tenant_time
  ON entity_merge_audit (client_number, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entity_merge_audit_survivor
  ON entity_merge_audit (client_number, survivor_id);
