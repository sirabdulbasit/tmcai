/**
 * dedupContactsByEmail.ts — one-shot migration that collapses
 * entity_person rows pointing at the same person into a single
 * canonical row.
 *
 * Why this exists: pre-fix, ensureEntityForSender used the raw email
 * string for entity_id. So senders ingested in different formats
 * produced different rows for the same person:
 *   "Iftikhar Hussain <iftikhar.hussain@tmcltd.ai>"  →  one row
 *   "iftikhar.hussain@tmcltd.ai"                    →  another row
 *
 * After the normalizeEmail() fix, future writes converge to one
 * canonical row. This script handles existing duplicates.
 *
 * Strategy:
 *   1. Group every entity_person by normalizeEmail(metadata.email).
 *   2. Within each group, pick the canonical winner:
 *        - prefer rows whose id matches person:{normalized_email}
 *          (these are the post-fix canonical IDs)
 *        - else prefer the row with the most recent activity
 *   3. Soft-archive the losers: status='archived',
 *      metadata.archivedReason='duplicate_collapsed',
 *      metadata.canonicalId points at the winner.
 *
 * Reversible — flipping the loser back to 'active' brings the row
 * back. We don't hard-delete because sender_history / wiki_page_link /
 * other tables may still reference the loser by id.
 *
 * Usage:
 *   npx ts-node src/scripts/dedupContactsByEmail.ts             # dry-run, all tenants
 *   npx ts-node src/scripts/dedupContactsByEmail.ts TMC-0001    # dry-run, one tenant
 *   APPLY=1 npx ts-node src/scripts/dedupContactsByEmail.ts TMC-0001
 */
import 'dotenv/config';
import prisma from '../db/prisma';
import { normalizeEmail } from '../services/knowledge/entitySweepService';

interface PageRow {
  id: string;
  title: string;
  status: string;
  metadata: any;
  client_number: string;
  user_id: number;
  last_updated_at: Date;
}

async function main() {
  const targetTenant = process.argv[2] ?? null;
  const apply = process.env.APPLY === '1';
  console.log(`[dedup] mode: ${apply ? 'APPLY (archiving losers)' : 'DRY RUN'}; tenant: ${targetTenant ?? 'ALL'}`);

  const rows = await prisma.$queryRawUnsafe<PageRow[]>(
    `SELECT id, title, status, metadata, client_number, user_id, last_updated_at
       FROM wiki_pages
      WHERE page_type = 'entity_person'
        AND status NOT IN ('archived', 'deleted')
        ${targetTenant ? 'AND client_number = $1' : ''}`,
    ...(targetTenant ? [targetTenant] : []),
  );

  // Group by (clientNumber, user_id, normalized_email). Each user's own
  // row for the same person is independent — basit's contact for asad
  // and asad's contact for asad are different conceptually.
  const groups = new Map<string, PageRow[]>();
  for (const r of rows) {
    const raw = String(r.metadata?.email ?? '');
    const norm = normalizeEmail(raw);
    if (!norm || !norm.includes('@')) continue;
    const key = `${r.client_number}|${r.user_id}|${norm}`;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }

  let groupsWithDupes = 0;
  let losersTotal = 0;
  const losersByGroup: Array<{ canonical: PageRow; losers: PageRow[]; normEmail: string }> = [];

  for (const [key, arr] of groups) {
    if (arr.length < 2) continue;
    const normEmail = key.split('|')[2]!;
    const canonicalId = `person:${normEmail}`;
    // Pick winner:
    //   1. Exact canonical id (post-fix format) — highest priority
    //   2. Penalise IDs containing '<' or ' ' (pre-fix duplicates that
    //      embed the RFC2822 "Name <addr>" form in the entity_id)
    //   3. Prefer rows whose title doesn't have angle brackets (cleaner
    //      display for the contacts list when not collapsed)
    //   4. Fall through to most recent
    const cleanScore = (r: PageRow) => {
      let s = 0;
      if (r.id === canonicalId) s += 1000;
      if (!r.id.includes('<') && !r.id.includes(' ')) s += 100;
      if (!r.title.includes('<')) s += 10;
      return s;
    };
    arr.sort((a, b) => {
      const cs = cleanScore(b) - cleanScore(a);
      if (cs !== 0) return cs;
      return b.last_updated_at.getTime() - a.last_updated_at.getTime();
    });
    const [canonical, ...losers] = arr;
    groupsWithDupes += 1;
    losersTotal += losers.length;
    losersByGroup.push({ canonical: canonical!, losers, normEmail });
  }

  console.log(`[dedup] scanned ${rows.length} entity_person rows`);
  console.log(`[dedup] ${groupsWithDupes} groups have duplicates`);
  console.log(`[dedup] ${losersTotal} loser rows would be archived\n`);

  for (const g of losersByGroup.slice(0, 30)) {
    console.log(`  ${g.normEmail}`);
    console.log(`    ✓ keep:    ${g.canonical.id} (${g.canonical.title.slice(0, 60)})`);
    for (const l of g.losers) {
      console.log(`    ✗ archive: ${l.id} (${l.title.slice(0, 60)})`);
    }
  }
  if (losersByGroup.length > 30) {
    console.log(`  … and ${losersByGroup.length - 30} more groups`);
  }

  if (!apply) {
    console.log('\n[dedup] dry run only. Re-run with APPLY=1 to archive duplicates.');
    await prisma.$disconnect();
    return;
  }

  let archived = 0;
  for (const g of losersByGroup) {
    for (const l of g.losers) {
      try {
        await prisma.$executeRawUnsafe(
          `UPDATE wiki_pages
              SET status = 'archived',
                  last_updated_at = NOW(),
                  last_updated_by = 'dedup_contacts',
                  metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
            WHERE id = $2`,
          JSON.stringify({
            archivedReason: 'duplicate_collapsed',
            archivedAt: new Date().toISOString(),
            canonicalId: g.canonical.id,
            canonicalEmail: g.normEmail,
          }),
          l.id,
        );
        archived += 1;
      } catch (err: any) {
        console.warn(`[dedup] failed to archive ${l.id}: ${err.message}`);
      }
    }
  }

  console.log(`\n[dedup] ✅ archived ${archived} duplicate loser rows`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[dedup] FAILED:', err);
  await prisma.$disconnect();
  process.exit(1);
});
