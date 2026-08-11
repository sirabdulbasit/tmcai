-- DEF-127 — restore the open-item status ledger.
--
-- `item_status_history` was dropped on 2026-05-18 as an "orphan". It was not one.
-- `lifecycleService.transitionStatus` writes it inside the SAME transaction as
-- the status update, so with the table and the Prisma model gone,
-- `(tx as any).itemStatusHistory.create` throws and the transaction REVERTS the
-- status change. Proven on production by a read-only aborted probe:
-- `typeof tx.itemStatusHistory === 'undefined'`.
--
-- Two live user-facing paths are broken by that today: the Open Items page status
-- control, and Brain's `mark_open_item_done` / `delegate_open_item`.
--
-- A NEW folder, deliberately: 20260419_v15_item_lifecycle is already recorded in
-- `_prisma_migrations` and will never re-run. Editing a recorded migration is
-- ledger drift.
--
-- NO HISTORICAL AUDIT BACKFILL. 267 items are already CLOSED with no record of
-- who closed them or why. Inventing rows for them would fabricate audit, which is
-- worse than an honestly empty ledger. History starts at the first transition
-- after this runs. The only backfill here is GROUNDED recovery of `user_id` on
-- ledger rows that already exist, read from the open item they point at.
--
-- Idempotent, and safe whether the table is absent, fully present, or partially
-- present (an older environment may carry the pre-2026-05-18 shape, which had no
-- `user_id`).

-- 1. The table. `user_id` is NOT NULL from the start: this is a user-owned audit
--    ledger, and a row that cannot say WHOSE item changed is not audit.
CREATE TABLE IF NOT EXISTS "item_status_history" (
  "id"            SERIAL PRIMARY KEY,
  "client_number" VARCHAR(20)  NOT NULL,
  "user_id"       INTEGER      NOT NULL,
  "open_item_id"  TEXT         NOT NULL,
  "from_status"   VARCHAR(20)  NOT NULL,
  "to_status"     VARCHAR(20)  NOT NULL,
  "outcome"       VARCHAR(20)  NOT NULL DEFAULT 'accepted',
  "reason"        VARCHAR(500),
  "actor"         VARCHAR(50),
  "trace_id"      VARCHAR(64),
  "metadata"      JSONB,
  "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. The partially-present case. A table from the 2026-04-19 shape has every
--    column above EXCEPT `user_id`, and may hold rows. Adding a NOT NULL column
--    to it directly would fail, and adding one with a default would invent an
--    owner — so: add it nullable, RECOVER the value from the open item each row
--    already references, refuse to continue if any row cannot be grounded, and
--    only then tighten to NOT NULL.
--
--    On a fresh install every statement here is a no-op: the column already
--    exists and is already NOT NULL, the UPDATE matches nothing, the count is 0.
DO $$
DECLARE
  ungrounded INTEGER;
BEGIN
  ALTER TABLE "item_status_history" ADD COLUMN IF NOT EXISTS "user_id" INTEGER;

  -- Grounded recovery: the owning user comes from the open item this row is
  -- about, matched on BOTH tenant and item so a colliding id in another tenant
  -- can never supply the answer.
  UPDATE "item_status_history" h
     SET "user_id" = oi."user_id"
    FROM "open_items" oi
   WHERE h."user_id" IS NULL
     AND oi."id" = h."open_item_id"
     AND oi."client_number" = h."client_number";

  SELECT count(*) INTO ungrounded FROM "item_status_history" WHERE "user_id" IS NULL;

  IF ungrounded > 0 THEN
    RAISE EXCEPTION
      'DEF-127: % item_status_history row(s) have no matching open_item in the same tenant, so their owning user cannot be recovered. Refusing to guess or to relax the constraint — inspect these rows before re-running.',
      ungrounded;
  END IF;

  ALTER TABLE "item_status_history" ALTER COLUMN "user_id" SET NOT NULL;
END $$;

-- 3. Indexes. Three, all tenant-first, matching the reads that actually exist:
--    one item's history, one user's history, and outcome triage per tenant.
--    A global `created_at` index was considered and dropped: no verified
--    consumer performs cross-tenant history queries, and an unused index is
--    write cost for nothing (791 MB of never-scanned indexes were removed from
--    this database on 2026-08-09 for exactly that reason).
CREATE INDEX IF NOT EXISTS "item_status_history_client_item_idx"
  ON "item_status_history" ("client_number", "open_item_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "item_status_history_client_user_idx"
  ON "item_status_history" ("client_number", "user_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "item_status_history_client_outcome_idx"
  ON "item_status_history" ("client_number", "outcome", "created_at" DESC);

-- 4. Post-application verification (run by hand; prints no credentials):
--
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_name = 'item_status_history' ORDER BY ordinal_position;
--
--   SELECT indexname FROM pg_indexes WHERE tablename = 'item_status_history';
--
--   SELECT count(*) FROM item_status_history;   -- expect 0: no history backfill
