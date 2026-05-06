/**
 * scripts/scribeBackfillEmails.ts
 *
 * Manual entry-point for the scribe backfill. Identical logic to the
 * 6-hourly scheduler in server.ts — both call backfillUserScribe()
 * from the maintenance service. Use this when you want to:
 *   - Run a one-off backfill for a single user
 *   - Run a full --all backfill on prod once, immediately, before
 *     the first scheduled tick
 *
 * Usage:
 *   npx tsx src/scripts/scribeBackfillEmails.ts <userEmail>
 *   npx tsx src/scripts/scribeBackfillEmails.ts --all
 */
import prisma from '../db/prisma';
import {
  backfillUserScribe,
  forEachActiveUser,
} from '../services/maintenance/queueArchiveMaintenanceService';

async function main() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: npx tsx src/scripts/scribeBackfillEmails.ts <userEmail | --all>');
    process.exit(1);
  }

  if (arg === '--all') {
    console.log('Backfilling every active user...\n');
    const results = await forEachActiveUser(async (cn, uid, email) => {
      const stats = await backfillUserScribe(cn, uid, {
        onProgress: (s) => process.stdout.write(`  ${email}: scanned=${s.scanned} created=${s.created} alreadyScribed=${s.alreadyScribed} errors=${s.errors}\r`),
      });
      process.stdout.write('\n');
      return stats;
    });
    console.log(`\n--- Summary ---`);
    let totals = { scanned: 0, alreadyScribed: 0, created: 0, errors: 0 };
    for (const r of results) {
      console.log(`${r.email.padEnd(40)} created=${r.result?.created ?? '-'} alreadyScribed=${r.result?.alreadyScribed ?? '-'} errors=${r.result?.errors ?? '-'} ${r.error ? `[FAIL: ${r.error}]` : ''}`);
      if (r.result) {
        totals.scanned += r.result.scanned;
        totals.alreadyScribed += r.result.alreadyScribed;
        totals.created += r.result.created;
        totals.errors += r.result.errors;
      }
    }
    console.log(`\nTotal: scanned=${totals.scanned} alreadyScribed=${totals.alreadyScribed} created=${totals.created} errors=${totals.errors}`);
  } else {
    const u = await prisma.user.findFirst({
      where: { email: arg } as any,
      select: { id: true, email: true, clientNumber: true },
    }) as any;
    if (!u) {
      console.error(`No user with email=${arg}`);
      process.exit(1);
    }
    console.log(`${u.email} (id=${u.id}, client=${u.clientNumber})`);
    const stats = await backfillUserScribe(u.clientNumber, u.id, {
      onProgress: (s) => process.stdout.write(`  ${u.email}: scanned=${s.scanned} created=${s.created} alreadyScribed=${s.alreadyScribed} errors=${s.errors}\r`),
    });
    process.stdout.write('\n');
    console.log(`\n--- Total ---`);
    console.log(`scanned         = ${stats.scanned}`);
    console.log(`alreadyScribed  = ${stats.alreadyScribed}`);
    console.log(`created         = ${stats.created}`);
    console.log(`errors          = ${stats.errors}`);
  }

  await prisma.$disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
