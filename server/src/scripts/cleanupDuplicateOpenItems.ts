/**
 * cleanupDuplicateOpenItems — one-shot repair for the meta-task / wrapper
 * duplicate pattern in open_items.
 *
 * Pattern: user wrote "I'll add this as an open item for X" in outbound;
 * commitment extractor produced an open_item titled "add 'X' as an open
 * item"; meanwhile the manual path created an open_item titled just "X".
 * Two rows, one intent. The deduper ships forward — this script cleans
 * up what already exists.
 *
 * Detection: for each user-owned active open_item, normalise the title
 * (strip "add ... as an open item" wrapper, quotes, whitespace) and
 * group items whose normalised text contains another item's normalised
 * text. Keep the SHORTER (= canonical task) row, archive the longer
 * (= meta-wrapper) row.
 *
 * Idempotent — re-running is safe; already-archived rows are skipped.
 *
 * Run on Ubuntu:
 *   cd /var/www/tmcai/server
 *   node dist/scripts/cleanupDuplicateOpenItems.js [--dry-run]
 *                                                  [--user-id=N]
 *                                                  [--client-number=XXXX]
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

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/^(add|please add|note|please note|track|create an open item for|add to open items)\s+/i, '')
    .replace(/\s+as an open item$/i, '')
    .replace(/['"`'']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const ACTIVE = ['NEW', 'TRIAGED', 'IN_PROGRESS', 'DELEGATED', 'WAITING_INFO', 'SNOOZED'];

async function main(): Promise<void> {
  const args = parseArgs();
  let clientNumber = args.clientNumber;
  let userId = args.userId;

  if (!clientNumber || !userId) {
    const user = await prisma.user.findFirst({
      where: userId ? { id: userId } : { isActive: true } as any,
      orderBy: { id: 'asc' },
      select: { id: true, clientNumber: true, email: true },
    });
    if (!user) {
      console.error('No active user found. Pass --user-id=N or --client-number=XXXX.');
      process.exit(1);
    }
    clientNumber = clientNumber ?? user.clientNumber;
    userId = userId ?? user.id;
    console.log(`Defaulting to ${user.email} (tenant ${clientNumber}, user ${userId}).`);
  }

  console.log(`\nScanning active open_items for duplicate wrapper/inner pattern. dryRun=${args.dryRun}\n`);

  const items = await prisma.openItem.findMany({
    where: {
      clientNumber,
      userId,
      ownerId: userId,
      status: { in: ACTIVE },
    } as any,
    select: { id: true, title: true, status: true, createdAt: true, sourceFeed: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Found ${items.length} active items.\n`);

  // For each item, find any OTHER item whose normalised title contains
  // this one's (or is contained in this one's). Group → keep the shorter
  // normalised title (= canonical task), archive the longer (= wrapper).
  type Pair = { keepId: string; keepTitle: string; archiveId: string; archiveTitle: string };
  const pairs: Pair[] = [];
  const decided = new Set<string>();

  for (let i = 0; i < items.length; i++) {
    if (decided.has(items[i].id)) continue;
    const a = items[i];
    const aNorm = normalize(a.title);
    if (aNorm.length < 6) continue;
    for (let j = i + 1; j < items.length; j++) {
      if (decided.has(items[j].id)) continue;
      const b = items[j];
      const bNorm = normalize(b.title);
      if (bNorm.length < 6) continue;
      const aContainsB = aNorm.includes(bNorm) && aNorm !== bNorm;
      const bContainsA = bNorm.includes(aNorm) && aNorm !== bNorm;
      const equal = aNorm === bNorm;
      if (!aContainsB && !bContainsA && !equal) continue;
      // Keep the shorter normalised one (canonical); archive the longer (wrapper).
      // If equal, keep the earlier-created one.
      let keep, archive;
      if (equal) {
        keep = a; archive = b;
      } else if (aNorm.length < bNorm.length) {
        keep = a; archive = b;
      } else {
        keep = b; archive = a;
      }
      pairs.push({
        keepId: keep.id, keepTitle: keep.title,
        archiveId: archive.id, archiveTitle: archive.title,
      });
      decided.add(archive.id);
      console.log(`  DUP: keep "${keep.title}"`);
      console.log(`       archive "${archive.title}"`);
      console.log('');
    }
  }

  console.log(`\n${pairs.length} duplicate pair(s) found.\n`);

  if (args.dryRun) {
    console.log('DRY RUN — no changes made. Re-run without --dry-run to apply.');
    await prisma.$disconnect();
    return;
  }

  let archived = 0;
  for (const p of pairs) {
    try {
      await prisma.openItem.update({
        where: { id: p.archiveId },
        data: {
          status: 'DONE',
          // Stamp the dedup reason in description so the audit trail survives.
          description: { set: `[dedup-cleanup 2026-05-14] Merged into "${p.keepTitle}" (id ${p.keepId}). Original title: "${p.archiveTitle}"` } as any,
        } as any,
      });
      archived += 1;
    } catch (e: any) {
      console.warn(`  failed to archive ${p.archiveId}: ${e.message}`);
    }
  }
  console.log(`Done. archived=${archived} (set to DONE with dedup audit note).`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
