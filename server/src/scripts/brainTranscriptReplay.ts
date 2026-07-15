/**
 * Replay the exact questions from the user's frustrating transcript to
 * confirm Batch 1 (A+B+H) fixes them end-to-end.
 */
import { answerAsBrain } from '../routes/brainAskRoutes';

const QUESTIONS = [
  'Hi, how are you, how you can help me',
  'do you know me?',
  'can you tell me in which project i am working on actively?',
  'do you know about my company?',
  'do you know org charg?',                      // typo → org chart
  'do you have meployee info',                   // typo → employee
  'i am talking about employee',
  'what files or info you have?',
  'from where you got these pages?',
  'don\'t you have organization information (facl)?',
  'have you connected client\'s Gdrive?',
  'how many connector you are using',
  'can you read my emails?',
  'can you answer based on my email?',
  'can you tell me what Fahim Warraich asked me in email?',
  'can you search and bring specific answer from email?',
  'ok then tell me about satori from email',
  'can find any thing about satorin in whatapp?',
  'Satori',
  'can see my calendary and tell me any meetings for next 7 days?',
];

async function main() {
  const userId = 5;
  const clientNumber = 'TMC-0001';
  for (const q of QUESTIONS) {
    const t0 = Date.now();
    try {
      const r = await answerAsBrain(clientNumber, userId, q);
      const ms = Date.now() - t0;
      const srcSummary = (r.sources ?? []).map((s: any) => `[${s.type}] ${String(s.snippet ?? '').slice(0, 80)}`).join('\n     ');
      console.log(`\n━━━ (${ms}ms, intent=${(r as any).intent}, cites=${(r.sources ?? []).length}, gaps=${(r.gaps ?? []).length})`);
      console.log(`Q: ${q}`);
      console.log(`A: ${r.answer.replace(/\n/g, '\n   ')}`);
      if (srcSummary) console.log(`Sources:\n     ${srcSummary}`);
      if (r.gaps?.length) console.log(`Gaps: ${r.gaps.join(' · ')}`);
    } catch (err: any) {
      console.log(`\nQ: ${q}\nERROR: ${err.message}`);
    }
  }
  await new Promise((r) => setTimeout(r, 500));
}

main().catch((e) => { console.error(e); process.exit(1); })
  .finally(() => { setTimeout(() => process.exit(0), 1000).unref(); });
