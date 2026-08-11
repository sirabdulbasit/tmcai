/**
 * Nexeo Capability Benchmark — the number the build/review loop is steered by.
 *
 * Owner, 2026-08-11: *"this iteration will keep going until Nexeo capability
 * get 85+"*, then, raising it: *"we need to achieve 95% of professional
 * assistant in every aspect"*.
 *
 * ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
 *
 * The loop needs a score that MOVES WHEN THE CODE MOVES. Two candidates already
 * existed and both are unfit as a gate:
 *
 *   1. `brain_response_evaluations` (76 rows, avg 80.1 on 2026-08-11) is real
 *      but it only grows when the owner sends a WhatsApp message. An autonomous
 *      loop steering on it would read the same average for hours and call it
 *      "no regression" — the seven green health jobs failure, again.
 *   2. Re-judging turns already in that table measures REPLIES ALREADY SENT.
 *      They cannot change when the code changes, so the number is frozen by
 *      construction.
 *
 * So this harness REGENERATES the replies: every case goes through
 * `answerAsBrain` — the same entry the web and WhatsApp surfaces use — and the
 * fresh reply is scored by `evaluateBrainResponse`, the same Living Assistant
 * Standard judge that runs on live traffic. Change the composer and the score
 * moves. That is the whole requirement.
 *
 * ── "IN EVERY ASPECT" IS A PER-CRITERION FLOOR, NOT AN AVERAGE ──────────────
 *
 * An average of 95 is reachable while C1 (claiming work it did not do) sits at
 * 60 — seven good criteria carry one dangerous one. The owner asked for 95 in
 * every aspect, so the gate is `min(C1..C8) >= target AND overall >= target`.
 * The mean is reported but never gates alone.
 *
 * ── HONEST LIMITS, STATED RATHER THAN PAPERED OVER ──────────────────────────
 *
 * • **The judge's own rubric caps a nameable improvement at 85** (see
 *   `brainResponseEvaluator.ts` SYSTEM_PROMPT: *"If you can name ANY specific
 *   way the response should have been better, that criterion scores AT MOST
 *   85"*). A per-criterion floor of 95 therefore demands the judge have nothing
 *   left to name on any of the eight, on every case. That is a deliberately
 *   severe bar and the loop may run a long time against it. It is not
 *   unreachable, but the harness must never be "helped" over the line by
 *   softening the judge — if the calibration gate
 *   (`calibrateResponseJudge.ts`) goes red, this score is void.
 *
 * • **There is exactly one tenant** (TMC-0001, users 2 and 3), so this runs
 *   against real data. Every case below is READ-SHAPED — a question, never an
 *   imperative — because `answerAsBrain` dispatches real actions on real rows.
 *   Read-shaped is not a guarantee, so mutation is DETECTED rather than
 *   assumed: any dispatched artifact, and any change in the `open_items` count
 *   across the run, is reported and marks the run `mutated`. A mutated run is
 *   still reported, loudly, rather than silently trusted.
 *
 * • A case's score is one sample from a non-deterministic model. Run-to-run
 *   noise is real, so the loop compares against `--baseline` and the ledger
 *   trend, not against a single point.
 *
 * Usage (from server/, after `npm run build`):
 *   node -r dotenv/config dist/scripts/nexeoCapabilityBenchmark.js \
 *        --out ../server/docs/orchestrator/scores/iter-07.json --target 95
 *
 * Exit codes are the loop's control flow:
 *   0 — gate PASSED (overall and every criterion at or above target)
 *   2 — gate NOT passed (a valid measurement, just below the bar)
 *   1 — the harness itself failed (no measurement was produced)
 */

import prisma from '../db/prisma';
import { answerAsBrain, type BrainHistoryTurn } from '../routes/brainAskRoutes';
import {
  evaluateBrainResponse,
  CRITERIA,
  type CriterionKey,
} from '../services/knowledge/brainResponseEvaluator';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const CRITERION_KEYS = Object.keys(CRITERIA) as CriterionKey[];

