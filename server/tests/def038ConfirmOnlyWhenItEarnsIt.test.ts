/**
 * DEF-038 — stop confirming what the owner already instructed.
 *
 * Owner, 2026-08-05: "why do I need to say 'send' where I am instructing?"
 * and then the rule: "Brain should only confirm if I asked anything to do
 * which is not normal, or may contain any risk — so after pointing the risk
 * Brain can seek confirmation."
 *
 * He asked twice today and hit it again at 18:43: he named the action, named
 * the person, disambiguated her himself one turn earlier, and was still asked
 * to type "send".
 *
 * The cost is not only friction. The confirmation step is where DEF-024,
 * DEF-032, DEF-035 and DEF-055 all lived — four defects in one family, two of
 * them introduced while fixing the one before. A step that exists for actions
 * the owner already ordered is a step that can only misfire.
 *
 * The decision is the model's, given FACTS from the database — has this person
 * been contacted before, is it reversible, whose name is on it. "Abnormal" and
 * "risky" are judgements about meaning, which the no-hardcoded-judgement rule
 * reserves for the LLM; a rule table here would be DEF-013 again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const H = vi.hoisted(() => ({
  callGemini: vi.fn(),
  prismaMock: { entity: { findFirst: vi.fn() } },
}));
vi.mock('../src/services/geminiService', () => ({ callGemini: H.callGemini }));
vi.mock('../src/db/prisma', () => ({ default: H.prismaMock }));

import { assessConfirmationNeed } from '../src/services/knowledge/confirmationPolicyService';

const ask = (action: any, question = 'ask hamna that will she come office tomorrow') =>
  assessConfirmationNeed({ action, question, history: [], userId: 2 });

beforeEach(() => {
  vi.clearAllMocks();
  H.prismaMock.entity.findFirst.mockResolvedValue({
    name: 'Hamna Latif Bhutta', lastInteraction: new Date('2026-08-04'), relationshipStrength: 0.5,
  });
});

describe('DEF-038 — routine instructions just happen', () => {
  it('does not confirm a clear instruction to a known person', async () => {
    H.callGemini.mockResolvedValue('{"needsConfirmation": false, "reason": "routine, known contact", "confidence": 0.9}');
    const v = await ask({ type: 'notify_via_whatsapp', recipientCandidateId: 'c1', message: 'Coming tomorrow?' });
    expect(v.needsConfirmation).toBe(false);
  });

  it('passes the model real facts, not just the sentence', async () => {
    H.callGemini.mockResolvedValue('{"needsConfirmation": false, "reason": "ok", "confidence": 0.9}');
    await ask({ type: 'notify_via_whatsapp', recipientCandidateId: 'c1', message: 'hi' });
    const userPrompt = H.callGemini.mock.calls[0][1];
    expect(userPrompt).toContain('contactedBefore');
    expect(userPrompt).toContain('reachesAPerson');
    expect(userPrompt).toContain('reversible');
  });
});

describe('DEF-038 — it asks when the check-in carries information', () => {
  it('asks, and NAMES the reason — never a bare "shall I proceed?"', async () => {
    H.callGemini.mockResolvedValue('{"needsConfirmation": true, "reason": "never messaged her before", "confidence": 0.9}');
    const v = await ask({ type: 'notify_via_whatsapp', recipientCandidateId: 'c1', message: 'hi' });
    expect(v.needsConfirmation).toBe(true);
    expect(v.reason).toContain('never messaged her before');
  });

  it('asks when the recipient does not resolve at all', async () => {
    H.prismaMock.entity.findFirst.mockResolvedValue(null);
    const v = await ask({ type: 'notify_via_whatsapp', recipientCandidateId: 'ghost', message: 'hi' });
    expect(v.needsConfirmation).toBe(true);
    expect(H.callGemini, 'no need to ask the model about an unresolvable target').not.toHaveBeenCalled();
  });
});

describe('DEF-038 — it fails closed, always', () => {
  it('asks when the model is not confident', async () => {
    H.callGemini.mockResolvedValue('{"needsConfirmation": false, "reason": "probably fine", "confidence": 0.3}');
    const v = await ask({ type: 'send_email', toCandidateIds: ['c1'], subject: 's', body: 'b' });
    expect(v.needsConfirmation, 'low confidence must resolve to asking').toBe(true);
  });

  it('asks when the model errors', async () => {
    H.callGemini.mockRejectedValue(new Error('gemini down'));
    const v = await ask({ type: 'notify_via_whatsapp', recipientCandidateId: 'c1', message: 'hi' });
    expect(v.needsConfirmation).toBe(true);
  });

  it('asks when the model returns unparseable output', async () => {
    H.callGemini.mockResolvedValue('not json at all');
    const v = await ask({ type: 'notify_via_whatsapp', recipientCandidateId: 'c1', message: 'hi' });
    expect(v.needsConfirmation).toBe(true);
  });
});

describe('DEF-038 — the judgement is the model\'s, not a rule table', () => {
  const CODE = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'knowledge', 'confirmationPolicyService.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('no keyword matching on the owner\'s wording decides it', () => {
    expect(CODE).not.toMatch(/question\.(?:match|test|includes)/);
    expect(CODE).not.toMatch(/\/\^?\(?delegate\|/);
  });

  it('the gate consults the policy before previewing', () => {
    const composer = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf8');
    expect(composer).toContain('assessConfirmationNeed');
    expect(composer).toMatch(/if \(!verdict\.needsConfirmation\)/);
  });
});
