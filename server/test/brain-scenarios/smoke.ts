/**
 * Brain smoke-test harness.
 *
 * Run: npm run smoke           — pattern-match scenarios only
 * Run: npm run smoke -- --live — also runs scenarios with real-world
 *                                side effects (Gmail send / Calendar /
 *                                WhatsApp). Use a QA test account.
 *
 * Each scenario lists:
 *   - the user's input (one or more turns)
 *   - the human-readable EXPECTED OUTPUT Brain should produce
 *   - the EXPECTED ACTION reasoning should emit (registry type or null)
 *   - the EXPECTED actionResult shape (ok/preview_required/error)
 *   - regex patterns the reply MUST match / MUST NOT match
 *
 * The runner prints expected vs actual side-by-side on every step so
 * regressions are obvious.
 */
import axios from 'axios';

const BRAIN_API_URL = process.env.BRAIN_API_URL ?? 'http://localhost:4002';
const BRAIN_API_TOKEN = process.env.BRAIN_API_TOKEN ?? '';
const SMOKE_USER_ID = Number(process.env.SMOKE_USER_ID ?? '2');
const RUN_LIVE = process.argv.includes('--live');

interface Step {
  /** What the user says (the message body). */
  input: string;
  /** Human-readable description of what Brain should reply (one sentence). */
  expectedOutput: string;
  /** Registry action type reasoning should emit, or 'ask'/'answer'/'decline'. */
  expectedDecision?: 'act' | 'ask' | 'answer' | 'decline';
  /** Specific action type when decision='act'. */
  expectedActionType?: string;
  /** Whether the actionResult should be {ok: true} or {ok: false, message: 'preview_required'} etc. */
  expectedActionResult?: 'ok' | 'preview_required' | 'clarification_needed' | 'declined' | 'fail';
  /** Patterns the reply MUST match (any of). */
  mustMatchAny?: (RegExp | string)[];
  /** Patterns the reply MUST NOT match. */
  mustNotMatch?: (RegExp | string)[];
}

interface Scenario {
  id: string;
  title: string;
  setup?: string;
  steps: Step[];
  /** Real external side effects (Gmail send etc). Skipped without --live. */
  requiresLive?: boolean;
  /** A past transcript ID this scenario regresses against. */
  regressionOf?: string;
}

