import prisma from '../db/prisma';
import { answerAsBrain } from '../routes/brainAskRoutes';

async function main() {
  const clientNumber = 'TMC-0001';
  const userId = Number(process.argv[2] ?? 5);

  // Purge the 3 stale "information about Guru" gap pages so retrieval
  // isn't skewed by prior misses that are now addressed.
  const purged = await prisma.wikiPage.updateMany({
    where: {
      clientNumber, userId, pageType: 'gap',
      title: { contains: 'Guru', mode: 'insensitive' },
    },
    data: { status: 'deleted' },
  });
  console.log('[guru-fix] purged stale gap pages:', purged.count);

  for (const q of ['what did guru say?', 'what did Guru mention?', 'did guru reply']) {
    console.log('\n[guru-fix] query:', q);
    const r = await answerAsBrain(clientNumber, userId, q);
    console.log('[guru-fix] intent:', r.intent, ' gaps:', r.gaps);
    console.log('[guru-fix] sources:', r.sources.map((s) => s.snippet).slice(0, 6));
    console.log('[guru-fix] answer:\n', r.answer);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
