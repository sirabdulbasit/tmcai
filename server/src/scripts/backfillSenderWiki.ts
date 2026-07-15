/**
 * One-shot CLI: backfill sender_history + sender_topic Wiki pages from
 * existing feed_events. Run when onboarding a user or after a schema
 * change to the scribe.
 *
 * Usage:
 *   npx ts-node src/scripts/backfillSenderWiki.ts                 # all active users
 *   npx ts-node src/scripts/backfillSenderWiki.ts --user 5        # specific user
 *   npx ts-node src/scripts/backfillSenderWiki.ts --user 5 --keep # don't wipe existing
 */
import 'dotenv/config';
import prisma from '../db/prisma';
import { backfillSenderWiki } from '../services/knowledge/senderWikiBackfill';

async function main() {
  const args = process.argv.slice(2);
  const userArg = args.indexOf('--user');
  const userId = userArg >= 0 ? parseInt(args[userArg + 1], 10) : null;
  const keep = args.includes('--keep');

  const users = userId
    ? await prisma.user.findMany({ where: { id: userId }, select: { id: true, clientNumber: true, email: true } })
    : await prisma.user.findMany({ where: { isActive: true } as any, select: { id: true, clientNumber: true, email: true } });

  if (users.length === 0) {
    console.log('No users to backfill.');
    process.exit(0);
  }

  for (const u of users) {
    console.log(`\n▸ Backfilling ${u.email} (id=${u.id}, tenant=${u.clientNumber})…`);
    const summary = await backfillSenderWiki(u.clientNumber, u.id, { wipeFirst: !keep });
    console.log(`  total=${summary.totalEvents} processed=${summary.processed} senders=${summary.uniqueSenders} resummarized=${summary.resummarized} errors=${summary.errors} in ${(summary.durationMs / 1000).toFixed(1)}s`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
