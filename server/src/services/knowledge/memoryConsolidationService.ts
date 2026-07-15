/**
 * Memory consolidation — keeps the wiki from growing forever.
 *
 * The compounding-wiki design means every email, WhatsApp message,
 * sender thread, and observation becomes a permanent page. With 1k+
 * tenants this scales fine, but a single tenant's per-user space
 * (sender_topic, sender_history, email_message, observation, answer)
 * grows without bound. After ~6 months you'd have 50k+ pages even for
 * a moderate user.
 *
 * This service is conservative: it only ARCHIVES (status='archived'),
 * never deletes. Archived pages drop out of default retrieval but can
 * be restored. The user's data is never lost.
 *
 * Aging policy (per page type):
 *
 *   email_message       180d old AND no link to active open_item AND
 *                       no link from a meeting_minutes / observation
 *                       in the last 90d
 *   sender_topic        180d since last_updated_at AND no inbound link
 *   sender_history      365d since last_updated_at
 *   observation         60d old AND urgency < 0.5
 *   answer              90d old AND not cited by anything in 30d
 *   gap                 90d old (gaps that haven't been re-asked)
 *
 * NEVER archived: tenant-shared types (org_doc, policy, project,
 * decision, pattern, attachment_doc, entity_person, topic, plan,
 * meeting_minutes, instruction, feedback, feedback_diagnosis).
 *
 * Run nightly via the existing cron infra. Safe to dry-run first
 * (audit log shows what would be archived).
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { audit } from '../auditLogService';

const log = createLogger('memory-consolidation');

interface PolicyResult { archived: number; kind: string; }

export async function runConsolidationForTenant(
  clientNumber: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ totalArchived: number; byType: Record<string, number>; dryRun: boolean }> {
  const dryRun = !!opts.dryRun;
  const byType: Record<string, number> = {};

  const policies: Array<() => Promise<PolicyResult>> = [
    () => agePagesByType(clientNumber, dryRun, 'email_message',  180, true),
    () => agePagesByType(clientNumber, dryRun, 'sender_topic',   180, true),
    () => agePagesByType(clientNumber, dryRun, 'sender_history', 365, false),
    () => ageObservations(clientNumber, dryRun, 60, 0.5),
    () => ageAnswers(clientNumber, dryRun, 90, 30),
    () => agePagesByType(clientNumber, dryRun, 'gap',            90, false),
  ];

  for (const p of policies) {
    try {
      const r = await p();
      byType[r.kind] = r.archived;
    } catch (err: any) {
      log.warn('policy failed', { error: err.message });
    }
  }

  const totalArchived = Object.values(byType).reduce((s, n) => s + n, 0);
  if (totalArchived > 0) {
    await audit({
      clientNumber,
      actorKind: 'system',
      action: 'user.data.exported',  // closest match in our audit catalog
      subjectType: 'memory_consolidation', subjectId: clientNumber,
      details: { byType, totalArchived, dryRun },
    });
  }
  log.info('consolidation complete', { clientNumber, totalArchived, byType, dryRun });
  return { totalArchived, byType, dryRun };
}

/**
 * Generic age-by-type policy. Archives pages of the given type that:
 *   - haven't been updated in `daysOld` days
 *   - if `requireNoLinks` is true, have no incoming wiki_page_links
 */
async function agePagesByType(
  clientNumber: string,
  dryRun: boolean,
  pageType: string,
  daysOld: number,
  requireNoLinks: boolean,
): Promise<PolicyResult> {
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  // Find candidates. requireNoLinks → exclude any page that's the
  // target of an active wiki_page_link OR is referenced by an active
  // open_item.metadata->source.
  const linksFilter = requireNoLinks
    ? `AND NOT EXISTS (
         SELECT 1 FROM wiki_page_links l
          WHERE l.to_page_id = wp.id
            AND l.from_page_id IN (SELECT id FROM wiki_pages WHERE status = 'active')
       )
       AND NOT EXISTS (
         SELECT 1 FROM open_items oi
          WHERE oi.client_number = wp.client_number
            AND oi.status NOT IN ('CLOSED','INFORMED')
            AND (oi.source_ref = wp.id OR oi.metadata->'source'->>'meetingMinutesId' = wp.id)
       )`
    : '';

  const sql = dryRun
    ? `SELECT COUNT(*)::int AS n
         FROM wiki_pages wp
        WHERE wp.client_number = $1
          AND wp.page_type = $2
          AND wp.status = 'active'
          AND wp.last_updated_at < $3
          ${linksFilter}`
    : `WITH targets AS (
         SELECT wp.id FROM wiki_pages wp
          WHERE wp.client_number = $1
            AND wp.page_type = $2
            AND wp.status = 'active'
            AND wp.last_updated_at < $3
            ${linksFilter}
       )
       UPDATE wiki_pages
          SET status = 'archived',
              last_updated_at = NOW(),
              last_updated_by = 'memory_consolidation',
              metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb),
                                   '{archivedAt}',
                                   to_jsonb(NOW()::text))
        WHERE id IN (SELECT id FROM targets)`;

  if (dryRun) {
    const rows = await prisma.$queryRawUnsafe<any[]>(sql, clientNumber, pageType, cutoff).catch(() => [{ n: 0 }]);
    return { kind: pageType, archived: Number(rows[0]?.n ?? 0) };
  }
  const n = await prisma.$executeRawUnsafe(sql, clientNumber, pageType, cutoff).catch(() => 0);
  return { kind: pageType, archived: Number(n) };
}

