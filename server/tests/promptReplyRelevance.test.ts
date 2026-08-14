/**
 * Section 32B — LLM relevance gate for prompt-queue consumption.
 * The full reviewer matrix: greetings/small talk (incl. roman Urdu),
 * legitimate answers (done / blocker / owner / dates / short
 * multilingual), classifier failure semantics, and handler
 * integration (no mutation unless confidently relevant). Voice and
 * text share this decision by construction: transcribed voice enters
 * the same handlePromptReply text path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseRelevanceVerdict,
  mayConsumeAsAnswer,
  classifyPromptReplyRelevance,
  RELEVANCE_CONFIDENCE_THRESHOLD,
} from '../src/services/brainPrompts/promptReplyRelevance';

const callLLMMock = vi.fn();
vi.mock('../src/services/llmRouter', () => ({ callLLM: (...a: any[]) => callLLMMock(...a) }));

describe('parseRelevanceVerdict — strict', () => {
  it('accepts a valid verdict, including embedded in prose', () => {
    expect(parseRelevanceVerdict('{"relevance":"new_conversation_turn","confidence":0.95}'))
      .toEqual({ relevance: 'new_conversation_turn', confidence: 0.95 });
    expect(parseRelevanceVerdict('Sure! {"relevance":"answers_pending_prompt","confidence":0.8}'))
      .toEqual({ relevance: 'answers_pending_prompt', confidence: 0.8 });
  });
  it('rejects malformed output (unknown label, bad confidence, no JSON)', () => {
    expect(parseRelevanceVerdict('{"relevance":"maybe","confidence":0.9}')).toBeNull();
    expect(parseRelevanceVerdict('{"relevance":"ambiguous","confidence":-1}')).toBeNull();
    expect(parseRelevanceVerdict('{"relevance":"ambiguous","confidence":"high"}')).toBeNull();
    expect(parseRelevanceVerdict('plain text')).toBeNull();
    expect(parseRelevanceVerdict(undefined)).toBeNull();
  });
});

describe('mayConsumeAsAnswer — only confident relevance mutates', () => {
  it('confident answers_pending_prompt → consume', () => {
    expect(mayConsumeAsAnswer({ relevance: 'answers_pending_prompt', confidence: 0.9 })).toBe(true);
    expect(mayConsumeAsAnswer({ relevance: 'answers_pending_prompt', confidence: RELEVANCE_CONFIDENCE_THRESHOLD })).toBe(true);
  });
  it('everything else falls through to chat', () => {
    expect(mayConsumeAsAnswer({ relevance: 'answers_pending_prompt', confidence: 0.5 })).toBe(false);
    expect(mayConsumeAsAnswer({ relevance: 'new_conversation_turn', confidence: 1 })).toBe(false);
    expect(mayConsumeAsAnswer({ relevance: 'ambiguous', confidence: 1 })).toBe(false);
    expect(mayConsumeAsAnswer(null)).toBe(false);
  });
});

describe('classifyPromptReplyRelevance — classifier transport', () => {
  beforeEach(() => { callLLMMock.mockReset(); }); // braces matter: a returned mock would run as a teardown callback

  it('passes question, expected kind, item title, and message to the LLM', async () => {
    callLLMMock.mockResolvedValue({
      text: '{"relevance":"new_conversation_turn","confidence":0.97}', provider: 'gemini' as any,
    });
    const verdict = await classifyPromptReplyRelevance({
      pendingQuestion: 'Any update on the EXIM filing? Is anything blocking it?',
      sideEffectKind: 'action_status_update',
      openItemTitle: 'EXIM filing',
      inboundText: 'Whatsup?',
    });
    expect(verdict).toEqual({ relevance: 'new_conversation_turn', confidence: 0.97 });
    const [, userMessage] = callLLMMock.mock.calls[0];
    for (const fragment of ['EXIM filing', 'action_status_update', 'Whatsup?']) {
      expect(userMessage).toContain(fragment);
    }
  });
  it('LLM throw → null (no mutation), never propagates', async () => {
    callLLMMock.mockRejectedValue(new Error('provider down'));
    const verdict = await classifyPromptReplyRelevance({
      pendingQuestion: 'q', sideEffectKind: 'set_due_date', inboundText: 'friday',
    });
    expect(verdict).toBeNull();
  });
  it('unparseable LLM output → null', async () => {
    callLLMMock.mockResolvedValue({ text: 'LLM did not return JSON', provider: 'gemini' as any });
    await expect(classifyPromptReplyRelevance({
      pendingQuestion: 'q', sideEffectKind: 'noop', inboundText: 'done',
    })).resolves.toBeNull();
  });
});

describe('handlePromptReply integration — gate placement', () => {
  beforeEach(() => {
    vi.resetModules();
    callLLMMock.mockReset();
  });

  const arm = async (llmText: string | Error) => {
    // DEF-178: recordAnswer is a CAS — true means exactly one row moved
    // `awaiting_reply → answered`, and the handler refuses to mutate or ack
    // without that proof. The happy-path mock persists.
    const recordAnswer = vi.fn(async () => true);
    // DEF-176: the tenantless fallback (getAwaitingPrompt without a tenant) is
    // deleted; correlation always goes through the tenant-scoped candidate
    // search, so that is what the mock provides.
    vi.doMock('../src/services/brainPrompts/brainPromptQueueService', () => ({
      getAnswerableQuestions: vi.fn(async () => ([{
        id: 42n, question: 'Any update on the EXIM filing?',
        sideEffect: { kind: 'action_status_update' }, openItemId: null,
        state: 'awaiting_reply',
      }])),
      reviveExpiredPrompt: vi.fn(async () => true),
      recordAnswer,
      sendNextPrompt: vi.fn(async () => {}),
    }));
    vi.doMock('../src/services/behaviorConfig', () => ({
      getBehaviorValue: vi.fn(async (key: string) =>
        (key === 'prompt_reply.max_candidates' ? 5 : 24)),
    }));
    if (llmText instanceof Error) callLLMMock.mockRejectedValue(llmText);
    else callLLMMock.mockResolvedValue({ text: llmText, provider: 'gemini' as any });
    const { handlePromptReply } = await import('../src/services/brainPrompts/promptReplyHandler');
    return { handlePromptReply, recordAnswer };
  };

  it('greeting judged new_conversation_turn → NOT consumed, no recordAnswer', async () => {
    const { handlePromptReply, recordAnswer } =
      await arm('{"relevance":"new_conversation_turn","confidence":0.95}');
    const r = await handlePromptReply({ userId: 2, clientNumber: 'TMC-0001', text: 'Whatsup?' });
    expect(r.handled).toBe(false);
    expect(recordAnswer).not.toHaveBeenCalled();
  });
  it('legitimate blocker answer judged relevant → consumed via recordAnswer', async () => {
    const { handlePromptReply, recordAnswer } =
      await arm('{"relevance":"answers_pending_prompt","confidence":0.92}');
    const r = await handlePromptReply({ userId: 2, clientNumber: 'TMC-0001', text: 'waiting on finance approval since monday' });
    expect(r.handled).toBe(true);
    // DEF-176: the answer is recorded UNDER the caller's tenant — the scope
    // argument is part of the contract, not decoration.
    expect(recordAnswer).toHaveBeenCalledWith(42n, 'waiting on finance approval since monday',
      { userId: 2, clientNumber: 'TMC-0001' });
  });
  it('classifier failure → prompt untouched, message goes to chat', async () => {
    const { handlePromptReply, recordAnswer } = await arm(new Error('LLM outage'));
    const r = await handlePromptReply({ userId: 2, clientNumber: 'TMC-0001', text: 'done' });
    expect(r.handled).toBe(false);
    expect(recordAnswer).not.toHaveBeenCalled();
  });
  it('roman-Urdu greeting with ambiguous verdict → falls through', async () => {
    const { handlePromptReply, recordAnswer } =
      await arm('{"relevance":"ambiguous","confidence":0.9}');
    const r = await handlePromptReply({ userId: 2, clientNumber: 'TMC-0001', text: 'kya haal hai' });
    expect(r.handled).toBe(false);
    expect(recordAnswer).not.toHaveBeenCalled();
  });
});
