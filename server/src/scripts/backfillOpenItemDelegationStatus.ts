/**
 * backfillOpenItemDelegationStatus — one-shot repair for OpenItems whose
 * description contains a "Delegated to X" line but whose status is NOT
 * 'DELEGATED'. User flagged on 2026-05-14: "EXIM solution" with
 * description "Delegated to Muhammad Yousaf" had status='NEW' so the
 * Delegated filter tab missed it.
 *
 * Going forward, openItemGate.ts catches this at create. This script
 * fixes the rows already in the table.
 *
 * Idempotent — re-running is safe.
 *
 * Usage:
 *   cd /var/www/tmcai/server
 *   node dist/scripts/backfillOpenItemDelegationStatus.js [--dry-run]
 *                                                         [--user-id=N]
 *                                                         [--client-number=XXXX]
 */
import prisma from '../db/prisma';

interface Args {
  clientNumber?: string;
  userId?: number;
  dryRun: boolean;
}

function parseArgs(): Args {
  const args: Args = { dryRun: false };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--client-number=')) args.clientNumber = a.split('=', 2)[1];
    else if (a.startsWith('--user-id=')) args.userId = parseInt(a.split('=', 2)[1], 10);
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

const DELEGATED_TO_PATTERN = /(?:^|\n)\s*delegat(?:ed|ing)\s+to[:\s]+([^\n]{2,80})/i;

function parseDelegatee(desc: string | null): string | null {
  if (!desc) return null;
  const m = desc.match(DELEGATED_TO_PATTERN);
  if (!m || !m[1]) return null;
  return m[1].trim().replace(/[.,;:'"`]+$/, '').trim() || null;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const where: any = {
    description: { contains: 'elegat', mode: 'insensitive' },
    status: { in: ['NEW', 'TRIAGED', 'IN_PROGRESS'] },
  };
  if (args.clientNumber) where.clientNumber = args.clientNumber;
  if (args.userId) where.userId = args.userId;

  const rows = await prisma.openItem.findMany({
    where,
    select: { id: true, title: true, description: true, status: true, delegateeName: true, clientNumber: true },
    take: 500,
  });

  let candidates = 0;
  let updated = 0;
  for (const r of rows) {
    const parsed = parseDelegatee(r.description);
    if (!parsed) continue;
    candidates += 1;
    console.log(`  [${r.id}] "${r.title}" — would set status=DELEGATED, delegateeName="${parsed}" (current status=${r.status})`);
    if (args.dryRun) continue;
    try {
      await prisma.openItem.update({
        where: { id: r.id },
        data: {
          status: 'DELEGATED',
          ...(r.delegateeName ? {} : { delegateeName: parsed }),
        } as any,
      });
      updated += 1;
    } catch (e: any) {
      console.warn(`    failed: ${e.message}`);
    }
  }

  console.log(`\nDone. candidates=${candidates} updated=${updated} ${args.dryRun ? '(DRY RUN)' : ''}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
