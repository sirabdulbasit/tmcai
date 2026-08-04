-- brain_pending_actions: drop the legacy UNIQUE(user_id, channel, status) by
-- SHAPE, not by name (2026-08-04).
--
-- 20260522_pending_partial_unique tried to fix this already, but it did
--   DROP CONSTRAINT IF EXISTS brain_pending_actions_user_channel_status_uq
-- — a HAND-PICKED name. Prisma generates `..._user_id_channel_status_key`,
-- so on any database where Prisma created the constraint the DROP matched
-- nothing and `IF EXISTS` swallowed it. The migration reported success while
-- changing nothing, and the bug survived 74 migrations.
--
-- Production symptom (2026-08-03 and 2026-08-04): startPending cancels the
-- active pending row, which collides with an already-'cancelled' row for the
-- same (user_id, channel), so the whole action plan dies with
--   "Unique constraint failed on the fields: (userid,channel,status)"
-- The owner lost a confirmed task on 08-03 and a batch of three
-- priority+deadline updates on 08-04.
--
-- This version enumerates constraints/indexes by their COLUMN SET, so it
-- works regardless of how the object was named. Idempotent.

DO $$
DECLARE r record;
BEGIN
  -- 1) UNIQUE constraints on exactly (user_id, channel, status)
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'brain_pending_actions'
       AND c.contype = 'u'
       AND (
         SELECT array_agg(a.attname::text ORDER BY a.attname)
           FROM unnest(c.conkey) AS k(attnum)
           JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
       ) = ARRAY['channel','status','user_id']
  LOOP
    EXECUTE format('ALTER TABLE brain_pending_actions DROP CONSTRAINT %I', r.conname);
    RAISE NOTICE 'dropped legacy unique constraint %', r.conname;
  END LOOP;

  -- 2) Bare UNIQUE indexes on the same triple (no constraint behind them),
  --    excluding partial indexes so the intended one is never touched.
  FOR r IN
    SELECT i.indexrelid::regclass::text AS idxname
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
     WHERE t.relname = 'brain_pending_actions'
       AND i.indisunique
       AND i.indpred IS NULL
       AND (
         SELECT array_agg(a.attname::text ORDER BY a.attname)
           FROM unnest(i.indkey) AS k(attnum)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
       ) = ARRAY['channel','status','user_id']
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %s', r.idxname);
    RAISE NOTICE 'dropped legacy unique index %', r.idxname;
  END LOOP;
END $$;

-- The intended invariant: ONE active pending per (user, channel). Terminal
-- rows (cancelled/completed/failed/expired) may accumulate freely.
CREATE UNIQUE INDEX IF NOT EXISTS brain_pending_actions_user_channel_active_uq
  ON brain_pending_actions (user_id, channel)
  WHERE status IN ('collecting_slots', 'preview_shown', 'confirmed');