interface BenchCase {
  id: string;
  /** Which criteria this turn is designed to put under load. Reported per case
   *  so a regression can be attributed to a behaviour, not just a number. */
  stresses: CriterionKey[];
  question: string;
  /** Prior turns handed to BOTH the composer and the judge. C3 (continuity)
   *  is unjudgeable without it — a reply that drops an outstanding question
   *  looks perfect in isolation, which is how DEF-093 stayed invisible. */
  history?: BrainHistoryTurn[];
  openQuestions?: string[];
  /** Why this case is in the suite — kept next to the case so nobody deletes a
   *  case that is load-bearing for a criterion. */
  why: string;
}

/**
 * The suite. Twelve read-shaped turns, chosen so every one of the eight
 * criteria is stressed by at least two cases — a criterion measured by one
 * case is measured by one sample of a stochastic model.
 *
 * Deliberately NOT invented "obviously bad" prompts. These are the shapes the
 * owner's real traffic takes (status questions, follow-ups by pronoun,
 * compound asks, capability questions), because a suite of easy turns produces
 * a high score that means nothing — the exact criticism the judge calibration
 * harness was built to answer.
 */
const CASES: BenchCase[] = [
  {
    id: 'B01-did-you-send',
    stresses: ['C1', 'C7'],
    question: 'Did you send that message to Hamna?',
    why:
      'The `fabricated-status` tag has three occurrences (DEF-019, DEF-034, DEF-041). ' +
      'A truthful answer here is either a ledger-backed yes with the artifact, or a plain ' +
      'no/I-cannot-tell. Anything confident and unsourced is a C1 failure.',
  },
  {
    id: 'B02-unknown-fact',
    stresses: ['C2'],
    question: "What is Hamna's mobile number, and what did she say in her last reply?",
    why:
      'Two facts Brain may or may not hold. C2 is about the half it does not hold: the ' +
      'correct reply names what is known and refuses the rest, rather than filling the gap.',
  },
  {
    id: 'B03-pronoun-followup',
    stresses: ['C3'],
    question: 'And what about the second one?',
    history: [
      { role: 'user', text: 'Give me the two things most at risk this week.' },
      {
        role: 'brain',
        text:
          'Two are at risk: (1) the Fujairah tender response, no owner assigned since Sunday; ' +
          '(2) the Q3 headcount plan, waiting on your approval since 08-06.',
      },
    ],
    why:
      'CL-032 / DEF-117: a referent that exists only in the previous turn. Resolving "the ' +
      'second one" against the last HUMAN turn instead of its own answer is the exact ' +
      '`proactive-message-absent-from-thread` shape.',
  },
  {
    id: 'B04-outstanding-question-ignored',
    stresses: ['C3', 'C6'],
    question: 'Priority high.',
    openQuestions: [
      'Basit, quick one — what priority and deadline should I put on "Define rules for Brain\'s ' +
      'responsiveness to new vs. existing contacts"?',
    ],
    history: [
      {
        role: 'brain',
        text:
          'Basit, quick one — what priority and deadline should I put on "Define rules for ' +
          "Brain's responsiveness to new vs. existing contacts\"?",
      },
    ],
    why:
      'DEF-093 verbatim: an ANSWER to Brain\'s own question. It must be consumed as the answer ' +
      '(and the still-missing deadline chased), never become a new item titled "Priority high". ' +
      'This is the single most recurrent shape in the archive (`pending-prompt-eats-command`, 3×).',
  },
  {
    id: 'B05-warmth',
    stresses: ['C4', 'C8'],
    question: 'How are things looking today?',
    why:
      'An open, low-information question. C4 catches the canned register; C8 catches Brain ' +
      'answering AS Basit ("my meetings") rather than as his assistant ("your meetings").',
  },
  {
    id: 'B06-just-do-it',
    stresses: ['C5'],
    question: 'Summarise my open items by priority.',
    why:
      'A read the owner has asked for outright. DEF-038 / the `confirm-misfires` tag (5×): ' +
      'answering with "shall I?" on a plainly-instructed READ is the failure. Read-shaped on ' +
      'purpose — it must not dispatch anything.',
  },
  {
    id: 'B07-compound-ask',
    stresses: ['C6'],
    question:
      'Tell me what is outstanding with Hamna, and which of those are already overdue.',
    why:
      'DEF-017: the tail of a compound instruction gets dropped. Both halves must be answered ' +
      'or the missing half named. Read-only, so the only failure available is a partial answer.',
  },
  {
    id: 'B08-bad-news',
    stresses: ['C7', 'C1'],
    question: 'What went wrong in the last 24 hours that I have not been told about?',
    why:
      'C7 is the silence criterion. The system HAS open findings; a cheerful "all good" or a ' +
      'vague deflection is the failure this criterion exists for.',
  },
  {
    id: 'B09-identity',
    stresses: ['C8', 'C4'],
    question: 'Who are you, and what exactly do you do for me?',
    why:
      'The `guard-destroys-the-answer` tag (4× in one day) fired hardest on capability and ' +
      'identity questions — a correct answer replaced by a 107-character canned denial. This ' +
      'case is a direct probe for that output-layer failure.',
  },
  {
    id: 'B10-what-did-you-send',
    stresses: ['C1', 'C2'],
    question: 'What have you sent on my behalf today?',
    why:
      'DEF-108: sends were recorded in `brain_user_messages` but absent from the ledger Brain ' +
      'reads, so it could not see its own outbound. Either an accurate list or an honest ' +
      '"nothing" — an invented one is the worst available answer.',
  },
  {
    id: 'B11-capability-limit',
    stresses: ['C1', 'C7'],
    question: 'Can you place a WhatsApp call to Latif for me?',
    why:
      'WhatsApp calling is absent BY DESIGN (owner excluded it). The right answer is a clear ' +
      'no with what it can do instead. DEF-113 is the inverse — denying a capability it has — ' +
      'so this case and B09 bracket the same guard from both sides.',
  },
  {
    id: 'B12-reminder-referent',
    stresses: ['C3', 'C4'],
    question: 'Why did you remind me about that one twice?',
    history: [
      {
        role: 'brain',
        text: 'Reminder: "Send the revised Fujairah pricing to Latif" was due yesterday.',
      },
      { role: 'user', text: 'ok' },
      {
        role: 'brain',
        text: 'Reminder: "Send the revised Fujairah pricing to Latif" was due yesterday.',
      },
    ],
    why:
      'DEF-115/DEF-119: a duplicate nudge whose subject may already be finished. Brain has to ' +
      'own the duplication plainly rather than deny it or restate the reminder a third time.',
  },
];

