/**
 * Calibration harness for the Living Assistant Standard judge.
 *
 * Why this exists: the judge shipped on 2026-08-07 scored its first five live
 * turns 98, 98, 98, 98, 99 — while its own improvement notes named real misses,
 * including *"Brain should have acknowledged the other outstanding questions it
 * had asked the user"*, which is a C3 continuity failure awarded 98.
 *
 * A judge that scores everything 98 never crosses the 70 band, never opens a
 * finding, and never triggers the learning loop. It is decoration. Worse, it is
 * decoration that looks like monitoring — the precise failure mode of the seven
 * health jobs that stayed green through thirty-five real defects.
 *
 * So the judge gets graded too, against turns whose correct verdict is already
 * known. Every case below is a REAL exchange from production on 2026-08-06/07,
 * with the DEF it was filed as. No invented examples: a synthetic "obviously
 * bad" turn is easy to catch and proves nothing about the turns that actually
 * reached the owner.
 *
 * Usage (from server/):
 *   node -r dotenv/config dist/scripts/calibrateResponseJudge.js
 *
 * Exit 0 when the judge separates good from bad; exit 1 when it does not, with
 * the failing cases printed. This is a gate, not a report.
 */

import { evaluateBrainResponse, BAND_WEAK, type CriterionKey } from '../services/knowledge/brainResponseEvaluator';

interface Case {
  name: string;
  def: string;
  userMessage: string;
  brainResponse: string;
  context?: { openQuestions?: string[]; previousTurns?: Array<{ role: 'user' | 'brain'; text: string }> };
  /** What the judge must conclude. */
  expect:
    | { verdict: 'bad'; criterion: CriterionKey; maxScore: number }
    | { verdict: 'good'; minScore: number };
}

const CASES: Case[] = [
  {
    name: 'answer to Brain\'s own question turned into a task',
    def: 'DEF-093',
    userMessage: 'High immediate',
    brainResponse: 'Added "High immediate" to your open items — parked as DRAFT (missing priority + dueDate, I\'ll ask you on WhatsApp).',
    context: { openQuestions: ['Basit, quick one — what a priority and a deadline should I put on this? "Define rules for Brain\'s responsiveness to new vs. existing contacts"'] },
    expect: { verdict: 'bad', criterion: 'C3', maxScore: 50 },
  },
  {
    name: 'human deadline rejected as unparseable',
    def: 'DEF-094',
    userMessage: 'Item related to watcher',
    brainResponse: '[update_open_item: couldn\'t parse dueDate "immediate" — try a specific date]',
    expect: { verdict: 'bad', criterion: 'C4', maxScore: 50 },
  },
  {
    name: 'raw machine marker sent to a human',
    def: 'DEF-092',
    userMessage: 'High immediate',
    brainResponse: '[completion recorded and item closed]',
    expect: { verdict: 'bad', criterion: 'C4', maxScore: 40 },
  },
  {
    name: 'pronoun from the previous turn not resolved',
    def: 'DEF-092/C3',
    userMessage: 'what are the open items at her',
    brainResponse: 'Sir, I\'m not sure I understand \'at her\'. Could you clarify which open items you\'re asking about?',
    context: {
      previousTurns: [
        { role: 'user', text: 'check if Hamna has responded' },
        { role: 'brain', text: 'The last emails from Hamna were on August 4th regarding the "Quantitative Objectives List".' },
      ],
    },
    expect: { verdict: 'bad', criterion: 'C3', maxScore: 65 },
  },
  {
    name: 'a genuinely good turn — the judge must not condemn everything either',
    def: '—',
    userMessage: 'Do you have Noman Mazhar\'s contact number?',
    brainResponse: 'I\'ve checked your contacts and I don\'t have a record for Noman Mazhar or his number.',
    expect: { verdict: 'good', minScore: 80 },
  },
];

async function main(): Promise<number> {
  const failures: string[] = [];
  const scores: number[] = [];

  for (const c of CASES) {
    // clientNumber/userId are required for spend attribution; calibration runs
    // against the real tenant so it exercises the same config path as live.
    const ev = await evaluateBrainResponse({
      clientNumber: process.env.NEXEO_CALIBRATE_CLIENT || 'TMC-0001',
      userId: Number(process.env.NEXEO_CALIBRATE_USER || 2),
      userMessage: c.userMessage,
      brainResponse: c.brainResponse,
      surface: 'calibration',
      context: c.context,
    });

    if (!ev) {
      failures.push(`${c.name} [${c.def}]: judge returned nothing`);
      continue;
    }
    scores.push(ev.overallScore);

    if (c.expect.verdict === 'bad') {
      const got = ev.criteria[c.expect.criterion]?.score ?? 100;
      const ok = got <= c.expect.maxScore;
      process.stdout.write(
        `${ok ? 'PASS' : 'FAIL'}  ${c.def.padEnd(12)} ${c.expect.criterion}=${String(got).padStart(3)} ` +
        `(needs <=${c.expect.maxScore}) overall=${ev.overallScore}  ${c.name}\n` +
        `      reason: ${ev.criteria[c.expect.criterion]?.reason ?? '-'}\n`,
      );
      if (!ok) failures.push(`${c.name} [${c.def}]: ${c.expect.criterion}=${got}, needed <=${c.expect.maxScore}`);
    } else {
      const ok = ev.overallScore >= c.expect.minScore;
      process.stdout.write(
        `${ok ? 'PASS' : 'FAIL'}  ${c.def.padEnd(12)} overall=${String(ev.overallScore).padStart(3)} ` +
        `(needs >=${c.expect.minScore})  ${c.name}\n`,
      );
      if (!ok) failures.push(`${c.name}: overall=${ev.overallScore}, needed >=${c.expect.minScore}`);
    }
  }

  // Spread matters as much as the individual verdicts. A judge whose scores all
  // sit inside a few points is not discriminating, even if each happens to land
  // on the right side of a threshold.
  const spread = scores.length ? Math.max(...scores) - Math.min(...scores) : 0;
  process.stdout.write(`\nspread=${spread} (min=${Math.min(...scores)} max=${Math.max(...scores)})\n`);
  if (spread < 25) {
    failures.push(`scores span only ${spread} points — the judge is not discriminating between good and bad turns`);
  }

  if (failures.length) {
    process.stdout.write(`\nCALIBRATION FAILED (${failures.length}):\n${failures.map((f) => `  - ${f}`).join('\n')}\n`);
    return 1;
  }
  process.stdout.write('\nCALIBRATION PASSED — the judge separates known-good from known-bad.\n');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`calibration harness failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
