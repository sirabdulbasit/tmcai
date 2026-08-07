/**
 * DEF-097 — every Brain response is scored against the Living Assistant Standard.
 *
 * Standard: `server/docs/brain_living_assistant_standard.md`.
 * Owner ruling, 2026-08-07: *"first describe the Standard how brain should think,
 * react and take action like living assistant ... and then analyze brain every
 * response as per that standard and keep analyzing through armed/alive watcher"*.
 *
 * What these assertions protect, in order of how badly each has burned us:
 *
 *  - The judge must NEVER break the turn it judges. Evaluation runs after the
 *    reply is already sent; a throwing judge that took the reply with it would
 *    be strictly worse than no judge (same rule as `recordFinding`).
 *  - A judge that returns nothing must NOT be read as "the response was fine".
 *    Silent degradation is DEF-086, and it is how monitoring stops happening
 *    without anyone noticing.
 *  - Scoring must be per-user under a tenant, never global (owner instruction,
 *    2026-08-07).
 *  - A repeated weakness must become a finding, not a statistic — otherwise this
 *    is `gapDetectionJob`, which has persisted "gap candidates for admin review"
 *    for months with no reviewer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const callLLM = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn());
const count = vi.hoisted(() => vi.fn());
const recordFinding = vi.hoisted(() => vi.fn());

vi.mock('../src/services/llmRouter', () => ({ callLLM }));
vi.mock('../src/services/selfheal/healthFindingService', () => ({ recordFinding }));
vi.mock('../src/db/prisma', () => ({
  default: { brainResponseEvaluation: { create, count } },
}));

import {
  evaluateBrainResponse,
  CRITERIA,
  BAND_WEAK,
  BAND_DEFECT,
} from '../src/services/knowledge/brainResponseEvaluator';

const goodScores = (score: number) =>
  Object.fromEntries(Object.keys(CRITERIA).map((k) => [k, { score, reason: `${k} reason` }]));

const llmReturns = (obj: unknown, provider = 'gemini-flash') =>
  callLLM.mockResolvedValue({ text: JSON.stringify(obj), provider });

const input = {
  clientNumber: 'TMC-0001',
  userId: 2,
  userMessage: 'check if Hamna has responded',
  brainResponse: 'No reply from her since the 4th — want me to chase it?',
};

beforeEach(() => {
  callLLM.mockReset();
  create.mockReset();
  count.mockReset();
  recordFinding.mockReset();
  create.mockResolvedValue({ id: 'eval_1' });
  count.mockResolvedValue(0);
});

describe('DEF-097 — the judge scores the standard', () => {
  it('averages the criteria into an overall score', async () => {
    llmReturns({ ...goodScores(90), improvement: 'nothing material' });
    const ev = await evaluateBrainResponse(input);
    expect(ev?.overallScore).toBe(90);
    expect(Object.keys(ev!.criteria)).toHaveLength(Object.keys(CRITERIA).length);
  });

  it('flags exactly the criteria below band', async () => {
    llmReturns({
      ...goodScores(95),
      C3: { score: 40, reason: 'ignored the question Brain itself asked' },
      C4: { score: 55, reason: 'canned sentence' },
      improvement: 'answer the outstanding question first',
    });
    const ev = await evaluateBrainResponse(input);
    expect(ev?.weakCriteria.sort()).toEqual(['C3', 'C4']);
    expect(BAND_WEAK).toBe(70);
  });

  it('records the judging model, so a scoring shift can be told from a behaviour shift', async () => {
    llmReturns({ ...goodScores(88), improvement: '' }, 'claude');
    const ev = await evaluateBrainResponse(input);
    expect(ev?.judgeProvider).toBe('claude');
    expect(create.mock.calls[0][0].data.judgeProvider).toBe('claude');
  });

  it('persists scoped to BOTH tenant and user — never a global "the owner"', async () => {
    llmReturns({ ...goodScores(80), improvement: '' });
    await evaluateBrainResponse({ ...input, clientNumber: 'TMC-0009', userId: 7 });
    expect(create.mock.calls[0][0].data).toMatchObject({ clientNumber: 'TMC-0009', userId: 7 });
  });

  it('opens a finding immediately when a single reply is below the defect band', async () => {
    // Standard §3: below 50 is a defect, not a statistic — one turn is enough,
    // because a reply that bad already reached a real person.
    llmReturns({
      ...goodScores(40),
      C1: { score: 10, reason: 'claimed it sent a message that was never sent' },
      improvement: 'do not claim a send without a confirmed send',
    });
    await evaluateBrainResponse(input);
    const kinds = recordFinding.mock.calls.map((c) => c[0].kind);
    expect(kinds).toContain('response_below_standard');
    const f = recordFinding.mock.calls.find((c) => c[0].kind === 'response_below_standard')![0];
    expect(f.severity).toBe('error');
    expect(f.evidence.worstCriterion).toBe('C1');
    expect(BAND_DEFECT).toBe(50);
  });

  it('does NOT open a defect finding for a merely weak reply', async () => {
    llmReturns({ ...goodScores(95), C4: { score: 65, reason: 'a bit stiff' }, improvement: 'warmer' });
    await evaluateBrainResponse(input);
    expect(recordFinding.mock.calls.map((c) => c[0].kind)).not.toContain('response_below_standard');
  });

  it('escalates a criterion that keeps failing — a behaviour, not a statistic', async () => {
    count.mockResolvedValue(3);
    llmReturns({ ...goodScores(95), C3: { score: 30, reason: 'lost the thread again' }, improvement: 'recall first' });
    await evaluateBrainResponse(input);
    await new Promise((r) => setImmediate(r));
    const rec = recordFinding.mock.calls.find((c) => c[0].kind === 'standard_criterion_recurring');
    expect(rec).toBeDefined();
    expect(rec![0].subjectId).toBe('C3');
  });

  it('does not escalate a one-off weakness', async () => {
    count.mockResolvedValue(1);
    llmReturns({ ...goodScores(95), C3: { score: 30, reason: 'one bad turn' }, improvement: 'x' });
    await evaluateBrainResponse(input);
    await new Promise((r) => setImmediate(r));
    expect(recordFinding.mock.calls.map((c) => c[0].kind)).not.toContain('standard_criterion_recurring');
  });

  it('returns null — never a passing score — when the judge output is unparseable', async () => {
    // The dangerous failure: an unreadable judge treated as "fine" would let
    // evaluation silently stop while the dashboard stayed green (DEF-086).
    callLLM.mockResolvedValue({ text: 'I think it was pretty good actually', provider: 'gemini-flash' });
    const ev = await evaluateBrainResponse(input);
    expect(ev).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(recordFinding.mock.calls.map((c) => c[0].kind)).toContain('response_evaluation_unparseable');
  });

  it('never throws when the judge provider is down', async () => {
    callLLM.mockImplementationOnce(() => Promise.reject(new Error('all providers failed')));
    await expect(evaluateBrainResponse(input)).resolves.toBeNull();
  });

  it('never throws when persistence fails — the turn already happened', async () => {
    create.mockRejectedValueOnce(new Error('db down'));
    llmReturns({ ...goodScores(90), improvement: '' });
    await expect(evaluateBrainResponse(input)).resolves.not.toBeNull();
  });

  it('skips empty exchanges rather than scoring nothing', async () => {
    expect(await evaluateBrainResponse({ ...input, brainResponse: '   ' })).toBeNull();
    expect(callLLM).not.toHaveBeenCalled();
  });

  it('gives the judge the outstanding questions — C3 cannot be judged without them', async () => {
    // DEF-093 and DEF-095 both looked fine in isolation and were only wrong in
    // the light of what Brain had outstanding.
    llmReturns({ ...goodScores(90), improvement: '' });
    await evaluateBrainResponse({
      ...input,
      context: {
        openQuestions: ['What priority and deadline should I put on this?'],
        previousTurns: [{ role: 'brain', text: 'Which item did you mean?' }],
      },
    });
    const prompt = callLLM.mock.calls[0][1] as string;
    expect(prompt).toContain('What priority and deadline should I put on this?');
    expect(prompt).toContain('Which item did you mean?');
  });
});
