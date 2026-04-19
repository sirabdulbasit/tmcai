-- HaseebOS v15 L2 — 8-value lifecycle + ItemStatusHistory audit trail
-- 1. ItemStatusHistory table
CREATE TABLE IF NOT EXISTS "item_status_history" (
  "id" SERIAL PRIMARY KEY,
  "client_number" VARCHAR(20) NOT NULL,
  "open_item_id" TEXT NOT NULL,
  "from_status" VARCHAR(20) NOT NULL,
  "to_status" VARCHAR(20) NOT NULL,
  "outcome" VARCHAR(20) NOT NULL DEFAULT 'accepted',
  "reason" VARCHAR(500),
  "actor" VARCHAR(50),
  "trace_id" VARCHAR(64),
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "item_status_history_client_item_idx"
  ON "item_status_history"("client_number", "open_item_id", "created_at");
CREATE INDEX IF NOT EXISTS "item_status_history_client_outcome_idx"
  ON "item_status_history"("client_number", "outcome", "created_at");

-- 2. Backfill legacy OpenItem status vocabulary → v15 8-value set
UPDATE "open_items" SET "status" = CASE "status"
  WHEN 'open'         THEN 'NEW'
  WHEN 'in_progress'  THEN 'IN_PROGRESS'
  WHEN 'delegated'    THEN 'DELEGATED'
  WHEN 'blocked'      THEN 'WAITING_INFO'
  WHEN 'done'         THEN 'CLOSED'
  WHEN 'overdue'      THEN 'IN_PROGRESS'
  WHEN 'snoozed'      THEN 'SNOOZED'
  WHEN 'triaged'      THEN 'TRIAGED'
  WHEN 'informed'     THEN 'INFORMED'
  WHEN 'closed'       THEN 'CLOSED'
  ELSE "status"
END
WHERE "status" IN ('open','in_progress','delegated','blocked','done','overdue','snoozed','triaged','informed','closed');

-- 3. Change default for new rows
ALTER TABLE "open_items" ALTER COLUMN "status" SET DEFAULT 'NEW';
