/**
 * Brain chat battery — runs a wide set of questions against answerAsBrain
 * (the /brain/ask handler) and prints each response, flagging responses
 * that LOOK programmatic (bulleted feature lists, generic-AI boilerplate,
 * "I'm an AI / assistant" phrasing) so we can eyeball whether the brain
 * is behaving like a living EA or reverting to template-speak.
 */
import prisma from '../db/prisma';
import { answerAsBrain } from '../routes/brainAskRoutes';

const CASUAL = [
  'hi how are you?',
  'good morning',
  'tell me about you',
  'who are you?',
  'what do you do?',
  'what can you help me with?',
  'what is your name?',
  'do you have feelings?',
  'are you an AI?',
  'are you a bot?',
  "what's up?",
  'how was your day?',
  'hey',
  'yo',
  'are you real?',
  'do you sleep?',
  'how do you know me?',
  'what kind of assistant are you?',
  'can we be friends?',
  'tell me something interesting about yourself',
];

const PROFESSIONAL = [
  'what is on my plate today?',
  'show me my open items',
  'what is critical right now?',
  'who are our active accounts?',
  'list our key people',
  'what projects are we working on?',
  'any hot items i should look at first?',
  'do we have any delegated items waiting on replies?',
  'how many open items do i have?',
  'what is the status of open deals?',
  'tell me about my company',
  'what is our company name?',
  'what do we do at my company?',
  'who works with me?',
  'who handles legal and compliance?',
  'who handles scheduling?',
  'who owns sales proposals?',
  'who should i delegate a UAE sales proposal to?',
  'who handles audit questions?',
  'who looks after HR?',
  'what did we decide about the voyage ai proposal?',
  'what was the last big decision we made?',
  'any recent decisions i should know about?',
  'what have you done autonomously in the last 24 hours?',
  'what patterns have you noticed in my behaviour?',
  'what rules are you enforcing silently?',
  'what rules are you still learning?',
  'what is in my FACL folder?',
  'do we have a pricing policy in the knowledge base?',
  'summarize our internal SOPs',
  'do we have any active automation rules?',
  'do i have a meeting conflict this week?',
  'what are my free times tomorrow?',
  'what are the most important emails in my inbox today?',
  'any whatsapp messages i have missed?',
  'tell me about basit',
  'tell me about asad',
  'who is rahat?',
  'who has been emailing me this week?',
  'any newsletter senders i should unsubscribe from?',
  'what internal projects are active?',
  'what is my biggest open deal right now?',
  'do we have any blocked items?',
  'what is waiting on me right now?',
  'what have i been ignoring?',
  'what is the status of tallymarks consulting?',
  'what is the status of TMC?',
  'do we have any compliance issues pending?',
  'are there audit related items pending?',
  'what is pending for review?',
  'what emails need a reply today?',
];

const PERSONAL = [
  'do you remember my preferences?',
  'do you know how i text on whatsapp?',
  'do you know what tone i use in email?',
  'what do you know about me?',
  'what is my job?',
  'what is my role?',
  'who is my boss?',
  'what is my timezone?',
  'can you rename yourself to Albus?',
  'what should i call you?',
  'do you have an opinion on how i work?',
  'what do you think i should focus on today?',
  'what would you handle for me right now without asking?',
  'what would you prefer to ask me first?',
  'am i procrastinating on anything?',
];

const EDGE = [
  'the',
  '?',
  '??',
  'what',
  'tell me everything',
  'do you know about xyz corp?',
  'who handles unicorns?',
  'what is the status of the project we never talked about?',
  'what did we decide in 1999?',
  'asdf qwer zxcv',
  'tell me about "a company"',
  'status of ?',
  'who handles ?',
  'show me items for nobody',
  'what patterns?',
];

const ALL: Array<{ category: string; q: string }> = [
  ...CASUAL.map((q) => ({ category: 'casual', q })),
  ...PROFESSIONAL.map((q) => ({ category: 'professional', q })),
  ...PERSONAL.map((q) => ({ category: 'personal', q })),
  ...EDGE.map((q) => ({ category: 'edge', q })),
];

