/**
 * smokeLiveSnapshots.ts — repro of the two "FAIL" queries from the UI
 * self-test, after wiring open_items + calendar into the composer.
 *
 *   1. "What are my most critical open items right now?"
 *   2. "What meetings do I have today and what should I prepare?"
 *
 * Previously Brain answered "I don't have access." Now it should list
 * the real data from open_items + gcal feed_events.
 */
import prisma from '../db/prisma';
import { answerAsBrain } from '../routes/brainAskRoutes';

async function run(clientNumber: string, userId: number, q: string) {
  console.log(`\n──────────────────────────────────────`);
  console.log(`Q: ${q}`);
  const r = await answerAsBrain(clientNumber, userId, q);
  console.log(`intent: ${r.intent}`);
  console.log(`sources:`);
  for (const s of r.sources.slice(0, 8)) console.log(`  - [${s.type}] ${s.snippet ?? ''}`);
  if (r.gaps && r.gaps.length > 0) console.log(`gaps: ${JSON.stringify(r.gaps)}`);
  console.log('answer:');
  console.log(r.answer);
}

async function main() {
  const clientNumber = process.argv[2] ?? 'TMC-0001';
  const userId = Number(process.argv[3] ?? 5);

  await run(clientNumber, userId, 'What are my most critical open items right now?');
  await run(clientNumber, userId, 'What meetings do I have today?');
  await run(clientNumber, userId, 'Do I have anything overdue?');
  await run(clientNumber, userId, 'What is on my calendar this week?');

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