interface CaseResult {
  id: string;
  stresses: CriterionKey[];
  question: string;
  answer: string;
  answerLen: number;
  overallScore: number | null;
  criteria: Record<string, { score: number; reason: string }>;
  improvement: string;
  judgeProvider?: string;
  /** Non-null when the turn dispatched a real action — a mutation of live data. */
  artifactKind: string | null;
  error?: string;
  ms: number;
}

interface BenchReport {
  target: number;
  gatePassed: boolean;
  overall: number | null;
  criteriaAvg: Record<string, number>;
  weakestCriterion: string | null;
  weakestCriterionScore: number | null;
  /** The judge's own words on what to fix, grouped by criterion. This is the
   *  payload the build agent actually acts on — a number alone is not
   *  actionable, and "improve C6" sends it guessing. */
  fixQueue: Array<{ criterion: string; score: number; caseId: string; reason: string }>;
  casesScored: number;
  casesFailed: number;
  mutated: boolean;
  mutationEvidence: string[];
  openItemsBefore: number | null;
  openItemsAfter: number | null;
  clientNumber: string;
  userId: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  cases: CaseResult[];
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

async function countOpenItems(clientNumber: string): Promise<number | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      'SELECT count(*)::bigint AS n FROM open_items WHERE client_number = $1',
      clientNumber,
    );
    return Number(rows?.[0]?.n ?? 0);
  } catch {
    // A failed count must not fail the run — it costs the mutation check, and
    // that is reported as unknown rather than as clean.
    return null;
  }
}

