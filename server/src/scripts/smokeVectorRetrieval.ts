/**
 * Smoke test for the vector retrieval refactor.
 * Targets the exact questions that failed under pg_trgm + keyword
 * decomposition. Success = Brain surfaces real data, cites opened pages,
 * and stops filing "I don't have info" gap pages for content that's in
 * the wiki under differently-named pages.
 */
import { answerAsBrain } from '../routes/brainAskRoutes';

const QUESTIONS = [
  // Previously failed on "demo system" → only "CBL Demo" etc. in wiki
  'what did we conclude for demo system?',
  // Previously failed — "IP strategy" word not in any page title
  'tell me status IP strategy',
  // Hypothetical non-existent subject — should still file a meaningful gap
  'what we done so far for Microrewards',
  // Previously worked but should stay working
  'what did Fahim say?',
  'who is in management at TMC?',
  'how many active projects we have?',
];

async function main() {
  const userId = 1; // Basit
  const clientNumber = 'TMC-0001';
  for (const q of QUESTIONS) {
    const t0 = Date.now();
    try {
      const r = await answerAsBrain(clientNumber, userId, q);
      const ms = Date.now() - t0;
      console.log(`\n━━━ (${ms}ms, intent=${(r as any).intent}, cites=${(r.sources ?? []).length}, gaps=${(r.gaps ?? []).length})`);
      console.log(`Q: ${q}`);
      console.log(`A: ${r.answer.replace(/\n/g, '\n   ').slice(0, 900)}`);
      if ((r.sources ?? []).length > 0) {
        console.log('Sources:');
        for (const s of r.sources) console.log(`  · [${s.type}] ${String(s.snippet ?? '').slice(0, 90)}`);
      }
      const gaps = r.gaps ?? [];
      if (gaps.length > 0) console.log(`Gaps: ${gaps.join(' · ')}`);
    } catch (err: any) {
      console.log(`\nQ: ${q}\nERROR: ${err.message}`);
    }
  }
  await new Promise((r) => setTimeout(r, 500));
}

main().catch((e) => { console.error(e); process.exit(1); })
  .finally(() => setTimeout(() => process.exit(0), 1000).unref());
