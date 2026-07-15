/**
 * cleanupJunkContacts.ts — one-shot scrub of existing junk contacts
 * created before the senderQualityFilter was introduced.
 *
 * Why this exists: pre-filter, every newsletter / no-reply / tracking-
 * token sender that landed on the user's feed produced an
 * `entity_person` wiki page. By the time the filter shipped, TMC-0001
 * had 515 contacts of which most were junk (anthropic
 * <no-reply-...>, etc.).
 *
 * The script:
 *   1. Loads every entity_person wiki page in the target tenant
 *   2. Runs `isLikelyAutomated(email)` against the metadata.email
 *   3. For matches:
 *        - dryRun=true (default) → prints the page id + title
 *        - dryRun=false           → soft-archives the page
 *          (status='archived', metadata.archivedReason='junk_filter')
 *
 * Soft-archive is reversible — set status back to 'active' and the
 * page reappears. Hard-delete would be destructive and lose any
 * sender_history / wiki_page_link references.
 *
 * Usage:
 *   npx ts-node src/scripts/cleanupJunkContacts.ts             # dry-run, all tenants
 *   npx ts-node src/scripts/cleanupJunkContacts.ts TMC-0001    # dry-run, one tenant
 *   APPLY=1 npx ts-node src/scripts/cleanupJunkContacts.ts TMC-0001  # actually archive
 */
import 'dotenv/config';
import prisma from '../db/prisma';
import { isLikelyAutomated } from '../services/knowledge/senderQualityFilter';

interface PageRow {
  id: string;
  title: string;
  metadata: any;
  status: string;
  client_number: string;
}

async function main() {
  const targetTenant = process.argv[2] ?? null;
  const apply = process.env.APPLY === '1';
  console.log(`[cleanup] mode: ${apply ? 'APPLY (archiving)' : 'DRY RUN'}; tenant: ${targetTenant ?? 'ALL'}`);

  const pages = await prisma.$queryRawUnsafe<PageRow[]>(
    `SELECT id, title, metadata, status, client_number
       FROM wiki_pages
      WHERE page_type = 'entity_person'
        AND status = 'active'
        ${targetTenant ? 'AND client_number = $1' : ''}`,
    ...(targetTenant ? [targetTenant] : []),
  );

  console.log(`[cleanup] scanning ${pages.length} active entity_person pages`);

  const flagged: Array<{ id: string; email: string; title: string; tenant: string }> = [];
  for (const p of pages) {
    const email = (p.metadata?.email ?? '').toString().trim().toLowerCase();
    if (!email) continue;
    if (isLikelyAutomated(email)) {
      flagged.push({ id: p.id, email, title: p.title, tenant: p.client_number });
    }
  }

  console.log(`[cleanup] ${flagged.length} pages match the junk filter\n`);
  for (const f of flagged.slice(0, 50)) {
    console.log(`  ${f.tenant}  ${f.email}  →  ${f.title.slice(0, 60)}`);
  }
  if (flagged.length > 50) {
    console.log(`  … and ${flagged.length - 50} more`);
  }

  if (!apply) {
    console.log('\n[cleanup] dry run only. Re-run with APPLY=1 to archive.');
    await prisma.$disconnect();
    return;
  }

  let archived = 0;
  for (const f of flagged) {
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE wiki_pages
            SET status = 'archived',
                last_updated_at = NOW(),
                last_updated_by = 'cleanup_junk_contacts',
                metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
          WHERE id = $2`,
        JSON.stringify({
          archivedReason: 'junk_filter',
          archivedAt: new Date().toISOString(),
          archivedEmail: f.email,
        }),
        f.id,
      );
      archived += 1;
    } catch (err: any) {
      console.warn(`[cleanup] failed to archive ${f.id}: ${err.message}`);
    }
  }

  console.log(`\n[cleanup] ✅ archived ${archived} junk contact pages`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('[cleanup] FAILED:', err);
  await prisma.$disconnect();
  process.exit(1);
});
