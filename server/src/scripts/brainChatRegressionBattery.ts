/**
 * Regression battery for Brain Chat — focused on the specific failures
 * MD reported on 2026-05-12:
 *   1. Full-name address ("Yes, Basit Ahmed") instead of first-name only
 *   2. Refusing to add an open item with a fabricated "SW_DASHBOARD/FACL doc"
 *   3. Five-turn drag to add one open item; lost slot context between turns
 *   4. Language flipping (English question → Urdu reply, then Roman-Urdu → English)
 *   5. Stale "today's date" anchor
 *
 * Each scenario is a sequence of user turns + assertions. After each turn
 * Brain's reply is run through a list of predicates; any failure is
 * logged. At the end we print a per-scenario PASS/FAIL summary.
 *
 * The script also counts open_items rows for the test user before vs
 * after, so we can verify dispatched actions actually wrote to the DB
 * (not just that Brain SAID it added something).
 *
 * Usage:
 *   npx ts-node src/scripts/brainChatRegressionBattery.ts            # all scenarios, user=5 / TMC-0001
 *   npx ts-node src/scripts/brainChatRegressionBattery.ts --user 5 --client TMC-0001
 */
import prisma from '../db/prisma';
import { answerAsBrain, type BrainHistoryTurn } from '../routes/brainAskRoutes';

type Assertion = { name: string; check: (answer: string, ctx: ScenarioCtx) => boolean | string };

interface ScenarioCtx {
  userId: number;
  clientNumber: string;
  history: BrainHistoryTurn[];
  openItemsAtStart: number;
  openItemTitles: Set<string>;
  todayIso: string;
  tomorrowIso: string;
}

interface ScenarioStep {
  user: string;
  assertions: Assertion[];
}

interface Scenario {
  name: string;
  setup?: (ctx: ScenarioCtx) => Promise<void>;
  steps: ScenarioStep[];
  /** Final assertions checked once, after all steps, against the full
   *  history + DB state. Use for "an open item was created by the end". */
  finalAssertions?: Array<{ name: string; check: (ctx: ScenarioCtx) => Promise<boolean | string> }>;
}

// ── Helpers ────────────────────────────────────────────────────────────
function notFullName(_a: string, ctx: ScenarioCtx): boolean | string {
  // Reject any occurrence of "Basit Ahmed" / full-name address. Pass if
  // only first name "Basit" or no name at all is used.
  // We don't have the actual user.name in this generic helper; the scenario
  // ctx will be specialised below.
  return true;
}

function containsRomanUrdu(answer: string): boolean | string {
  // Heuristic — at least one of these Roman-Urdu / Urdu-script tokens.
  const romanUrduTokens = /\b(aap|kya|hai|hain|nahi|han|jee|theek|batao|batain|chahiye|abhi|kal|kal|kar|kr|krna|krne|raha|rahi|krdiya|aaj)\b/i;
  const urduScript = /[؀-ۿ]/;
  if (romanUrduTokens.test(answer) || urduScript.test(answer)) return true;
  return `expected Roman-Urdu / Urdu-script reply, got: ${answer.slice(0, 80)}…`;
}

function isEnglishOnly(answer: string): boolean | string {
  // No Urdu script, no Roman-Urdu tokens.
  const urduScript = /[؀-ۿ]/;
  const romanUrduTokens = /\b(aap|kya|hai|hain|nahi|han|jee|theek|batao|chahiye|kal|krdiya)\b/i;
  if (urduScript.test(answer)) return 'unexpected Urdu script in English reply';
  if (romanUrduTokens.test(answer)) return 'unexpected Roman-Urdu tokens in English reply';
  return true;
}

function shorterThan(maxChars: number) {
  return (answer: string) => answer.length <= maxChars || `expected ≤${maxChars} chars, got ${answer.length}`;
}

function doesNotMention(phrase: string) {
  return (answer: string) => {
    const has = new RegExp(phrase, 'i').test(answer);
    return !has || `unexpected mention of "${phrase}" in answer: ${answer.slice(0, 120)}…`;
  };
}

function mentions(phrase: string) {
  return (answer: string) => {
    const has = new RegExp(phrase, 'i').test(answer);
    return has || `expected mention of "${phrase}" in answer: ${answer.slice(0, 120)}…`;
  };
}

