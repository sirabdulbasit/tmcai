-- ============================================================
-- 20260504_wiki_pages_scope
--
-- Wiki page visibility scope. Today every wiki_pages row is owned by a
-- specific user (user_id NOT NULL) and retrieval filters by user_id —
-- which means tenant-shared knowledge (people pages, FACL docs,
-- policies) gets duplicated per user AND a personal user-private page
-- (mind_state, gap, answer) is technically queryable by another user
-- if the retrieval filter is missed.
--
-- Add an explicit `scope` column:
--   'user'   — page is private to user_id; only that user can read it
--   'tenant' — page is shared knowledge across the tenant; visible to
--              any user with the same client_number
--
-- All retrieval paths now filter:
--   client_number = $cn
--   AND (scope='tenant' OR (scope='user' AND user_id=$me))
--
-- Idempotent — safe to re-run on local DBs.
-- ============================================================

-- 1. Add the column with a safe default.
ALTER TABLE wiki_pages
  ADD COLUMN IF NOT EXISTS scope VARCHAR(10) NOT NULL DEFAULT 'user';

-- 2. Backfill: pages whose page_type is clearly organisational become
--    tenant-scoped. Personal types (mind_state, answer, gap, observation,
--    sender_history, etc.) stay 'user' from the default.
-- Page types that pre-existing code already classified as tenant-shared
-- in tenantIndexService.TENANT_SHARED_PAGE_TYPES, plus a few that the
-- old heuristic missed (attachment_doc was duplicated per user; same
-- for concept and meeting_minutes — moving them to tenant scope ends
-- the duplication and prevents user A's FACL access leaking to user B).
UPDATE wiki_pages
   SET scope = 'tenant'
 WHERE page_type IN (
   'org_doc',
   'policy',
   'project',
   'decision',
   'pattern',
   'entity_person',
   'topic',
   'attachment_doc',
   'concept',
   'meeting_minutes',
   'entity',
   'plan'
 )
 AND scope <> 'tenant';

-- 3. Indexes that match the retrieval filter.
CREATE INDEX IF NOT EXISTS idx_wiki_pages_tenant_scope
  ON wiki_pages (client_number, scope, page_type)
  WHERE scope = 'tenant';
CREATE INDEX IF NOT EXISTS idx_wiki_pages_user_scope
  ON wiki_pages (client_number, user_id, scope, page_type)
  WHERE scope = 'user';