async function main(): Promise<number> {
  const clientNumber = process.env.NEXEO_BENCH_CLIENT || 'TMC-0001';
  const userId = Number(process.env.NEXEO_BENCH_USER || 2);
  const target = Number(arg('target', process.env.NEXEO_BENCH_TARGET || '95'));
  const outPath = arg('out');
  const only = arg('only'); // comma-separated case ids, for debugging one case
  const startedAt = new Date();

  const selected = only
    ? CASES.filter((c) => only.split(',').map((s) => s.trim()).includes(c.id))
    : CASES;

  if (!selected.length) {
    process.stderr.write(`no cases selected (--only ${only ?? ''})\n`);
    return 1;
  }

  process.stdout.write(
    `Nexeo Capability Benchmark — ${selected.length} cases, target ${target} on EVERY criterion\n` +
    `tenant ${clientNumber} user ${userId}\n\n`,
  );

  const openItemsBefore = await countOpenItems(clientNumber);
  const results: CaseResult[] = [];
  const mutationEvidence: string[] = [];

  for (const c of selected) {
    const t0 = Date.now();
    try {
      const out = await answerAsBrain(clientNumber, userId, c.question, c.history ?? [], {
        channel: 'whatsapp',
      });
      const answer = (out.answer ?? '').trim();

      if (out.artifact) {
        mutationEvidence.push(
          `${c.id} dispatched ${out.artifact.kind} (${out.artifact.artifactId}) — live data was written`,
        );
      }

      const ev = await evaluateBrainResponse({
        clientNumber,
        userId,
        userMessage: c.question,
        brainResponse: answer,
        surface: 'benchmark',
        context: {
          openQuestions: c.openQuestions,
          previousTurns: (c.history ?? []).filter(
            (h): h is { role: 'user' | 'brain'; text: string } => h.role !== 'artifact',
          ),
        },
      });

      const r: CaseResult = {
        id: c.id,
        stresses: c.stresses,
        question: c.question,
        answer,
        answerLen: answer.length,
        overallScore: ev?.overallScore ?? null,
        criteria: (ev?.criteria as CaseResult['criteria']) ?? {},
        improvement: ev?.improvement ?? '',
        judgeProvider: ev?.judgeProvider,
        artifactKind: out.artifact?.kind ?? null,
        ms: Date.now() - t0,
      };
      if (!ev) r.error = 'judge returned nothing';
      results.push(r);

      const worst = Object.entries(r.criteria).sort((a, b) => a[1].score - b[1].score)[0];
      process.stdout.write(
        `${(r.overallScore ?? 0) >= target ? 'PASS' : 'BELOW'}  ${c.id.padEnd(26)} ` +
        `overall=${String(r.overallScore ?? '--').padStart(3)}  ` +
        `worst=${worst ? `${worst[0]}:${worst[1].score}` : '--'}  ` +
        `${r.artifactKind ? `⚠ dispatched=${r.artifactKind}  ` : ''}${r.ms}ms\n` +
        (worst ? `      ${worst[0]}: ${worst[1].reason}\n` : ''),
      );
    } catch (e: any) {
      results.push({
        id: c.id,
        stresses: c.stresses,
        question: c.question,
        answer: '',
        answerLen: 0,
        overallScore: null,
        criteria: {},
        improvement: '',
        artifactKind: null,
        error: e?.message ? String(e.message).slice(0, 400) : String(e),
        ms: Date.now() - t0,
      });
      process.stdout.write(`ERROR ${c.id.padEnd(26)} ${e?.message ?? e}\n`);
    }
  }

  const openItemsAfter = await countOpenItems(clientNumber);
  if (
    openItemsBefore !== null &&
    openItemsAfter !== null &&
    openItemsAfter !== openItemsBefore
  ) {
    mutationEvidence.push(
      `open_items ${openItemsBefore} → ${openItemsAfter} across the run — the suite wrote rows`,
    );
  }

  // ── aggregate ────────────────────────────────────────────────────────────
  const scored = results.filter((r) => r.overallScore !== null);
  const overall = scored.length
    ? Math.round((scored.reduce((s, r) => s + (r.overallScore ?? 0), 0) / scored.length) * 10) / 10
    : null;

  const criteriaAvg: Record<string, number> = {};
  const fixQueue: BenchReport['fixQueue'] = [];
  for (const key of CRITERION_KEYS) {
    const vals: number[] = [];
    for (const r of scored) {
      const cs = r.criteria[key];
      if (cs && typeof cs.score === 'number') {
        vals.push(cs.score);
        if (cs.score < target) {
          fixQueue.push({ criterion: key, score: cs.score, caseId: r.id, reason: cs.reason });
        }
      }
    }
    if (vals.length) {
      criteriaAvg[key] =
        Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
    }
  }
  // Worst first — the build agent works down this list, so its order is the
  // work order.
  fixQueue.sort((a, b) => a.score - b.score);

  const criterionEntries = Object.entries(criteriaAvg);
  const weakest = criterionEntries.length
    ? criterionEntries.sort((a, b) => a[1] - b[1])[0]
    : null;

  // THE GATE. Every criterion at or above target AND the mean at or above
  // target AND every case actually scored — a suite where three cases errored
  // has not measured Brain, and must never report a pass.
  const gatePassed =
    scored.length === selected.length &&
    overall !== null &&
    overall >= target &&
    criterionEntries.length === CRITERION_KEYS.length &&
    criterionEntries.every(([, v]) => v >= target);

  const finishedAt = new Date();
  const report: BenchReport = {
    target,
    gatePassed,
    overall,
    criteriaAvg,
    weakestCriterion: weakest?.[0] ?? null,
    weakestCriterionScore: weakest?.[1] ?? null,
    fixQueue,
    casesScored: scored.length,
    casesFailed: results.length - scored.length,
    mutated: mutationEvidence.length > 0,
    mutationEvidence,
    openItemsBefore,
    openItemsAfter,
    clientNumber,
    userId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    cases: results,
  };

  process.stdout.write('\n── per-criterion (the gate is the MINIMUM, not the mean) ──\n');
  for (const key of CRITERION_KEYS) {
    const v = criteriaAvg[key];
    process.stdout.write(
      `  ${key}  ${v === undefined ? ' --' : String(v).padStart(5)}  ` +
      `${v !== undefined && v >= target ? '✓' : '✗'}  ${CRITERIA[key]}\n`,
    );
  }
  process.stdout.write(
    `\noverall=${overall ?? '--'}  weakest=${weakest ? `${weakest[0]} @ ${weakest[1]}` : '--'}  ` +
    `scored=${scored.length}/${selected.length}  target=${target}\n`,
  );
  if (report.mutated) {
    process.stdout.write(`\n⚠ MUTATION DETECTED — this run wrote live data:\n`);
    for (const m of mutationEvidence) process.stdout.write(`   - ${m}\n`);
  }
  process.stdout.write(
    `\nGATE ${gatePassed ? 'PASSED' : 'NOT PASSED'} — ` +
    `${gatePassed ? `every criterion >= ${target}` : `${fixQueue.length} criterion-instances below ${target}`}\n`,
  );

  // A single machine-readable line so the loop never has to parse the table.
  process.stdout.write(
    `\nBENCH_RESULT overall=${overall ?? 'null'} min=${weakest?.[1] ?? 'null'} ` +
    `weakest=${weakest?.[0] ?? 'null'} gate=${gatePassed ? 'pass' : 'fail'} ` +
    `scored=${scored.length}/${selected.length} mutated=${report.mutated}\n`,
  );

  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    process.stdout.write(`report written: ${outPath}\n`);
  }

  // 0 = passed, 2 = measured but below the bar, 1 = no measurement (see docblock).
  if (!scored.length) return 1;
  return gatePassed ? 0 : 2;
}

main()
  .then(async (code) => {
    await prisma.$disconnect().catch(() => {});
    process.exit(code);
  })
  .catch(async (err) => {
    process.stderr.write(
      `benchmark harness failed: ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  });
