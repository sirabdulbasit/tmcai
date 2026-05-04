-- ============================================================
-- 20260504_wiki_pages_scope_correction
--
-- The previous migration (20260504_wiki_pages_scope) promoted a broad
-- list of page types to tenant scope based on a "this looks org-level"
-- heuristic. That violated the cleaner source-based rule:
--
--   tenant connector → tenant wiki
--   user connector   → my wiki
--
-- Pages like entity_person, project, decision, meeting_minutes,
-- attachment_doc, concept, policy, plan, topic, entity, pattern were
-- created from individual users' Gmail / Calendar / WhatsApp data.
-- They should remain user-scoped until a true tenant-level CRM or HR
-- connector creates them.
--
-- This migration demotes everything back to 'user' scope EXCEPT pages
-- that are unambiguously tenant by construction:
--
--   - lastUpdatedBy = 'facl_scribe'         (FACL Drive = tenant connector)
--   - page_type IN ('org_doc', 'tenant_log', 'tenant_index')
--
-- Idempotent — re-running is a no-op.
-- ============================================================

UPDATE wiki_pages
   SET scope = 'user'
 WHERE scope = 'tenant'
   AND last_updated_by IS DISTINCT FROM 'facl_scribe'
   AND page_type NOT IN ('org_doc', 'tenant_log', 'tenant_index');
