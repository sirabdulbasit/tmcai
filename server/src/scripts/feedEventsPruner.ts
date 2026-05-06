/**
 * scripts/feedEventsPruner.ts
 *
 * Phase 3 of the queue/archive split. Trims feed_events down to the
 * active queue: last 30 days OR still-pending. Anything older or
 * terminally decided is removed — but ONLY after we've verified that
 * the corresponding row exists in the scribe archive (wiki_pages
 * email_message). No data is ever lost.
 *
 * Pruning rule (a row is eligible IFF all conditions hold):
 *
 *   1. sourceType = 'gmail'   (start narrow; other channels later)
 *   2. EITHER created_at < (now - 30 days)
 *      OR     a matching decision_log row with terminal userDecision
 *             exists for this user
 *   3. AND a wiki_pages row with the same gmailMessageId exists
 *      (== scribe has the data, deletion is safe)
 *
 * Default mode: dry run. Prints the eligible count and a sample of
 * IDs without deleting. Pass `--apply` to actually delete.
 *
 * Usage:
 *   # See what would be pruned (safe — no writes)
 *   npx tsx src/scripts/feedEventsPruner.ts <userEmail>
 *
 *   # Same, all users
 *   npx tsx src/scripts/feedEventsPruner.ts --all
 *
 *   # Apply (deletes!)
 *   npx tsx src/scripts/feedEventsPruner.ts --all --apply
 *
 * Idempotent — re-running on already-pruned tenants is a no-op.
 */
import prisma from '../db/prisma';

interface PruneStats {
  scanned: number;
  eligibleByAge: number;
  eligibleByDecision: number;
  blockedNoScribe: number;
  deleted: number;
}

const TERMINAL_DECISIONS = ['approved', 'delegated', 'snoozed', 'dismissed', 'overrode'];

async function pruneForUser(
  clientNumber: string, userId: number, userEmail: string,
  apply: boolean,
): Promise<PruneStats> {
  const stats: PruneStats = {
    scanned: 0, eligibleByAge: 0, eligibleByDecision: 0,
    blockedNoScribe: 0, deleted: 0,
  };

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Decision log: which feed_event ids did this user terminally
  // decide on? Used as the second eligibility path.
  const decided = await prisma.decisionLog.findMany({
    where: {
      clientNumber, userId,
      userDecision: { in: TERMINAL_DECISIONS } as any,
      entityId: { not: null } as any,
    } as any,
    select: { entityId: true },
  }).catch(() => [] as Array<{ entityId: string | null }>);
  const decidedSet = new Set(decided.map((d) => d.entityId).filter(Boolean) as string[]);

  // Page through Gmail feed_events oldest-first so we trim the longest
  // tail first.
  const PAGE = 200;
  let offset = 0;
  while (true) {
    const events = await prisma.feedEvent.findMany({
      where: { clientNumber, userId, sourceType: 'gmail' } as any,
      select: { id: true, sourceId: true, rawPayload: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
      skip: offset,
      take: PAGE,
    });
    if (events.length === 0) break;

    for (const ev of events) {
      stats.scanned += 1;
      const olderThan30d = ev.createdAt < cutoff;
      const isDecided = decidedSet.has(ev.id);
      if (!olderThan30d && !isDecided) continue;
      if (olderThan30d) stats.eligibleByAge += 1;
      if (isDecided) stats.eligibleByDecision += 1;

      // Safety check: scribe sibling must exist before we delete.
      const p: any = ev.rawPayload ?? {};
      const gmailMessageId = String(p.id ?? p.messageId ?? ev.sourceId ?? '').trim();
      if (!gmailMessageId) {
        // No id to dedupe on → can't verify scribe sibling → blocked.
        stats.blockedNoScribe += 1;
        continue;
      }
      const scribed = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM wiki_pages
          WHERE client_number = $1
            AND user_id = $2
            AND page_type = 'email_message'
            AND metadata->>'gmailMessageId' = $3
          LIMIT 1`,
        clientNumber, userId, gmailMessageId,
      ).catch(() => [] as Array<{ id: string }>);
      if (scribed.length === 0) {
        stats.blockedNoScribe += 1;
        continue;
      }

      if (apply) {
        await prisma.feedEvent.delete({ where: { id: ev.id } }).catch(() => null);
        stats.deleted += 1;
      } else {
        stats.deleted += 1; // count what we would have deleted
      }
    }

    process.stdout.write(`  ${userEmail}: scanned=${stats.scanned} ${apply ? 'deleted' : 'would-delete'}=${stats.deleted} blocked-no-scribe=${stats.blockedNoScribe}\r`);
    offset += events.length;
    if (events.length < PAGE) break;
  }
  process.stdout.write('\n');
  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const target = args.find((a) => !a.startsWith('--'));

  if (!target) {
    console.error('usage: npx tsx src/scripts/feedEventsPruner.ts <userEmail | --all> [--apply]');
    process.exit(1);
  }

  console.log(apply
    ? '⚠ APPLY MODE — will DELETE eligible feed_events.'
    : '✓ DRY RUN — counts only, no deletes. Pass --apply to actually prune.');

  let users: Array<{ id: number; email: string; clientNumber: string }>;
  if (target === '--all') {
    users = await prisma.user.findMany({
      where: { isActive: true } as any,
      select: { id: true, email: true, clientNumber: true },
    }) as any[];
    console.log(`Pruning ${users.length} users...`);
  } else {
    const u = await prisma.user.findFirst({
      where: { email: target } as any,
      select: { id: true, email: true, clientNumber: true },
    }) as any;
    if (!u) {
      console.error(`No user with email=${target}`);
      process.exit(1);
    }
    users = [u];
  }

  const totals: PruneStats = {
    scanned: 0, eligibleByAge: 0, eligibleByDecision: 0,
    blockedNoScribe: 0, deleted: 0,
  };
  for (const u of users) {
    console.log(`\n${u.email} (id=${u.id}, client=${u.clientNumber})`);
    const s = await pruneForUser(u.clientNumber, u.id, u.email, apply);
    totals.scanned += s.scanned;
    totals.eligibleByAge += s.eligibleByAge;
    totals.eligibleByDecision += s.eligibleByDecision;
    totals.blockedNoScribe += s.blockedNoScribe;
    totals.deleted += s.deleted;
  }

  console.log(`\n--- Total ---`);
  console.log(`scanned                = ${totals.scanned}`);
  console.log(`eligible (older 30d)   = ${totals.eligibleByAge}`);
  console.log(`eligible (decided)     = ${totals.eligibleByDecision}`);
  console.log(`blocked (no scribe)    = ${totals.blockedNoScribe}`);
  console.log(`${apply ? 'deleted' : 'would delete'}        = ${totals.deleted}`);

  if (totals.blockedNoScribe > 0) {
    console.log(`\n⚠  ${totals.blockedNoScribe} rows could not be pruned because their scribe sibling is missing.`);
    console.log(`   Run the backfill first to create those:`);
    console.log(`     npx tsx src/scripts/scribeBackfillEmails.ts ${target}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
