import prisma from '../db/prisma';
import { answerAsBrain } from '../routes/brainAskRoutes';

async function run(q: string) {
  console.log(`\n──── ${q} ────`);
  const r = await answerAsBrain('TMC-0001', 5, q);
  console.log('sources:');
  for (const s of r.sources.slice(0, 6)) console.log(`  - [${s.type}] ${s.snippet ?? ''}`);
  console.log('answer:\n' + r.answer.slice(0, 500));
}

async function main() {
  await run('who is gru?');
  await run('who is guru?');
  await run('tell me about gru');
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