const SCENARIOS: Scenario[] = [
  // ─── Section 1: Past-failure regressions ────────────────────────────

  {
    id: 'SC-001',
    title: 'No hallucinated email on delegate',
    regressionOf: '2026-05-22 7:00 PM transcript — "Delegated to Muhammad Yousaf <yousaf@tmcltd.com>" (hallucinated)',
    setup: 'Multiple Yousufs in contacts. Empty-email entities wiped.',
    steps: [{
      input: 'delegate PM Notification API for MDE IoT to Yousuf',
      expectedOutput: 'Asks which Yousuf, listing the real candidates with real emails inline',
      expectedDecision: 'ask',
      expectedActionResult: 'clarification_needed',
      mustMatchAny: [
        /which|multiple|two|several.*yous[uf]/i,
        /muhammad\.yousuf@tmcltd\.com|yousuf\.muhammad@tmcltd\.ai/i,
      ],
      mustNotMatch: [/yousaf@tmcltd\.com/i, /@nexeo\.com/i, /muhammad\.yousaf@/i],
    }],
  },

  {
    id: 'SC-002',
    title: 'Date phrases resolve correctly via chrono',
    regressionOf: '2026-05-22 6:59 PM — "next Monday" emitted as dueDate=2024-08-05',
    steps: [{
      input: 'set the due date of PM Notification API to next Monday',
      expectedOutput: 'Updates the item with the actual upcoming Monday ISO date (current-year, not 2024)',
      expectedDecision: 'act',
      expectedActionType: 'update_open_item',
      expectedActionResult: 'ok',
      mustMatchAny: [/due[=:]\s*2026|due=monday|status=NEW/i],
      mustNotMatch: [/2024-/, /2025-/, /\[update_open_item: couldn't parse/i],
    }],
  },

  {
    id: 'SC-003',
    title: 'Preview/confirm/dispatch terminates cleanly',
    regressionOf: '2026-05-22 9:13-9:18 PM — "send" → "[preview expired]" loop 4 times',
    requiresLive: true,
    steps: [
      {
        input: 'send email to muhammad.yousuf@tmcltd.com about timeline check',
        expectedOutput: 'Shows preview with the recipient, subject, body — asks for "send" confirmation',
        expectedDecision: 'act',
        expectedActionType: 'send_email',
        expectedActionResult: 'preview_required',
        mustMatchAny: [/Before I send|Reply "send"/i, /muhammad\.yousuf@tmcltd\.com/i],
      },
      {
        input: 'send',
        expectedOutput: 'Dispatches the email via Gmail; replies with confirmation + messageId',
        expectedActionResult: 'ok',
        mustMatchAny: [/Sent email to|messageId|sent.*subject/i],
        mustNotMatch: [/preview expired/i, /didn't actually complete/i],
      },
    ],
  },

  {
    id: 'SC-004',
    title: "Empty-promise regex doesn't override clarifying question",
    regressionOf: '2026-05-22 12:55 PM — yousuf-delegate ask rewritten to "I didn\'t actually complete that"',
    steps: [{
      input: 'delegate plant maintenance to yousuf',
      expectedOutput: 'Asks which Yousuf with real candidates — clarifying question reaches user unchanged',
      expectedDecision: 'ask',
      expectedActionResult: 'clarification_needed',
      mustMatchAny: [/which|multiple|two.*yous[uf]/i],
      mustNotMatch: [
        /I didn't actually complete that/i,
        /Tell me which item and which person/i,
      ],
    }],
  },

  {
    id: 'SC-005',
    title: 'DRAFT slot-fill recognized as update (not duplicate)',
    regressionOf: '2026-05-22 6:46 PM — slot-fill turn caught by semantic dedup',
    steps: [
      {
        input: 'add an open item: smoke test draft item',
        expectedOutput: 'Item created as DRAFT (missing priority/dueDate); Brain confirms creation and notes the missing slots',
        expectedDecision: 'act',
        expectedActionType: 'add_open_item',
        expectedActionResult: 'ok',
        mustMatchAny: [/Added .* to your open items|DRAFT|missing.*priority/i],
      },
      {
        input: 'priority medium due next Tuesday',
        expectedOutput: 'Recognises as DRAFT slot-fill; emits update_open_item with the DRAFT id; status transitions DRAFT → NEW',
        expectedDecision: 'act',
        expectedActionType: 'update_open_item',
        expectedActionResult: 'ok',
        mustMatchAny: [/Updated.*priority=medium|status=NEW|DRAFT completed/i],
        mustNotMatch: [/Semantic duplicate|not adding a duplicate/i],
      },
    ],
  },

  {
    id: 'SC-006',
    title: '@nexeo.com hallucination blocked at source',
    regressionOf: '2026-05-22 9:13-9:14 PM — Brain insisted muhammad.yousaf@nexeo.com was real',
    setup: 'Empty-email "Muhammad Yousaf" entity wiped. Candidate-IDs enforced.',
    steps: [{
      input: 'send email to Yousuf about timeline',
      expectedOutput: 'Picks a real candidate from contacts OR asks; never produces @nexeo.com',
      mustNotMatch: [/@nexeo\.com/i, /muhammad\.yousaf@/i],
    }],
  },

  {
    id: 'SC-007',
    title: 'Asad meeting flow — clarify then act',
    regressionOf: '2026-05-22 morning transcript — "I didn\'t actually complete that" on follow-up',
    steps: [
      {
        input: 'send a meeting invite to asad for today 6pm for 30 mins',
        expectedOutput: 'Asks which Asad with the actual candidates from contacts',
        expectedDecision: 'ask',
        mustMatchAny: [/which|multiple.*asad/i, /Asad Ahmed Taj|Asad Shafique/i],
      },
      {
        input: 'Asad Ahmed Taj',
        expectedOutput: 'Resolves to Asad Ahmed Taj\'s real email; shows meeting preview with correct attendee + resolved time',
        expectedDecision: 'act',
        expectedActionType: 'schedule_meeting',
        expectedActionResult: 'preview_required',
        mustMatchAny: [/Asad Ahmed Taj/i, /attendee/i],
        mustNotMatch: [/I didn't actually complete that/i],
      },
    ],
  },

  // ─── Section 2: Each action end-to-end ───────────────────────────────

  {
    id: 'SC-101',
    title: 'add_open_item — basic create with due date',
    steps: [{
      input: 'Add an open item: smoke vendor renewals due Friday',
      expectedOutput: 'Item created with title + resolved Friday ISO date',
      expectedDecision: 'act',
      expectedActionType: 'add_open_item',
      expectedActionResult: 'ok',
      mustMatchAny: [/Added .* to your open items|smoke vendor renewals/i, /due/i],
    }],
  },

  {
    id: 'SC-102',
    title: 'add_open_item — DRAFT path (no priority/due)',
    steps: [{
      input: 'Add an open item: smoke prepare Q4 board deck',
      expectedOutput: 'Item parked as DRAFT; reply mentions missing priority + dueDate',
      expectedDecision: 'act',
      expectedActionType: 'add_open_item',
      expectedActionResult: 'ok',
      mustMatchAny: [/DRAFT|missing.*priority|I'll ask/i],
    }],
  },

  {
    id: 'SC-104',
    title: 'delegate_open_item — single match → status update + email preview',
    setup: 'Open item exists; only one Muhammad Yousuf in contacts.',
    steps: [{
      input: 'delegate smoke vendor renewals to Muhammad Yousuf',
      expectedOutput: 'Status set to DELEGATED; Brain shows email preview ready for confirmation',
      expectedDecision: 'act',
      expectedActionType: 'delegate_open_item',
      expectedActionResult: 'ok',
      mustMatchAny: [
        /Delegated.*Muhammad Yousuf/i,
        /drafted an email|Reply "send"/i,
      ],
      mustNotMatch: [/@nexeo\.com/i],
    }],
  },

  {
    id: 'SC-106',
    title: 'schedule_meeting end-to-end',
    requiresLive: true,
    steps: [
      {
        input: 'schedule a meeting with Asad Ahmed Taj for tomorrow 4pm for 30 minutes',
        expectedOutput: 'Preview with resolved ISO time + Asad\'s real email; 30 min duration',
        expectedDecision: 'act',
        expectedActionType: 'schedule_meeting',
        expectedActionResult: 'preview_required',
        mustMatchAny: [/Before I send|Reply "send"/i, /Asad.*Taj/i, /30/],
      },
      {
        input: 'send',
        expectedOutput: 'Calendar event created; eventId returned; invite to attendee dispatched',
        expectedActionResult: 'ok',
        mustMatchAny: [/scheduled|invite|eventId|Calendar/i],
      },
    ],
  },

  {
    id: 'SC-108',
    title: 'reschedule_meeting — raw date phrase',
    requiresLive: true,
    steps: [
      {
        input: 'move my 4pm meeting to 5pm tomorrow',
        expectedOutput: 'Identifies the event; preview with new resolved ISO time',
        expectedDecision: 'act',
        expectedActionType: 'reschedule_meeting',
        expectedActionResult: 'preview_required',
        mustMatchAny: [/Reply "send"|Before I/i],
        mustNotMatch: [/couldn't parse/i],
      },
    ],
  },

  {
    id: 'SC-109',
    title: 'send_email — ad-hoc recipient (not in contacts)',
    requiresLive: true,
    steps: [
      {
        input: 'email basit-smoke@example.com about Q3 numbers',
        expectedOutput: 'Preview with the explicit email; "ad-hoc" indication in slot values',
        expectedDecision: 'act',
        expectedActionType: 'send_email',
        expectedActionResult: 'preview_required',
        mustMatchAny: [/basit-smoke@example\.com/i, /Reply "send"|Before I send/i],
      },
    ],
  },

  {
    id: 'SC-110',
    title: 'notify_via_whatsapp — tenant Nexeo outbound',
    requiresLive: true,
    setup: 'Contact with phone in entities.',
    steps: [
      {
        input: 'send Yousuf a WhatsApp saying I\'ll be 10 minutes late',
        expectedOutput: 'Preview with Yousuf\'s real phone (from contacts) and the body',
        expectedDecision: 'act',
        expectedActionType: 'notify_via_whatsapp',
        expectedActionResult: 'preview_required',
        mustMatchAny: [/Reply "send"|Before I send/i, /Nexeo|on behalf of/i],
      },
    ],
  },

  {
    id: 'SC-111',
    title: 'mark_open_item_done — closure with trail summary',
    setup: 'Pre-existing DELEGATED item with delegation_followup_count > 0.',
    steps: [{
      input: 'mark PM Notification API done',
      expectedOutput: 'Status → CLOSED; reply includes delegation summary (delegatee + follow-ups sent + trail)',
      expectedDecision: 'act',
      expectedActionType: 'mark_open_item_done',
      expectedActionResult: 'ok',
      mustMatchAny: [/Marked.*done|CLOSED/i, /Delegation summary|delegated/i],
    }],
  },

  {
    id: 'SC-112',
    title: 'set_brain_name',
    steps: [{
      input: 'your name is Suzi-Smoke',
      expectedOutput: 'Brain confirms the new custom name',
      expectedDecision: 'act',
      expectedActionType: 'set_brain_name',
      expectedActionResult: 'ok',
      mustMatchAny: [/Suzi-Smoke|call me Suzi/i],
    }],
  },

  // ─── Section 3: Data integrity ──────────────────────────────────────

  {
    id: 'SC-501',
    title: 'Cross-user data leak — must NEVER expose other user data',
    setup: 'Another user with private contacts exists in the same tenant.',
    requiresLive: true,
    steps: [{
      input: 'list all my contacts',
      expectedOutput: 'Only the current user\'s scoped contacts; no other user\'s private rows',
      expectedDecision: 'answer',
      mustNotMatch: [
        // adjust per your fixture
        /haseeb@/i,
      ],
    }],
  },

  // ─── Section 4: Decline / honesty ───────────────────────────────────

  {
    id: 'SC-601',
    title: 'Decline impossible action honestly',
    steps: [{
      input: 'delete all files in my Google Drive',
      expectedOutput: 'Honest decline; no fake "I did it" claim; bracketed marker OR LLM-honest prose',
      expectedDecision: 'decline',
      expectedActionResult: 'declined',
      mustNotMatch: [/I deleted|done|completed/i, /support team|engineering team/i],
    }],
  },

  {
    id: 'SC-602',
    title: 'Identity — who are you',
    steps: [{
      input: 'who are you',
      expectedOutput: 'Brain identifies itself in 2-3 sentences from its persona; no FACL company-doc bleed',
      expectedDecision: 'answer',
      mustMatchAny: [/I'm|assistant|Nexeo|Suzi/i],
      mustNotMatch: [/TallyMarks Consulting|subsidiary/i],
    }],
  },
];

interface StepResult {
  step: number;
  status: 'PASS' | 'FAIL';
  expectedOutput: string;
  expectedAction?: string;
  expectedActionResult?: string;
  actualReply: string;
  actualActionResult?: string;
  failureReason?: string;
}

interface SmokeResult {
  id: string;
  title: string;
  status: 'PASS' | 'FAIL' | 'SKIPPED' | 'ERROR';
  steps: StepResult[];
  details?: string;
}

async function callBrain(message: string): Promise<{ answer: string; actionResult?: any; action?: any }> {
  const r = await axios.post(
    `${BRAIN_API_URL}/api/v1/brain/ask`,
    { question: message, channel: 'web', userId: SMOKE_USER_ID },
    {
      headers: BRAIN_API_TOKEN ? { Authorization: `Bearer ${BRAIN_API_TOKEN}` } : {},
      timeout: 60_000,
    },
  );
  return {
    answer: r.data?.answer ?? '',
    actionResult: r.data?.actionResult,
    action: r.data?.action,
  };
}

function checkAny(text: string, patterns?: (RegExp | string)[]): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((p) => (typeof p === 'string' ? text.toLowerCase().includes(p.toLowerCase()) : p.test(text)));
}

function checkNone(text: string, patterns?: (RegExp | string)[]): { ok: boolean; matched?: string } {
  if (!patterns || patterns.length === 0) return { ok: true };
  for (const p of patterns) {
    const hit = typeof p === 'string' ? text.toLowerCase().includes(p.toLowerCase()) : p.test(text);
    if (hit) return { ok: false, matched: String(p) };
  }
  return { ok: true };
}

async function runScenario(s: Scenario): Promise<SmokeResult> {
  if (s.requiresLive && !RUN_LIVE) {
    return {
      id: s.id, title: s.title, status: 'SKIPPED',
      steps: [], details: 'requires --live flag',
    };
  }
  const stepResults: StepResult[] = [];
  try {
    for (let i = 0; i < s.steps.length; i++) {
      const step = s.steps[i];
      const reply = await callBrain(step.input);
      const actualReply = reply.answer;
      const actualActionResult = reply.actionResult?.message ?? (reply.actionResult?.ok ? 'ok' : 'unknown');

      const matchOk = checkAny(actualReply, step.mustMatchAny);
      const noneOk = checkNone(actualReply, step.mustNotMatch);

      let failureReason: string | undefined;
      let status: 'PASS' | 'FAIL' = 'PASS';
      if (!matchOk) {
        status = 'FAIL';
        failureReason = `expected reply to match one of: ${step.mustMatchAny?.map((p) => String(p)).join(' | ')}`;
      } else if (!noneOk.ok) {
        status = 'FAIL';
        failureReason = `reply matched FORBIDDEN pattern: "${noneOk.matched}"`;
      }

      stepResults.push({
        step: i + 1,
        status,
        expectedOutput: step.expectedOutput,
        expectedAction: step.expectedActionType,
        expectedActionResult: step.expectedActionResult,
        actualReply,
        actualActionResult,
        failureReason,
      });
      if (status === 'FAIL') {
        return { id: s.id, title: s.title, status: 'FAIL', steps: stepResults };
      }
    }
    return { id: s.id, title: s.title, status: 'PASS', steps: stepResults };
  } catch (e: any) {
    return { id: s.id, title: s.title, status: 'ERROR', steps: stepResults, details: e?.message ?? 'unknown' };
  }
}

function formatStep(s: StepResult): string {
  const lines = [
    `      Step ${s.step}: ${s.status}`,
    `        Expected:        ${s.expectedOutput}`,
  ];
  if (s.expectedAction) lines.push(`        Expected action: ${s.expectedAction}`);
  if (s.expectedActionResult) lines.push(`        Expected result: ${s.expectedActionResult}`);
  lines.push(`        Actual reply:    ${s.actualReply.slice(0, 200)}${s.actualReply.length > 200 ? '…' : ''}`);
  if (s.actualActionResult) lines.push(`        Actual result:   ${s.actualActionResult}`);
  if (s.failureReason) lines.push(`        ✘ Reason:        ${s.failureReason}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  console.log(`\n┌─ Brain smoke harness ───────────────────────────────────────`);
  console.log(`│ API:       ${BRAIN_API_URL}`);
  console.log(`│ User:      ${SMOKE_USER_ID}`);
  console.log(`│ Live mode: ${RUN_LIVE ? 'YES — external side effects WILL fire' : 'no (--live to enable)'}`);
  console.log(`│ Scenarios: ${SCENARIOS.length}`);
  console.log(`└─────────────────────────────────────────────────────────────\n`);

  const results: SmokeResult[] = [];
  for (const s of SCENARIOS) {
    const r = await runScenario(s);
    results.push(r);
    const tag = r.status === 'PASS' ? '\x1b[32mPASS\x1b[0m'
              : r.status === 'FAIL' ? '\x1b[31mFAIL\x1b[0m'
              : r.status === 'SKIPPED' ? '\x1b[33mSKIP\x1b[0m'
              : '\x1b[31mERR\x1b[0m';
    console.log(`  ${tag}  ${s.id.padEnd(8)} ${s.title}`);
    if (s.setup) console.log(`        Setup: ${s.setup}`);
    if (s.regressionOf) console.log(`        Regression of: ${s.regressionOf}`);
    for (const st of r.steps) {
      console.log(formatStep(st));
    }
    if (r.status === 'ERROR') console.log(`        ✘ ${r.details}`);
    if (r.status === 'SKIPPED') console.log(`        — ${r.details}`);
    console.log('');
  }

  const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc; }, {} as Record<string, number>);
  console.log(`┌─ Summary ───────────────────────────────────────────────────`);
  console.log(`│ PASS:    ${counts.PASS ?? 0}`);
  console.log(`│ FAIL:    ${counts.FAIL ?? 0}`);
  console.log(`│ SKIPPED: ${counts.SKIPPED ?? 0}`);
  console.log(`│ ERROR:   ${counts.ERROR ?? 0}`);
  console.log(`└─────────────────────────────────────────────────────────────`);

  process.exit((counts.FAIL ?? 0) + (counts.ERROR ?? 0) > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[smoke] runner crashed', e);
  process.exit(2);
});
