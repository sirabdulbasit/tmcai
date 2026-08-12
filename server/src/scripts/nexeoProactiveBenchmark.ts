/**
 * Nexeo PROACTIVE slice — the other half of what the owner reads.
 *
 * Campaign C-1 / operator directive D-5, deferred four times and ranked first by
 * Codex at iteration 11: *"Execute D-5 now — fifth deferral is no longer
 * justified."*
 *
 * ── WHY A SECOND HARNESS AND NOT MORE CASES IN THE FIRST ────────────────────
 *
 * `nexeoCapabilityBenchmark.ts` drives `answerAsBrain`: twelve REPLIES to twelve
 * questions. CL-033 counted **14 of 19** owner-facing messages in a six-hour
 * window that were not replies at all — they were proactive notifications, and
 * CL-034/R-1 is eight turns of the owner arguing with them. Eleven iterations
 * have therefore been tuning the smaller half of his experience.
 *
 * This file is separate, and deliberately so:
 *
 *   • **The twelve cases, `brainResponseEvaluator.ts` and the gate arithmetic
 *     are untouched.** Adding proactive cases into the existing average would
 *     move the headline number without improving Brain — the one failure this
 *     loop cannot detect from the inside. Scores here are reported on their own.
 *   • It uses **the same judge** (`evaluateBrainResponse`). A second rubric
 *     would be `protection-with-two-implementations`, which this codebase has
 *     recorded nine times.
 *
 * ── D-1: THIS SLICE CANNOT WRITE THE OWNER'S BACKLOG ────────────────────────
 *
 * D-1 exists because the compose benchmark dispatches real actions and left junk
 * rows in `open_items` (`cmsotakwf0006rts1bdsrjjkj`, twice). It also warned
 * against fixing that with a non-dispatching "benchmark mode", because a second
 * path measures something other than production.
 *
 * The proactive surface avoids the dilemma rather than solving it. Its producers
 * are **pure text renderers** — `phraseDraftAsk`, `phraseOwnerChase`,
 * `renderLifecycleIntervention`, `renderUnattachedReply` — and this harness calls
 * exactly the functions production calls, with no job, no queue and no
 * `brainContactsUser`. There is no write to undo and no second implementation:
 * the words scored here are the words that ship. **No teardown is required
 * because nothing is created**, which is a stronger guarantee than a teardown
 * that ran. `proactiveBenchmarkIsolation.test.ts` asserts the harness imports no
 * dispatch or persistence surface.
 *
 * ── WHAT THIS MEASURES, STATED NARROWLY ─────────────────────────────────────
 *
 * The WORDS. Whether a proactive message reads like a person, says what it
 * knows, and asks something answerable.
 *
 * **Not** whether the message should have been sent, when, or batched. DEF-139 —
 * ten pushes from one unknown sender in 3h20m — is a decision defect.
 *
 * CORRECTION, from the first run rather than from reasoning: I wrote that no
 * judgement of a sentence could catch DEF-139, and case `P05` disproved it on the
 * first attempt. Handed the owner's real window as one body, the judge scored
 * C4 = 70 and said *"the repetition … feels highly templated and unnatural. A
 * human would likely summarize or state this once … not repeat it verbatim six
 * times."* So the slice DOES see repetition inside a window it is shown. What it
 * still cannot see is the **timing and the decision** — that six arrived over 35
 * minutes rather than as one digest, and that a seventh was suppressed or was
 * not. Narrower claim, and the honest one.
 *
 * ── THE JUDGE IS BEING USED SLIGHTLY OFF-LABEL, ON PURPOSE ──────────────────
 *
 * `evaluateBrainResponse` scores a REPLY, so it wants a `userMessage`. A
 * proactive message answers nothing. Each case therefore supplies the SITUATION
 * in the owner's terms as `userMessage` — what he would have been entitled to
 * expect at that moment — and the rendered notification as `brainResponse`.
 * That is a real limitation and it is why these numbers are reported separately
 * rather than folded in: they are comparable to each other over time, not to the
 * compose twelve.
 *
 * Usage (from server/, after `npm run build`):
 *   node -r dotenv/config dist/scripts/nexeoProactiveBenchmark.js \
 *        --out ../server/docs/orchestrator/scores/proactive-iter-12.json --target 95
 *
 * Exit codes match the compose harness so the loop can treat them alike:
 *   0 — every criterion at or above target
 *   2 — a valid measurement below the bar
 *   1 — the harness itself failed and produced no measurement
 */

import { evaluateBrainResponse } from '../services/knowledge/brainResponseEvaluator';
import { phraseDraftAsk, phraseOwnerChase } from '../services/notifications/brainHumanComm';
import {
  renderLifecycleIntervention,
  renderUnattachedReply,
} from '../services/notifications/proactiveMessageText';

const CLIENT_NUMBER = 'TMC-0001';
const USER_ID = 2;

/** The owner's configured form of address, as the real producers receive it from
 *  `addressUser` -> `persona.addressAs` (DEF-140). Passed in rather than read,
 *  so this harness performs no database access at all. */
