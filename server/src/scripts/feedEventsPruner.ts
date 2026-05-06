/**
 * scripts/feedEventsPruner.ts
 *
 * Manual entry-point for the feed_events pruner. Identical logic to
 * the daily scheduler in server.ts — both call pruneUserFeedEvents()
 * from the maintenance service. Default = dry run.
 *
 * Use this when you want to:
 *   - Preview what would prune (no flags = dry run)
 *   - Run a one-off prune on a specific user
 *   - Pre-trim prod immediately before the first scheduled tick
 *
 * Usage:
 *   # Dry run (safe — no deletes)
 *   npx tsx src/scripts/feedEventsPruner.ts <userEmail>
 *   npx tsx src/scripts/feedEventsPruner.ts --all
 *
 *   # Actually delete
 *   npx tsx src/scripts/feedEventsPruner.ts <userEmail> --apply
 *   npx tsx src/scripts/feedEventsPruner.ts --all --apply
 */
import prisma from '../db/prisma';
import {
  pruneUserFeedEvents,
  forEachActiveUser,
} from '../services/maintenance/queueArchiveMaintenanceService';

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  // Accept either `--all` (special target) or a userEmail. The earlier
  // version filtered out anything starting with '--', which incorrectly
  // rejected '--all'. Now we look for '--all' first, then fall back to
  // a positional non-flag argument.
  const target = args.includes('--all')
    ? '--all'
    : args.find((a) => !a.startsWith('--'));

  if (!target) {
    console.error('usage: npx tsx src/scripts/feedEventsPruner.ts <userEmail | --all> [--apply]');
    process.exit(1);
  }

  console.log(apply
    ? '⚠ APPLY MODE — will DELETE eligible feed_events.'
    : '✓ DRY RUN — counts only, no deletes. Pass --apply to actually prune.');

  if (target === '--all') {
    const results = await forEachActiveUser(async (cn, uid, email) => {
      const stats = await pruneUserFeedEvents(cn, uid, {
        apply,
        onProgress: (s) => process.stdout.write(`  ${email}: scanned=${s.scanned} ${apply ? 'deleted' : 'would-delete'}=${s.deleted} blocked=${s.blockedNoScribe}\r`),
      });
      process.stdout.write('\n');
      return stats;
    });
    let totals = { scanned: 0, eligibleByAge: 0, eligibleByDecision: 0, blockedNoScribe: 0, deleted: 0 };
    for (const r of results) {
      if (r.result) {
        totals.scanned += r.result.scanned;
        totals.eligibleByAge += r.result.eligibleByAge;
        totals.eligibleByDecision += r.result.eligibleByDecision;
        totals.blockedNoScribe += r.result.blockedNoScribe;
        totals.deleted += r.result.deleted;
      }
    }
    console.log(`\n--- Total ---`);
    console.log(`scanned                = ${totals.scanned}`);
    console.log(`eligible (older 30d)   = ${totals.eligibleByAge}`);
    console.log(`eligible (decided)     = ${totals.eligibleByDecision}`);
    console.log(`blocked (no scribe)    = ${totals.blockedNoScribe}`);
    console.log(`${apply ? 'deleted' : 'would delete'}        = ${totals.deleted}`);
  } else {
    const u = await prisma.user.findFirst({
      where: { email: target } as any,
      select: { id: true, email: true, clientNumber: true },
    }) as any;
    if (!u) {
      console.error(`No user with email=${target}`);
      process.exit(1);
    }
    console.log(`\n${u.email} (id=${u.id}, client=${u.clientNumber})`);
    const stats = await pruneUserFeedEvents(u.clientNumber, u.id, {
      apply,
      onProgress: (s) => process.stdout.write(`  ${u.email}: scanned=${s.scanned} ${apply ? 'deleted' : 'would-delete'}=${s.deleted} blocked-no-scribe=${s.blockedNoScribe}\r`),
    });
    process.stdout.write('\n');
    console.log(`\n--- Total ---`);
    console.log(`scanned                = ${stats.scanned}`);
    console.log(`eligible (older 30d)   = ${stats.eligibleByAge}`);
    console.log(`eligible (decided)     = ${stats.eligibleByDecision}`);
    console.log(`blocked (no scribe)    = ${stats.blockedNoScribe}`);
    console.log(`${apply ? 'deleted' : 'would delete'}        = ${stats.deleted}`);
    if (stats.blockedNoScribe > 0) {
      console.log(`\n⚠  ${stats.blockedNoScribe} rows could not be pruned because their scribe sibling is missing.`);
      console.log(`   Run the backfill first:\n     npx tsx src/scripts/scribeBackfillEmails.ts ${target}`);
    }
  }

  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
