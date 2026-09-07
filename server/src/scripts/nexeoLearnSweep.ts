/**
 * nexeoLearnSweep — the nightly's LEARN phase, as a one-shot command.
 *
 * Owner, 2026-09-07: "since learning and improvement is already part of brain's
 * capability that's why i am expecting to make it part of brain's capability (nightly
 * cron) and also update score of brain's capability."
 *
 * Learn was the only capability with zero movement across the whole campaign, and the
 * reason was not the code: `proposeMemory` gated everything behind a click that was
 * never coming, and two memories sat pending from 2026-07-14 and 2026-08-07 while
 * `Active Memories` read (0). LEARN-001 fixed the creation-time rule; this drains the
 * residue and keeps draining it, so the capability stops depending on him opening a tab.
 *
 * It prints ONE line the loop can log and a human can read. It exits 0 even when it
 * activates nothing — an empty sweep is the healthy steady state, not a failure, and a
 * non-zero exit there would make the nightly look broken every night after the first.
 *
 *   npx ts-node src/scripts/nexeoLearnSweep.ts [--dry-run]
 */
import prisma from '../db/prisma';
import { sweepQualifyingMemories } from '../services/learning/learningService';

async function main(): Promise<number> {
  const dryRun = process.argv.includes('--dry-run');
  const r = await sweepQualifyingMemories({ dryRun });
  const verb = dryRun ? 'would activate' : 'activated';
  process.stdout.write(
    `learn-sweep: scanned ${r.scanned} pending · ${verb} ${r.activated} · held ${r.held}`
    + (r.titles.length ? ` · ${r.titles.map((t) => JSON.stringify(t)).join(', ')}` : '')
    + '\n',
  );
  return 0;
}

main()
  .then(async (code) => { await prisma.$disconnect(); process.exit(code); })
  .catch(async (err) => {
    process.stderr.write(`nexeoLearnSweep failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