const ADDRESS_AS = 'Sir';

interface ProactiveCase {
  id: string;
  /** Which recorded defect or chat log this shape came from. */
  provenance: string;
  /** The situation, in the owner's terms — what he was entitled to expect. */
  situation: string;
  /** What Brain had outstanding, for C3. */
  openQuestions?: string[];
  previousTurns?: Array<{ role: 'user' | 'brain'; text: string }>;
  /** Calls the REAL producer. No case may inline its own text. */
  render: () => string;
}

const CASES: ProactiveCase[] = [
  {
    id: 'P01-draft-ask',
    provenance: 'CL-033 / DEF-140 — the message that said "Basit," to an owner configured as "Sir"',
    situation:
      'I have an open item with no priority and no deadline. Ask me for what you need, '
      + 'in a way I can answer in one line.',
    render: () => phraseDraftAsk({
      userFirstName: ADDRESS_AS,
      itemTitle: "Define rules for Brain's responsiveness to new vs. existing contacts",
      missingSlots: ['priority', 'dueDate'],
      dayIndex: 0,
      itemId: 'proactive-p01',
    }),
  },
  {
    id: 'P02-owner-chase',
    provenance: 'CL-034 / DEF-151 — "chase her" answered with four requests to disambiguate',
    situation:
      'Hamna has not moved on something I delegated for three days. Tell me, and make it '
      + 'easy for me to act without repeating myself.',
    render: () => phraseOwnerChase({
      userFirstName: ADDRESS_AS,
      delegateeName: 'Hamna Latif Bhutta',
      itemTitle: 'ShireMe Recruiting Portal Application Testing',
      ageDays: 3,
      itemId: 'proactive-p02',
    }),
  },
  {
    id: 'P03-lifecycle-intervention',
    provenance: 'CL-034 / R-1 17:00 and B08 in the compose benchmark — "repeated deterministic framing"',
    situation:
      'Something I delegated is stuck and needs me. Tell me what happened and what you '
      + 'recommend, the way a colleague would.',
    render: () => renderLifecycleIntervention({
      itemTitle: 'Vision Metric Integration',
      summary: 'Three follow-up attempts have gone out with no usable response.',
      delayReason: null,
    }),
  },
  {
    id: 'P04-unattached-reply',
    provenance: 'CL-033 — one of ten consecutive notifications from a single unknown number',
    situation:
      'Someone I have no open work with sent me a message. Decide whether it is worth my '
      + 'attention and tell me only what I need.',
    render: () => renderUnattachedReply({
      who: '+923001234567',
      body: 'Okby',
    }),
  },
  {
    id: 'P05-duplicate-window',
    provenance:
      'CL-033 09:05-09:40 — DEF-139. Six pushes from one sender inside 35 minutes, as the '
      + 'owner received them. Scores the words; the CADENCE is the defect and this slice '
      + 'cannot see it.',
    situation:
      'One unknown number sent me several short, meaningless messages in half an hour. '
      + 'This is what arrived on my phone. Was this the right amount to tell me?',
    render: () => [
      'Gsus',
      'Hello, peace be upon you. How are you? Are you okay?',
      'Q Kya hwo',
      'Ni bat karn to ok',
      'Okby',
      'Man ni ke cl',
    ].map((body) => renderUnattachedReply({ who: '+923001234567', body })).join('\n\n'),
  },
  {
    id: 'P06-unreadable-delegatee-reply',
    provenance: 'CL-034 / DEF-142 — "Kon" (Roman-Urdu "who?") escalated instead of answered',
    situation:
      'My delegatee replied "Kon", which is Urdu for "who?" — she is asking who is '
      + 'messaging her. Handle it, and only involve me if you genuinely cannot.',
    openQuestions: ['Which item should I chase Hamna on?'],
    render: () => renderLifecycleIntervention({
      itemTitle: 'ShireMe Recruiting Portal Application Testing',
      summary: 'The reply "Kon" is not a recognisable status update.',
      delayReason: null,
    }),
  },
];

interface ScoredCase {
  id: string;
  provenance: string;
  situation: string;
  message: string;
  messageLen: number;
  overallScore: number | null;
  criteria: Record<string, { score: number; reason: string }> | null;
  improvement: string | null;
  judgeProvider?: string;
  error?: string;
}

function parseArgs(argv: string[]): { out?: string; target: number } {
  let out: string | undefined;
  let target = 95;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--target') target = Number(argv[++i]) || 95;
  }
  return { out, target };
}