// ── Scenarios ──────────────────────────────────────────────────────────
function buildScenarios(firstName: string, fullName: string): Scenario[] {
  const fullNameRe = new RegExp(`\\b${fullName.replace(/\s+/g, '\\s+')}\\b`, 'i');
  const firstNameOnly: Assertion = {
    name: 'address by first name only (no full name)',
    check: (a) => !fullNameRe.test(a) || `addressed by full name "${fullName}" — should be first name only`,
  };

  return [
    {
      name: 'first-name greeting',
      steps: [
        {
          user: 'Hi',
          assertions: [
            firstNameOnly,
            { name: 'short greeting', check: shorterThan(300) },
          ],
        },
      ],
    },
    {
      name: 'today\'s date anchor',
      steps: [
        {
          user: 'What is today\'s date?',
          assertions: [
            {
              name: 'includes today\'s ISO date',
              check: (a, ctx) => a.includes(ctx.todayIso) || `expected today=${ctx.todayIso} in answer: ${a.slice(0, 120)}…`,
            },
          ],
        },
      ],
    },
    {
      name: 'no-fabrication on fake doc',
      steps: [
        {
          user: 'Add this to my SW_DASHBOARD doc',
          assertions: [
            { name: 'no FACL fabrication', check: doesNotMention('FACL doc|FACL doc.|SW_DASHBOARD/HaseebOS') },
            { name: 'no fake document path', check: doesNotMention('read-only state|cannot modify the.*document') },
            firstNameOnly,
          ],
        },
      ],
    },
    {
      name: 'add open item — single shot with explicit due date',
      steps: [
        {
          user: 'Add "Test regression task" to my open items, due tomorrow',
          assertions: [
            firstNameOnly,
            { name: 'confirms it was added', check: mentions('added|done|noted|got it') },
            { name: 'does not re-ask for assignee/priority', check: doesNotMention('assignee|priority|importance') },
          ],
        },
      ],
      finalAssertions: [
        {
          name: 'open_items table has the new "Test regression task" row',
          check: async (ctx) => {
            const row = await prisma.openItem.findFirst({
              where: {
                clientNumber: ctx.clientNumber,
                userId: ctx.userId,
                title: { contains: 'Test regression task' },
              },
              orderBy: { createdAt: 'desc' },
              select: { id: true, title: true, dueDate: true },
            });
            if (!row) return 'no open_item row created';
            if (!row.dueDate) return `row created but no dueDate: ${row.title}`;
            // dueDate should be today + 1
            const isoDue = row.dueDate.toISOString().slice(0, 10);
            if (isoDue !== ctx.tomorrowIso) return `dueDate=${isoDue}, expected ${ctx.tomorrowIso}`;
            return true;
          },
        },
      ],
    },
    {
      name: 'slot continuity — add item across 3 turns (Kashif/White-Belt pattern)',
      steps: [
        {
          user: 'Do I have any email about white belt course?',
          assertions: [
            firstNameOnly,
            // Brain may or may not have a real email — don't assert on content.
            // We only care that it's English (mirroring the question's language).
            { name: 'English reply (matches question)', check: isEnglishOnly },
          ],
        },
        {
          user: 'Add it to my open items',
          assertions: [
            firstNameOnly,
            // Either it acts (asks 0 follow-up Qs) OR asks at MOST one tight Q.
            // Reject the "what's the assignee, priority, importance, due date" multi-ask.
            { name: 'no multi-slot interrogation', check: doesNotMention('assignee.+priority|priority.+due date.+importance') },
          ],
        },
        {
          user: 'Take it by tomorrow',
          assertions: [
            firstNameOnly,
            { name: 'does not pivot to retrieval ("I don\'t see any items due tomorrow")', check: doesNotMention('don\'t see any open items|I don\'t see any items due') },
          ],
        },
      ],
      finalAssertions: [
        {
          name: 'open_items has a white-belt-related row created during this scenario',
          check: async (ctx) => {
            const row = await prisma.openItem.findFirst({
              where: {
                clientNumber: ctx.clientNumber,
                userId: ctx.userId,
                createdAt: { gte: new Date(Date.now() - 10 * 60 * 1000) }, // last 10 min
                title: { contains: 'white belt', mode: 'insensitive' as any },
              },
              orderBy: { createdAt: 'desc' },
              select: { id: true, title: true, dueDate: true },
            });
            if (!row) return 'no white-belt open_item row created across the 3 turns';
            return true;
          },
        },
      ],
    },
    {
      name: 'language mirror — Roman Urdu question',
      steps: [
        {
          user: 'Mere paas kitne open items hain?',
          assertions: [
            firstNameOnly,
            { name: 'Roman-Urdu / Urdu reply', check: (a) => containsRomanUrdu(a) },
          ],
        },
      ],
    },
    {
      name: 'language mirror — Roman Urdu add-item',
      steps: [
        {
          user: '"Test Urdu item" ko mere open items mein add karo, kal tak',
          assertions: [
            firstNameOnly,
            { name: 'Roman-Urdu / Urdu reply', check: (a) => containsRomanUrdu(a) },
          ],
        },
      ],
      finalAssertions: [
        {
          name: 'open_items has "Test Urdu item" with tomorrow due',
          check: async (ctx) => {
            const row = await prisma.openItem.findFirst({
              where: {
                clientNumber: ctx.clientNumber,
                userId: ctx.userId,
                title: { contains: 'Test Urdu item' },
              },
              orderBy: { createdAt: 'desc' },
              select: { title: true, dueDate: true },
            });
            if (!row) return 'no row created from Roman-Urdu add command';
            if (!row.dueDate) return 'row created but no dueDate from "kal tak"';
            return true;
          },
        },
      ],
    },
  ];
}

