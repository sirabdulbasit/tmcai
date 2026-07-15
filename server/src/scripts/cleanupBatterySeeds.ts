/**
 * Clean up regression-battery seed rows that leak into MD's real open
 * items and pollute the Day Brief.
 *
 * The brainChatRegressionBattery.ts seeds a few items as part of test
 * scenarios:
 *   - "Test regression task"
 *   - "Test Urdu item"
 *   - "Revisit pricing for Phoenix Systems" (battery_seed metadata flag,
 *     also created by some scenarios)
 *
 * On a real user account these end up indistinguishable from real
 * work. This script DELETES them (hard, like cleanupLegacyHaseebOSContent.ts).
 *
 * Dry-run by default. Pass --apply to actually delete.
 *
 *   npx ts-node src/scripts/cleanupBatterySeeds.ts
 *   npx ts-node src/scripts/cleanupBatterySeeds.ts --apply
 */
import prisma from '../db/prisma';

async function main() {
  const apply = process.argv.includes('--apply');

  // Match by title prefix (the test titles are stable) OR by the
  // metadata.battery_seed flag (newer scenarios stamp this). Either
  // signal is sufficient to identify a battery seed.
  const titleMatches = [
    'Test regression task',
    'Test Urdu item',
  ];

  // Count first
  const byTitleCount = await prisma.openItem.count({
    where: {
      title: { in: titleMatches },
    },
  }).catch(() => 0);

  const byMetadataCount = await prisma.openItem.count({
    where: {
      metadata: { path: ['battery_seed'], not: null } as any,
    },
  }).catch(() => 0);

  console.log(`open_items by title match (${titleMatches.join(', ')}): ${byTitleCount}`);
  console.log(`open_items by metadata.battery_seed flag:               ${byMetadataCount}`);

  // Show a sample so MD can sanity-check what we're about to delete.
  const sample = await prisma.openItem.findMany({
    where: {
      OR: [
        { title: { in: titleMatches } },
        { metadata: { path: ['battery_seed'], not: null } as any },
      ],
    },
    select: { id: true, title: true, status: true, priority: true, createdAt: true, metadata: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
  }).catch(() => [] as any[]);

  if (sample.length > 0) {
    console.log('\nSample (most recent 10):');
    for (const s of sample) {
      const tag = (s.metadata as any)?.battery_seed ? ` (battery_seed=${(s.metadata as any).battery_seed})` : '';
      console.log(`  - ${s.id} [${s.priority}/${s.status}] ${s.title}${tag}`);
    }
  }

  if (!apply) {
    console.log('\nDry run — pass --apply to delete.');
    return;
  }

  console.log('\nApplying deletes…');
  const del = await prisma.openItem.deleteMany({
    where: {
      OR: [
        { title: { in: titleMatches } },
        { metadata: { path: ['battery_seed'], not: null } as any },
      ],
    },
  }).catch((e) => { console.error(e); return { count: 0 }; });
  console.log(`Deleted open_items: ${del.count}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
