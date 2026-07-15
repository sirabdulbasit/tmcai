-- One-shot Brain memory wipe — 2026-05-23.
--
-- Purpose: clear stale working-memory rows that interfere with V2
-- candidate-ID rollout + delete empty-contact entities that were the
-- source of the muhammad.yousaf@nexeo.com hallucination.
--
-- SAFETY: archives every wipe target into a *_wipe_2026_05_23 table
-- so we can restore via INSERT ... SELECT if anything looks wrong.
-- Archive tables auto-drop after 7 days via the new cleanup cron
-- (server/src/jobs/wipeArchiveCleanup.ts).
--
-- PRESERVED (per Basit 2026-05-23):
--   - open_items (your real follow-ups)
--   - users, clients, OAuth grants, WhatsApp sessions
--   - wiki_pages, feed_events (real ingested data)
--   - prompt_blocks, action_definitions, capability_registry
--
-- Run as:
--   psql "$DATABASE_URL" -f server/scripts/brain_wipe_2026_05_23.sql

BEGIN;

-- ── Archive ──
CREATE TABLE IF NOT EXISTS brain_pending_actions_wipe_2026_05_23 AS
  SELECT * FROM brain_pending_actions WHERE FALSE;
INSERT INTO brain_pending_actions_wipe_2026_05_23 SELECT * FROM brain_pending_actions;

CREATE TABLE IF NOT EXISTS clarification_memory_wipe_2026_05_23 AS
  SELECT * FROM clarification_memory WHERE FALSE;
INSERT INTO clarification_memory_wipe_2026_05_23 SELECT * FROM clarification_memory;

CREATE TABLE IF NOT EXISTS reasoning_traces_wipe_2026_05_23 AS
  SELECT * FROM reasoning_traces WHERE FALSE;
INSERT INTO reasoning_traces_wipe_2026_05_23 SELECT * FROM reasoning_traces;

CREATE TABLE IF NOT EXISTS brain_action_artifacts_wipe_2026_05_23 AS
  SELECT * FROM brain_action_artifacts WHERE FALSE;
INSERT INTO brain_action_artifacts_wipe_2026_05_23 SELECT * FROM brain_action_artifacts;

CREATE TABLE IF NOT EXISTS entities_emptycontact_wipe_2026_05_23 AS
  SELECT * FROM entities WHERE FALSE;
INSERT INTO entities_emptycontact_wipe_2026_05_23
SELECT * FROM entities
WHERE entity_type = 'contact'
  AND client_number = 'TMC-0001'
  AND (email IS NULL OR email = '')
  AND (phone IS NULL OR phone = '');

-- ── Pre-wipe snapshot ──
\echo '── PRE-WIPE COUNTS ──'
SELECT 'brain_pending_actions'   AS table, COUNT(*) FROM brain_pending_actions
UNION ALL SELECT 'clarification_memory',   COUNT(*) FROM clarification_memory
UNION ALL SELECT 'reasoning_traces',       COUNT(*) FROM reasoning_traces
UNION ALL SELECT 'brain_action_artifacts', COUNT(*) FROM brain_action_artifacts
UNION ALL SELECT 'empty-contact entities',
       (SELECT COUNT(*) FROM entities
        WHERE entity_type='contact' AND client_number='TMC-0001'
          AND (email IS NULL OR email='') AND (phone IS NULL OR phone=''))
UNION ALL SELECT 'open_items (must be UNCHANGED after wipe)',
       (SELECT COUNT(*) FROM open_items);

-- ── Wipe working memory ──
DELETE FROM brain_pending_actions;
DELETE FROM clarification_memory;
DELETE FROM reasoning_traces;
DELETE FROM brain_action_artifacts;

-- ── Delete empty-contact rows (the @nexeo.com hallucination source) ──
DELETE FROM entities
WHERE entity_type = 'contact'
  AND client_number = 'TMC-0001'
  AND (email IS NULL OR email = '')
  AND (phone IS NULL OR phone = '');

-- ── Assign orphan contacts to user 2 (Basit) — KEEP PRIVATE ──
-- Per Basit's "contacts private by default" rule, do NOT promote to
-- tenant scope. owner_user_id=2 makes them visible to him via the
-- candidates block's owner-scoped filter.
UPDATE entities
SET owner_user_id = 2
WHERE entity_type = 'contact'
  AND client_number = 'TMC-0001'
  AND owner_user_id IS NULL
  AND created_by IS NULL;

-- ── Post-wipe verification ──
\echo '── POST-WIPE COUNTS ──'
SELECT 'brain_pending_actions (should be 0)'        AS table, COUNT(*) FROM brain_pending_actions
UNION ALL SELECT 'clarification_memory (should be 0)',         COUNT(*) FROM clarification_memory
UNION ALL SELECT 'reasoning_traces (should be 0)',             COUNT(*) FROM reasoning_traces
UNION ALL SELECT 'brain_action_artifacts (should be 0)',       COUNT(*) FROM brain_action_artifacts
UNION ALL SELECT 'open_items (must match pre-wipe)',           COUNT(*) FROM open_items
UNION ALL SELECT 'entities contacts (cleaned)',                COUNT(*) FROM entities WHERE entity_type='contact' AND client_number='TMC-0001'
UNION ALL SELECT 'entities contacts scope=tenant',             COUNT(*) FROM entities WHERE entity_type='contact' AND scope='tenant'
UNION ALL SELECT 'entities contacts scope=user',               COUNT(*) FROM entities WHERE entity_type='contact' AND scope='user';

-- ── Audit row in brain_resets (table created by migration in this deploy) ──
INSERT INTO brain_resets (id, user_id, tier, wiped_counts, archive_suffix, created_at)
SELECT
  'rst_2026_05_23_onehot_' || substr(md5(random()::text), 1, 8),
  2,
  'full_with_contacts',
  jsonb_build_object(
    'brain_pending_actions',  (SELECT COUNT(*) FROM brain_pending_actions_wipe_2026_05_23),
    'clarification_memory',   (SELECT COUNT(*) FROM clarification_memory_wipe_2026_05_23),
    'reasoning_traces',       (SELECT COUNT(*) FROM reasoning_traces_wipe_2026_05_23),
    'brain_action_artifacts', (SELECT COUNT(*) FROM brain_action_artifacts_wipe_2026_05_23),
    'entities_emptycontact',  (SELECT COUNT(*) FROM entities_emptycontact_wipe_2026_05_23)
  ),
  'wipe_2026_05_23',
  NOW()
WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='brain_resets');

COMMIT;

\echo '── DONE. Archive tables retain pre-wipe data for 7 days. ──'
