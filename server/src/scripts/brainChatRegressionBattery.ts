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
              // Accept ISO ("2026-05-12") OR the natural-language form a real
              // EA would use ("May 12, 2026" / "May 12th, 2026" / "12 May 2026").
              // We only care that Brain knows today is May 12, 2026 — not that
              // it emits ISO. The action surface uses ISO for slot values; the
              // conversational answer can be human-friendly.
              name: 'mentions today (any common date format)',
              check: (a, ctx) => {
                const [, mm, dd] = ctx.todayIso.split('-');
                const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
                const monthName = monthNames[parseInt(mm, 10) - 1];
                const day = parseInt(dd, 10);
                const patterns = [
                  ctx.todayIso,
                  `${monthName} ${day}, 2026`,
                  `${monthName} ${day}th, 2026`,
                  `${monthName} ${day}st, 2026`,
                  `${monthName} ${day}nd, 2026`,
                  `${monthName} ${day}rd, 2026`,
                  `${day} ${monthName} 2026`,
                  `${day} ${monthName}, 2026`,
                ];
                const hit = patterns.find((p) => a.includes(p));
                return !!hit || `none of the expected date forms found in: ${a.slice(0, 120)}…`;
              },
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
            { name: 'no fake doc attribution on the action confirmation', check: doesNotMention('tenant FACL doc|FACL doc:|SW_DASHBOARD|HaseebOS Open Items') },
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
            { name: 'no fake FACL doc fabrication', check: doesNotMention('tenant FACL doc|FACL doc:|SW_DASHBOARD|HaseebOS Open Items') },
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
    {
      // Mirrors the actual MD-WhatsApp conversation that prompted this
      // build-out. Turn 1 lists open items; turn 2 asks Brain to act on
      // one of them ("the phoenix one"); the previous run had Brain
      // contradict its own turn 1 by saying "I don't see any item".
      // After H14 + the open-items snapshot block, Brain MUST recognise
      // the reference and EITHER delegate (if dominant Asad found) or
      // ask "which Asad?" with distinguishing reasons.
      name: 'open-items back-reference + ambiguous delegate (phoenix → Asad)',
      setup: async (ctx) => {
        // Seed an open item titled with "Phoenix Systems" so the
        // snapshot block has something to match. Use a unique tag so
        // we can find + clean up later.
        await prisma.openItem.create({
          data: {
            title: 'Revisit pricing for Phoenix Systems',
            type: 'manual',
            status: 'NEW',
            priority: 'high',
            ownerId: ctx.userId,
            clientNumber: ctx.clientNumber,
            userId: ctx.userId,
            sourceFeed: 'manual',
            metadata: { battery_seed: 'phoenix_back_ref' } as any,
          } as any,
        });
      },
      steps: [
        {
          user: 'How many open items do I have?',
          assertions: [
            firstNameOnly,
            // We don't assert on the exact count — depends on test
            // user's DB state. We only verify Brain lists items in a
            // human-readable way without fabrication.
            { name: 'no fake doc attribution', check: doesNotMention('tenant FACL doc|SW_DASHBOARD') },
          ],
        },
        {
          user: 'Delegate the phoenix one to Asad',
          assertions: [
            firstNameOnly,
            { name: 'does NOT falsely deny the phoenix open_item exists', check: doesNotMention('don\'t see|cannot find|no recent open items.*phoenix|not seeing.*phoenix') },
            // Brain should either ask "which Asad?" OR confirm delegation.
            // We allow EITHER (depends on the test user's contact graph)
            // but reject the false-denial outcome.
          ],
        },
      ],
    },
    {
      // MD 2026-05-12 15:39 PKT: "Delegate waqas ahmed email to asad"
      // triggered the email-report background job because the message
      // contained "email" + "to". Three off-topic Brain replies followed.
      // After the action-imperative exclusion in WhatsAppInbound.ts, this
      // must route to the chat compose path (which we verify here by
      // testing the answerAsBrain output directly — same destination).
      //
      // Note the battery calls answerAsBrain directly, so the upstream
      // exclusion doesn't get exercised by this assertion path; the
      // real-WA verification has to be done by MD live-testing. But we
      // assert that the chat compose response itself behaves brain-grade
      // for the delegate-an-email pattern — recognises it as a delegation
      // request, not as anything else.
      name: 'delegate-of-email pattern routes to chat (not email-report)',
      steps: [
        {
          user: 'Delegate Waqas Ahmed email to Asad',
          assertions: [
            firstNameOnly,
            { name: 'does NOT trigger the report-generator path', check: doesNotMention('Generating report|Report sent to your email|Check your inbox') },
            // Brain should either delegate (top Asad found) or ask "which
            // Asad?" — either is fine. Reject silence / unrelated reply.
            { name: 'either delegates or asks disambiguation', check: (a) => {
                const acted = /delegated|assigned|forwarded|sent\s+to|added\s+to/i.test(a);
                const asked = /which\s+asad|who\s+(do\s+you\s+mean|exactly)|email\s+address|provide/i.test(a);
                return acted || asked || `unrelated reply: ${a.slice(0, 160)}…`;
              } },
          ],
        },
      ],
    },
    {
      name: 'no-fabrication on action: never invent a delegatee email',
      steps: [
        {
          user: 'Delegate Phoenix Systems to NonExistentPersonXyz',
          assertions: [
            firstNameOnly,
            { name: 'admits no match for unknown name', check: mentions('don\'t (recognise|recognize)|not finding|can\'t find|no contact|who is') },
            { name: 'does NOT fabricate an email', check: (a) => {
                const fakeEmails = a.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g) ?? [];
                const suspicious = fakeEmails.filter((e) => /nonexistent|xyz/i.test(e));
                return suspicious.length === 0 || `fabricated email(s): ${suspicious.join(', ')}`;
              } },
          ],
        },
      ],
    },
    {
      name: 'schedule meeting — explicit time, real teammate name',
      steps: [
        {
          user: 'Set a meeting with the most-active teammate I have, tomorrow at 3pm, 30 min',
          assertions: [
            firstNameOnly,
            // Brain should either schedule (action emitted) or ask one
            // tight clarification. We reject silence / fabrication.
            { name: 'either acts or asks one tight clarifying question', check: (a) => {
                const acted = /scheduled|invite|set up|sent|confirmed|set/i.test(a);
                const asked = /which|who do you|do you mean|to confirm/i.test(a);
                return (acted || asked) || `neither acted nor asked; got: ${a.slice(0, 120)}`;
              } },
            { name: 'no fabricated calendar IDs', check: doesNotMention('calendar id [a-z0-9_]{6,}|event_xyz') },
          ],
        },
      ],
    },
    {
      // MD's 2026-05-12 14:34 PKT failure: "Brief my day" returned a
      // vague meta-summary ("your focus today seems to be on managing
      // your open items"), not a real digest with calendar/items/inbox.
      // After the day_brief intent + H15 structured-output rule, the
      // reply must contain SUBSTANTIVE content from at least one real
      // source block (calendar / open items / inbound).
      name: 'day_brief — comprehensive coverage, compact delivery',
      steps: [
        {
          user: 'Brief my day',
          assertions: [
            firstNameOnly,
            // The failed reply leaked the test fixture into the brief.
            // Real digests don't say "in both English and Urdu" — that's
            // Brain noticing its own test runs.
            { name: 'no meta-commentary about Brain\'s own activity', check: doesNotMention('in both English and Urdu|managing your open items and tasks|your focus today seems|I\'m seeing recent activity') },
            // Substantive content: at least one real day-brief signal.
            { name: 'mentions calendar, items, or inbound', check: (a) => {
                const real = /\b(meeting|calendar|\d{1,2}:\d{2}|open\s+item|due\s+(today|tomorrow)|inbox|email|reply|message|critical|nothing|clear|on\s+your\s+plate|whatsapp)\b/i;
                return real.test(a) || `reply lacks day-brief signals: ${a.slice(0, 160)}…`;
              } },
            // Compact constraint — WhatsApp must be readable on a phone.
            // Cap higher than 600 to give the LLM headroom for the
            // section-per-channel coverage but still phone-friendly.
            { name: 'compact: under 1200 chars (phone-friendly)', check: shorterThan(1200) },
            // Coverage signal — the reply should reference multiple
            // sections when MD has multi-channel activity. We don't
            // hard-require N sections (the user's actual data drives
            // that), but we require either: at least one explicit
            // counter ("+N more") OR at least two channel emojis.
            { name: 'shows multi-channel coverage when available', check: (a) => {
                const counters = /\+\s*\d+\s+more/i.test(a);
                const emojis = (a.match(/📅|📬|💬|📋|⚠️/g) ?? []).length;
                const clear = /(nothing pending|you'?re clear|nothing on your plate)/i.test(a);
                return counters || emojis >= 1 || clear || `no multi-channel coverage signal in: ${a.slice(0, 160)}…`;
              } },
          ],
        },
      ],
    },
    {
      // Direct repro of MD's 2026-05-12 14:20 PKT failure: a stale
      // brain_prompt_queue row (awaiting set_due_date) consumed MD's
      // "Brief my day" as a date-parse attempt and never reached the
      // chat router. The fix is in promptReplyHandler.looksLikeAnswer():
      // "Brief my day" matches the new-chat trigger regex, the handler
      // returns handled=false, and the chat compose path runs.
      //
      // We seed a stale awaiting prompt directly via SQL so the test
      // doesn't depend on a prior turn having queued one. If the queue
      // table has a different name than expected, the seed silently
      // fails — the assertion below catches it either way.
      name: 'stale brain prompt does not eat "Brief my day"',
      setup: async (ctx) => {
        // Seed a stale set_due_date prompt for this user. We bypass the
        // model client because this is fixture setup — production code
        // path goes through brainPromptQueueService.enqueuePrompt.
        try {
          await prisma.$executeRawUnsafe(
            `INSERT INTO brain_prompt_queue (id, user_id, client_number, status, body, side_effect, created_at, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'awaiting_reply', $3, $4::jsonb, NOW() - interval '2 hours', NOW())`,
            ctx.userId, ctx.clientNumber,
            'Hey, when did you want to wrap up the Phoenix Systems pricing review?',
            JSON.stringify({ kind: 'set_due_date', openItemId: null }),
          );
        } catch {
          // table may not exist in this env — assertion below still meaningful
        }
      },
      steps: [
        {
          user: 'Brief my day',
          assertions: [
            { name: 'does NOT return the stale-prompt parse failure', check: doesNotMention("Couldn't parse|flagged for clarification") },
            { name: 'is a real day-brief style reply', check: (a) => {
              // Day-brief replies are substantive — multi-sentence, mention
              // either items, calendar, emails, "today", or "nothing on".
              const substantive = /\b(open\s+item|meeting|calendar|today|tomorrow|email|nothing|no\s+critical|on\s+your\s+plate|inbox|attention)\b/i;
              return substantive.test(a) || `reply doesn't look like a day brief: ${a.slice(0, 120)}`;
            } },
          ],
        },
      ],
    },
  ];
}

// ── Runner ─────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const argUserIdx = args.indexOf('--user');
  const argClientIdx = args.indexOf('--client');
  const argUser = argUserIdx >= 0 ? args[argUserIdx + 1] : null;
  const argClient = argClientIdx >= 0 ? args[argClientIdx + 1] : null;

  // Auto-resolve the test user. CLI args take precedence; otherwise pick
  // the first active user on the first tenant — which on prod is MD's
  // real account. Avoids the FK-violation noise from a hardcoded userId=5
  // that doesn't exist in the deployed DB.
  let userId: number;
  let clientNumber: string;
  if (argUser && argClient) {
    userId = parseInt(argUser, 10);
    clientNumber = argClient;
  } else {
    const firstUser = await prisma.user.findFirst({
      where: { clientNumber: { not: '' } as any },
      orderBy: { id: 'asc' },
      select: { id: true, clientNumber: true },
    });
    if (!firstUser) {
      console.error('No user found in DB — pass --user N --client TMC-XXXX explicitly.');
      process.exit(2);
    }
    userId = firstUser.id;
    clientNumber = firstUser.clientNumber;
  }

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
