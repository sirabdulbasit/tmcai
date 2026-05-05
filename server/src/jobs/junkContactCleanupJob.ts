/**
 * Junk Contact Cleanup Job — daily cron.
 *
 * Iterates every active entity_person wiki page across all tenants and
 * soft-archives the ones whose metadata.email matches isLikelyAutomated
 * (no-reply / mailer-daemon / postmaster / newsletter@ / marketing@ /
 * tracking-token prefixes). Same predicate used by the auto-discovery
 * gate, so behaviour is consistent: junk that gets created (somehow,
 * pre-filter) gets cleaned up; real humans never get touched.
 *
 * Soft-archive (status='archived' + metadata.archivedReason='junk_filter')
 * is reversible: a future "Show archived" toggle on the Contacts page
 * can flip status back to 'active'. We don't hard-delete because:
 *   - sender_history pages may still link to the entity
 *   - if the heuristic ever produces a false positive, hard-delete is
 *     unrecoverable
 *
 * Per-tenant safety: the cron job itself is system-wide (it's a daily
 * maintenance task), but every UPDATE is keyed by entity id (which is
 * deterministic per email/phone), so cross-tenant pollution is
 * impossible. Each row carries its own client_number from the original
 * page creation.
 *
 * Cadence: daily at ~3 AM UTC (registered in server.ts).
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';
import { isLikelyAutomated } from '../services/knowledge/senderQualityFilter';

const log = createLogger('junk-contact-cleanup');

export interface JunkCleanupResult {
  scanned: number;
  archived: number;
  perTenant: Array<{ clientNumber: string; archived: number }>;
  errors: number;
}

export async function runJunkContactCleanup(): Promise<JunkCleanupResult> {
  const out: JunkCleanupResult = { scanned: 0, archived: 0, perTenant: [], errors: 0 };

  // Pre-load every active user's emails so the self-contact archive
  // (where someone's own email landed in their contacts) can match
  // without N round trips. Map: lowercased email → userId.
  const allUsers = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, email: true, integrationEmail: true } as any,
  }).catch(() => [] as any[]);
  const emailToUserId = new Map<string, number>();
  for (const u of allUsers as any[]) {
    if (u.email) emailToUserId.set(u.email.toLowerCase(), u.id);
    if (u.integrationEmail) emailToUserId.set(u.integrationEmail.toLowerCase(), u.id);
  }

  const rows = await prisma.$queryRawUnsafe<Array<{
    id: string; client_number: string; user_id: number; metadata: any;
  }>>(
    // Include 'orphan' too — the wiki linter marks contact rows as
    // orphan when nothing links to them, but the contacts UI still
    // surfaces them so cleanup must scan them as well. 'archived' and
    // 'deleted' are already terminal so we skip those.
    `SELECT id, client_number, user_id, metadata
       FROM wiki_pages
      WHERE page_type = 'entity_person'
        AND status IN ('active', 'orphan')`,
  ).catch((err) => { log.warn('candidate query failed', { err: err.message }); return [] as any[]; });

  out.scanned = rows.length;

  // Aggregate per-tenant counters so logs are useful.
  const perTenant = new Map<string, number>();
  for (const r of rows) {
    const email = String(r.metadata?.email ?? '').trim().toLowerCase();
    if (!email) continue;
    // Self-archive: if this contact's email belongs to the SAME user
    // who owns the contact row, archive it. A user shouldn't be in
    // their own contacts. Other users' contact rows for the same
    // person are unaffected.
    const matchingUserId = emailToUserId.get(email);
    const isSelf = matchingUserId !== undefined && matchingUserId === r.user_id;
    if (!isSelf && !isLikelyAutomated(email)) continue;

    try {
      await prisma.$executeRawUnsafe(
        `UPDATE wiki_pages
            SET status = 'archived',
                last_updated_at = NOW(),
                last_updated_by = 'junk_contact_cleanup_cron',
                metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
          WHERE id = $2 AND status IN ('active', 'orphan')`,  // guard against double-archive
        JSON.stringify({
          archivedReason: isSelf ? 'self_contact' : 'junk_filter',
          archivedAt: new Date().toISOString(),
          archivedBy: 'auto_cron',
          archivedEmail: email,
        }),
        r.id,
      );
      out.archived += 1;
      perTenant.set(r.client_number, (perTenant.get(r.client_number) ?? 0) + 1);
    } catch (err: any) {
      out.errors += 1;
      log.warn('archive failed', { id: r.id, err: err.message });
    }
  }

  out.perTenant = Array.from(perTenant.entries()).map(([clientNumber, archived]) => ({
    clientNumber, archived,
  }));

  if (out.archived > 0) {
    log.info('junk contact cleanup complete', out as unknown as Record<string, unknown>);
  } else if (out.scanned > 0) {
    log.info('junk contact cleanup: nothing to archive', { scanned: out.scanned });
  }

  return out;
}
