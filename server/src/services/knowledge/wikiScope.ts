/**
 * Wiki page scope helpers.
 *
 * Every wiki_pages row has a `scope` column ('user' | 'tenant'):
 *   - 'user'   — private to user_id, only that user can read
 *   - 'tenant' — shared across the tenant, any user with the same
 *                client_number can read
 *
 * Visibility rule (apply in EVERY retrieval path):
 *
 *   client_number = $cn AND
 *   (scope = 'tenant' OR (scope = 'user' AND user_id = $me))
 *
 * Use buildScopeWhere() for Prisma queries; visibilitySqlFragment()
 * for raw SQL paths.
 */

/**
 * Page types that default to tenant scope when no explicit scope is
 * passed by the writer. Source-based rule:
 *
 *   - User connector ingest (Gmail, Calendar, WhatsApp Personal) → user
 *   - Tenant connector ingest (FACL Drive, future tenant CRM/ERP)   → tenant
 *   - System tenant chronology / catalog                            → tenant
 *
 * Most page types are ambiguous (entity_person, attachment_doc, project,
 * decision, etc.) — they could be created from EITHER kind of connector.
 * Default them to 'user' (privacy-safe) and require the tenant-source
 * writer to pass `scope: 'tenant'` explicitly.
 *
 * The narrow set below captures only page types that are unambiguously
 * tenant-by-construction:
 *
 *   - org_doc        — FACL folder content (tenant connector by definition)
 *   - tenant_log     — system-maintained tenant chronology
 *   - tenant_index   — system-maintained planner catalog
 */
export const TENANT_SCOPED_PAGE_TYPES = new Set<string>([
  'org_doc',
  'tenant_log',
  'tenant_index',
]);

export function defaultScopeForPageType(pageType: string): 'user' | 'tenant' {
  return TENANT_SCOPED_PAGE_TYPES.has(pageType) ? 'tenant' : 'user';
}

/**
 * Prisma `where` fragment that enforces the visibility rule. Spread
 * into your existing where clause:
 *
 *   prisma.wikiPage.findMany({
 *     where: { ...buildScopeWhere(cn, userId), pageType: 'project' },
 *   })
 */
export function buildScopeWhere(clientNumber: string, userId: number): Record<string, unknown> {
  return {
    clientNumber,
    OR: [
      { scope: 'tenant' },
      { scope: 'user', userId },
    ],
  };
}

/**
 * Raw SQL fragment + params to splice into a SELECT/UPDATE/DELETE.
 *
 *   const { sql, params } = visibilitySqlFragment(cn, userId, '$1', '$2');
 *   await prisma.$queryRawUnsafe(
 *     `SELECT id FROM wiki_pages WHERE ${sql} AND status = 'active'`,
 *     ...params
 *   );
 *
 * Returns ($1, $2) placeholders by default — caller can override the
 * placeholder numbers when splicing into a multi-param query.
 */
export function visibilitySqlFragment(
  _clientNumber: string,
  _userId: number,
  cnPlaceholder = '$1',
  userIdPlaceholder = '$2',
): { sql: string } {
  return {
    sql: `client_number = ${cnPlaceholder} AND (scope = 'tenant' OR (scope = 'user' AND user_id = ${userIdPlaceholder}))`,
  };
}
