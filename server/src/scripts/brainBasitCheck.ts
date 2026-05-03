/** Replay problem questions AS BASIT (userId=1) to verify tenant-shared FACL is readable. */
import { answerAsBrain } from '../routes/brainAskRoutes';

const QUESTIONS = [
  'how many active projects we have?',
  'who is management?',
  'can you give me total employee list grade wise?',
  'can you tell me last biggest sales deal?',
  'how many total employee we have?',
  'do you have projects detail?',
  'who is taking care sales',
];

async function main() {
  const userId = 1; // Basit Ahmed
  const clientNumber = 'TMC-0001';
  for (const q of QUESTIONS) {
    const t0 = Date.now();
    try {
      const r = await answerAsBrain(clientNumber, userId, q);
      const ms = Date.now() - t0;
      console.log(`\n━━━ (${ms}ms, intent=${(r as any).intent}, cites=${(r.sources ?? []).length}, gaps=${(r.gaps ?? []).length})`);
      console.log(`Q: ${q}`);
      console.log(`A: ${r.answer.replace(/\n/g, '\n   ')}`);
      if ((r.sources ?? []).length) {
        const s = r.sources.map((x: any) => `[${x.type}] ${String(x.snippet ?? '').slice(0, 80)}`).join('\n     ');
        console.log(`Sources:\n     ${s}`);
      }
    } catch (err: any) {
      console.log(`\nQ: ${q}\nERROR: ${err.message}`);
    }
  }
  await new Promise((r) => setTimeout(r, 500));
}

main().catch((e) => { console.error(e); process.exit(1); })
  .finally(() => { setTimeout(() => process.exit(0), 1000).unref(); });