/** Observations have an urgency field — keep high-urgency ones longer. */
async function ageObservations(
  clientNumber: string, dryRun: boolean, daysOld: number, urgencyThreshold: number,
): Promise<PolicyResult> {
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  if (dryRun) {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS n FROM wiki_pages
        WHERE client_number = $1 AND page_type = 'observation' AND status = 'active'
          AND last_updated_at < $2
          AND COALESCE((metadata->>'urgency')::float, 0) < $3`,
      clientNumber, cutoff, urgencyThreshold,
    ).catch(() => [{ n: 0 }]);
    return { kind: 'observation', archived: Number(rows[0]?.n ?? 0) };
  }
  const n = await prisma.$executeRawUnsafe(
    `UPDATE wiki_pages
        SET status = 'archived', last_updated_by = 'memory_consolidation',
            metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{archivedAt}', to_jsonb(NOW()::text))
      WHERE client_number = $1 AND page_type = 'observation' AND status = 'active'
        AND last_updated_at < $2
        AND COALESCE((metadata->>'urgency')::float, 0) < $3`,
    clientNumber, cutoff, urgencyThreshold,
  ).catch(() => 0);
  return { kind: 'observation', archived: Number(n) };
}

/** Answers — archive if not cited by anything in the last `recentlyCitedDays`. */
async function ageAnswers(
  clientNumber: string, dryRun: boolean, daysOld: number, recentlyCitedDays: number,
): Promise<PolicyResult> {
  const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000);
  const recentCutoff = new Date(Date.now() - recentlyCitedDays * 24 * 60 * 60 * 1000);
  if (dryRun) {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS n FROM wiki_pages wp
        WHERE wp.client_number = $1 AND wp.page_type = 'answer' AND wp.status = 'active'
          AND wp.last_updated_at < $2
          AND NOT EXISTS (
            SELECT 1 FROM wiki_page_links l
             WHERE l.to_page_id = wp.id AND l.created_at > $3
          )`,
      clientNumber, cutoff, recentCutoff,
    ).catch(() => [{ n: 0 }]);
    return { kind: 'answer', archived: Number(rows[0]?.n ?? 0) };
  }
  const n = await prisma.$executeRawUnsafe(
    `UPDATE wiki_pages
        SET status = 'archived', last_updated_by = 'memory_consolidation',
            metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{archivedAt}', to_jsonb(NOW()::text))
      WHERE client_number = $1 AND page_type = 'answer' AND status = 'active'
        AND last_updated_at < $2
        AND id NOT IN (SELECT to_page_id FROM wiki_page_links WHERE created_at > $3)`,
    clientNumber, cutoff, recentCutoff,
  ).catch(() => 0);
  return { kind: 'answer', archived: Number(n) };
}

/** Walk every active tenant, run consolidation, throttle 1/sec. */
export async function runConsolidationAllTenants(opts: { dryRun?: boolean } = {}): Promise<void> {
  const tenants = await prisma.$queryRawUnsafe<any[]>(
    `SELECT DISTINCT client_number FROM wiki_pages WHERE status='active' LIMIT 500`,
  ).catch(() => []);
  for (const t of tenants) {
    try {
      await runConsolidationForTenant(t.client_number, opts);
    } catch (err: any) {
      log.warn('tenant consolidation failed', { clientNumber: t.client_number, error: err.message });
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