async function main(): Promise<void> {
  const { out, target } = parseArgs(process.argv.slice(2));
  const startedAt = new Date().toISOString();

  console.log(`Nexeo PROACTIVE slice — ${CASES.length} cases, target ${target} on EVERY criterion`);
  console.log(`tenant ${CLIENT_NUMBER} user ${USER_ID}`);
  console.log('reported SEPARATELY from the twelve compose cases; no dispatch, no writes\n');

  const scored: ScoredCase[] = [];

  for (const c of CASES) {
    let message = '';
    try {
      message = c.render();
    } catch (e: any) {
      scored.push({
        id: c.id, provenance: c.provenance, situation: c.situation,
        message: '', messageLen: 0, overallScore: null, criteria: null,
        improvement: null, error: `render failed: ${e?.message ?? e}`,
      });
      console.log(`ERROR ${c.id} — render threw: ${e?.message ?? e}`);
      continue;
    }

    const evaluation = await evaluateBrainResponse({
      clientNumber: CLIENT_NUMBER,
      userId: USER_ID,
      userMessage: c.situation,
      brainResponse: message,
      surface: 'proactive_whatsapp',
      context: {
        openQuestions: c.openQuestions,
        previousTurns: c.previousTurns,
      },
    });

    if (!evaluation) {
      scored.push({
        id: c.id, provenance: c.provenance, situation: c.situation,
        message, messageLen: message.length, overallScore: null, criteria: null,
        improvement: null, error: 'judge returned no parseable evaluation',
      });
      console.log(`ERROR ${c.id} — judge produced nothing parseable`);
      continue;
    }

    const criteria = evaluation.criteria as Record<string, { score: number; reason: string }>;
    const worst = Object.entries(criteria)
      .sort((a, b) => a[1].score - b[1].score)[0];
    scored.push({
      id: c.id, provenance: c.provenance, situation: c.situation,
      message, messageLen: message.length,
      overallScore: evaluation.overallScore, criteria,
      improvement: evaluation.improvement, judgeProvider: evaluation.judgeProvider,
    });
    const flag = evaluation.overallScore >= target ? 'PASS ' : 'BELOW';
    console.log(
      `${flag} ${c.id.padEnd(34)} overall=${String(evaluation.overallScore).padStart(3)}`
      + `  worst=${worst?.[0]}:${worst?.[1].score}`,
    );
    if (worst && worst[1].score < target) console.log(`      ${worst[0]}: ${worst[1].reason}`);
  }

  // ── Aggregate. Same shape as the compose report so the ledger can read both.
  const usable = scored.filter((s) => s.criteria);
  const criteriaAvg: Record<string, number> = {};
  if (usable.length > 0) {
    const keys = Object.keys(usable[0].criteria!);
    for (const k of keys) {
      const vals = usable.map((s) => s.criteria![k]?.score).filter((v) => typeof v === 'number');
      if (vals.length > 0) {
        criteriaAvg[k] = Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
      }
    }
  }
  const overall = usable.length > 0
    ? Math.round((usable.reduce((a, s) => a + (s.overallScore ?? 0), 0) / usable.length) * 10) / 10
    : 0;
  const entries = Object.entries(criteriaAvg);
  const weakest = entries.sort((a, b) => a[1] - b[1])[0];
  const gatePassed = usable.length === CASES.length
    && overall >= target
    && entries.every(([, v]) => v >= target);

  const fixQueue = usable
    .flatMap((s) => Object.entries(s.criteria!).map(([criterion, v]) => ({
      criterion, caseId: s.id, score: v.score, reason: v.reason,
    })))
    .filter((e) => e.score < target)
    .sort((a, b) => a.score - b.score);

  const report = {
    surface: 'proactive',
    note: 'Scored SEPARATELY from the twelve compose cases. Same judge, different '
      + 'surface, and the situation field is the owner\'s expectation rather than a '
      + 'literal user message — see the file docblock. Do not average these with the '
      + 'compose numbers.',
    target,
    gatePassed,
    overall,
    criteriaAvg,
    weakestCriterion: weakest?.[0] ?? null,
    weakestCriterionScore: weakest?.[1] ?? null,
    fixQueue,
    casesScored: usable.length,
    casesFailed: scored.length - usable.length,
    /** No dispatch path is invoked, so nothing can be written. Stated as data so
     *  the ledger can assert it rather than trust the docblock. */
    dispatched: false,
    writesPerformed: 0,
    clientNumber: CLIENT_NUMBER,
    userId: USER_ID,
    startedAt,
    finishedAt: new Date().toISOString(),
    cases: scored,
  };

  console.log(
    `\noverall=${overall} weakest=${weakest?.[0] ?? 'n/a'}:${weakest?.[1] ?? 'n/a'} `
    + `scored=${usable.length}/${CASES.length} gate=${gatePassed ? 'pass' : 'fail'}`,
  );
  console.log('dispatched=false writes=0 — pure renderers, so D-1 needs no teardown here');

  if (out) {
    const fs = await import('fs');
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(`report -> ${out}`);
  }

  if (usable.length === 0) process.exit(1);
  process.exit(gatePassed ? 0 : 2);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[nexeoProactiveBenchmark] fatal:', e);
    process.exit(1);
  });
}

/** Exported for the isolation test — it asserts every case renders through a real
 *  producer and that this module pulls in no dispatch or persistence surface. */
export { CASES as __PROACTIVE_CASES };