// Flags that suggest the answer went back to looking "programmed" /
// robotic. Not a ground truth — just a smell test.
function flagsFor(question: string, answer: string): string[] {
  const flags: string[] = [];
  const a = answer.toLowerCase();
  const q = question.toLowerCase();

  // Self-referential / identity question test — we want prose, not a bullet list of features
  const isSelfQ = /\b(you|your|yourself|name|who are|what do you|what can you|tell me about you|tell me about yourself)\b/.test(q);
  if (isSelfQ) {
    const bulletLines = (answer.match(/^\s*[\*\-•]\s+/gm) || []).length;
    if (bulletLines >= 4) flags.push(`BULLETED_SELF_DESC(${bulletLines})`);
    const boldLabels = (answer.match(/\*\*[^*]{2,40}:\*\*/g) || []).length;
    if (boldLabels >= 3) flags.push(`FEATURE_LABEL_LIST(${boldLabels})`);
  }

  if (/\b(as an ai|i'?m an ai|as a language model|as an assistant|i am an ai|large language model)\b/.test(a)) {
    flags.push('GENERIC_AI_DEFLECT');
  }
  if (/i (can'?t|do not|don'?t) have access to/.test(a) && orgSnapshotShouldCover(q)) {
    flags.push('REFUSES_WITH_DATA_AVAILABLE');
  }
  if (answer.length < 8) flags.push('TOO_SHORT');
  if (answer.length > 2500) flags.push('TOO_LONG');
  return flags;
}

function orgSnapshotShouldCover(question: string): boolean {
  const q = question.toLowerCase();
  return /\b(company|account|project|open|item|plate|delegate|decide|decision|pattern|rule|facl|key people|our|my|the team)\b/.test(q);
}

async function main() {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const take = arg ? Math.max(1, parseInt(arg, 10)) : ALL.length;
  const userId = 5; // Abdul Haseeb
  const clientNumber = 'TMC-0001';

  const questions = ALL.slice(0, take);
  console.log(`\n━━━ Brain chat battery — ${questions.length} questions as user #${userId} (${clientNumber}) ━━━\n`);

  const results: Array<{ category: string; q: string; answer: string; flags: string[]; ms: number }> = [];
  let idx = 0;
  for (const { category, q } of questions) {
    idx += 1;
    const t0 = Date.now();
    let answer = '';
    let flags: string[] = [];
    try {
      const r = await answerAsBrain(clientNumber, userId, q);
      answer = r.answer;
      flags = flagsFor(q, answer);
    } catch (err: any) {
      answer = `ERROR: ${err.message}`;
      flags = ['EXCEPTION'];
    }
    const ms = Date.now() - t0;
    results.push({ category, q, answer, flags, ms });

    const flagStr = flags.length ? `  ⚑ ${flags.join(', ')}` : '';
    console.log(`[${idx}/${questions.length}] (${category}, ${ms}ms)${flagStr}`);
    console.log(`  Q: ${q}`);
    console.log(`  A: ${answer.replace(/\n/g, '\n     ')}`);
    console.log('');
  }

  // Summary
  const totalFlags = results.filter((r) => r.flags.length > 0).length;
  const byCat: Record<string, { n: number; flagged: number; avgMs: number }> = {};
  for (const r of results) {
    const c = (byCat[r.category] ??= { n: 0, flagged: 0, avgMs: 0 });
    c.n += 1;
    c.avgMs += r.ms;
    if (r.flags.length) c.flagged += 1;
  }
  for (const c of Object.values(byCat)) c.avgMs = Math.round(c.avgMs / c.n);

  console.log('━━━ Summary ━━━');
  console.log(`Total: ${results.length}   Flagged: ${totalFlags}`);
  for (const [k, v] of Object.entries(byCat)) {
    console.log(`  ${k.padEnd(14)} ${v.n} qs · flagged ${v.flagged} · avg ${v.avgMs}ms`);
  }
  console.log('\nFlag legend:');
  console.log('  BULLETED_SELF_DESC(n)    — self-intro answered as a bullet list of n items (we want prose)');
  console.log('  FEATURE_LABEL_LIST(n)    — "**Label:**" pattern repeated, reads like a product page');
  console.log('  GENERIC_AI_DEFLECT       — "as an AI / language model / assistant" — persona broke');
  console.log('  REFUSES_WITH_DATA_AVAILABLE — refused despite snapshot probably having the answer');
  console.log('  TOO_SHORT / TOO_LONG     — bounds sanity check');
  console.log('');

  // Give in-flight spend tracker + cache writes a moment to land before exit,
  // then let node exit naturally (skip $disconnect to avoid racing background tasks).
  await new Promise((r) => setTimeout(r, 500));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
}).finally(() => {
  setTimeout(() => process.exit(0), 1000).unref();
});