// ── Runner ─────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const argUser = args[args.indexOf('--user') + 1];
  const argClient = args[args.indexOf('--client') + 1];
  const userId = argUser && argUser !== '--user' ? parseInt(argUser, 10) : 5;
  const clientNumber = argClient && argClient !== '--client' ? argClient : 'TMC-0001';

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const fullName = user?.name ?? 'Test User';
  const firstName = fullName.split(/\s+/).find(Boolean) ?? 'there';

  const todayIso = new Date().toISOString().slice(0, 10);
  const tomorrowIso = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const startCount = await prisma.openItem.count({ where: { clientNumber, userId } });

  console.log(`\n━━━ Brain Chat Regression Battery ━━━`);
  console.log(`User #${userId} (${fullName}) · tenant ${clientNumber}`);
  console.log(`Today=${todayIso}  Tomorrow=${tomorrowIso}  open_items at start=${startCount}\n`);

  const scenarios = buildScenarios(firstName, fullName);
  const scenarioResults: Array<{ name: string; passed: number; failed: number; failures: string[]; durMs: number }> = [];

  for (const sc of scenarios) {
    console.log(`▶ ${sc.name}`);
    const t0 = Date.now();
    const ctx: ScenarioCtx = {
      userId, clientNumber,
      history: [],
      openItemsAtStart: await prisma.openItem.count({ where: { clientNumber, userId } }),
      openItemTitles: new Set(),
      todayIso, tomorrowIso,
    };
    if (sc.setup) await sc.setup(ctx);

    let passed = 0; let failed = 0;
    const failures: string[] = [];

    for (let i = 0; i < sc.steps.length; i++) {
      const step = sc.steps[i];
      let answer = '';
      try {
        const r = await answerAsBrain(clientNumber, userId, step.user, ctx.history);
        answer = r.answer;
      } catch (e: any) {
        answer = `ERROR: ${e?.message ?? e}`;
        failed += 1;
        failures.push(`turn ${i + 1}: exception — ${answer}`);
        continue;
      }
      ctx.history.push({ role: 'user', text: step.user });
      ctx.history.push({ role: 'brain', text: answer });
      console.log(`   turn ${i + 1} → user: ${step.user}`);
      console.log(`             brain: ${answer.replace(/\n/g, '\n                    ').slice(0, 400)}${answer.length > 400 ? '…' : ''}`);
      for (const a of step.assertions) {
        const verdict = a.check(answer, ctx);
        if (verdict === true) passed += 1;
        else {
          failed += 1;
          failures.push(`turn ${i + 1} · ${a.name}: ${typeof verdict === 'string' ? verdict : 'failed'}`);
        }
      }
    }
    if (sc.finalAssertions) {
      for (const a of sc.finalAssertions) {
        const verdict = await a.check(ctx);
        if (verdict === true) passed += 1;
        else {
          failed += 1;
          failures.push(`final · ${a.name}: ${typeof verdict === 'string' ? verdict : 'failed'}`);
        }
      }
    }
    const durMs = Date.now() - t0;
    scenarioResults.push({ name: sc.name, passed, failed, failures, durMs });
    console.log(`   ${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed  (${durMs}ms)`);
    if (failures.length > 0) for (const f of failures) console.log(`       - ${f}`);
    console.log();
  }

  // Summary
  const endCount = await prisma.openItem.count({ where: { clientNumber, userId } });
  const totalPassed = scenarioResults.reduce((s, r) => s + r.passed, 0);
  const totalFailed = scenarioResults.reduce((s, r) => s + r.failed, 0);
  console.log('━━━ Summary ━━━');
  console.log(`Scenarios: ${scenarioResults.length}   Assertions passed: ${totalPassed}  failed: ${totalFailed}`);
  console.log(`open_items: ${startCount} → ${endCount}  (delta ${endCount - startCount})`);
  for (const r of scenarioResults) {
    console.log(`  ${r.failed === 0 ? '✅' : '❌'} ${r.name}  (${r.passed}/${r.passed + r.failed})  ${r.durMs}ms`);
  }
  console.log();

  // Exit code reflects failure count so CI / scripted callers can gate on it.
  process.exit(totalFailed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
}).finally(() => {
  setTimeout(() => process.exit(0), 1000).unref();
});
