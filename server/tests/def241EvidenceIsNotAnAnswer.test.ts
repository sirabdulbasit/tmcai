/**
 * DEF-241 — a turn carrying new evidence is not a bare reply to a pending question.
 *
 * 2026-08-24 17:06 PKT. The owner sent a screenshot of the Connectors page captioned "see".
 * The image pipeline, deployed three hours earlier, worked perfectly:
 *
 *     {"service":"whatsapp:media","message":"Inbound media downloaded"}          133 KB
 *     {"service":"image","provider":"gemini","textLen":4210,"latencyMs":12470}
 *
 * 4,210 characters describing his page, folded in as `see\n\n[image received — contents:]…`.
 * Two seconds later:
 *
 *     {"service":"prompt-reply-handler","promptId":"444","state":"awaiting_reply",
 *      "ageMinutes":2,"relevance":"answers_pending_prompt","relevanceConfidence":0.9}
 *     {"service":"whatsapp:inbound","message":"consumed as prompt reply","sideEffect":"noop"}
 *
 * The reading was discarded. The turn never reached the composer and was never persisted to
 * `messages`. He got unrelated meeting prep, then "Okay, I've seen that.", and when he asked
 * "what you have seen?" — "I found it, but I couldn't get a clear read on its status."
 * Brain claiming a reading it had thrown away.
 *
 * `pending-prompt-eats-command` is the 4th occurrence. The two previous fixes both narrowed
 * WHICH replies may be consumed — a regex prefilter, then an LLM relevance gate. Both asked
 * "is this an answer?"; neither asked "does consuming this DESTROY something?". So the rule
 * under test is structural, not another narrowing: an observation marker means the turn is
 * evidence, evidence is not an answer, and it is declined BEFORE the classifier runs — which is
 * why the classifier below is asserted never to have been called at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const classify = vi.fn();
const findMany = vi.fn();

vi.mock('../src/services/brainPrompts/promptReplyRelevance', () => ({
  classifyPromptReplyRelevance: (...a: any[]) => classify(...a),
  mayConsumeAsAnswer: (v: any) => !!v && v.relevance === 'answers_pending_prompt',
  mayConsumePartially: () => false,
}));
vi.mock('../src/services/brainPrompts/brainPromptQueueService', () => ({
  getAnswerableQuestions: (...a: any[]) => findMany(...a),
  getAwaitingPrompt: vi.fn().mockResolvedValue(null),
  recordAnswer: vi.fn().mockResolvedValue(undefined),
  reopenForAnswer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/services/behaviorConfig', () => ({
  getBehaviorValue: async (k: string) => (k.includes('lookback') ? 24 : 5),
}));
vi.mock('../src/db/prisma', () => ({
  default: { openItem: { findFirst: vi.fn().mockResolvedValue(null) } },
}));

import { handlePromptReply } from '../src/services/brainPrompts/promptReplyHandler';

const IMAGE_TURN = 'see\n\n[image received — contents:]\nA browser showing the Connectors page. '
  + 'Gmail Connected, last sync 8/24/2026 5:06:11 PM. Google Calendar Connected. Google Chat Connected.';

describe('DEF-241 — an observation is evidence, not an answer', () => {
  beforeEach(() => {
    classify.mockReset();
    findMany.mockReset();
    // A pending question exists and the classifier WOULD confidently consume it — exactly the
    // 0.9 verdict from production. The guard must win anyway.
    findMany.mockResolvedValue([{
      id: 444, state: 'awaiting_reply', question: 'Did the DataEngine pipeline get fixed?',
      clientNumber: 'TMC-0001', sentAt: new Date(Date.now() - 2 * 60 * 1000), openItemId: null,
      // free_form_note is what production's prompt 444 actually carried; with the default
      // 'noop' the looksLikeAnswer prefilter rejects everything and the control cases would
      // pass for the wrong reason — proving nothing about the guard.
      sideEffect: { kind: 'free_form_note' },
    }]);
    classify.mockResolvedValue({ relevance: 'answers_pending_prompt', confidence: 0.9 });
  });

  it('does NOT consume the image turn that was eaten in production', async () => {
    const r = await handlePromptReply({ userId: 2, clientNumber: 'TMC-0001', text: IMAGE_TURN } as any);
    expect(r.handled).toBe(false);      // routed onward, contents intact
  });

  it('declines BEFORE the classifier, so no confidence score can override it', async () => {
    await handlePromptReply({ userId: 2, clientNumber: 'TMC-0001', text: IMAGE_TURN } as any);
    expect(classify).not.toHaveBeenCalled();
  });

  it('applies to a voice transcript too — the next observing channel inherits the rule', async () => {
    const r = await handlePromptReply({
      userId: 2, clientNumber: 'TMC-0001', text: 'yes\n\n[voice note]\nplease send it',
    } as any);
    expect(r.handled).toBe(false);
    expect(classify).not.toHaveBeenCalled();
  });

  // The controls below prove the guard is NARROW. They deliberately assert on whether the
  // handler gets as far as FETCHING candidates, not on whether it ultimately consumes: the
  // consumption path runs a prefilter, an LLM classifier and three state transitions, and
  // mocking all of that would test the mocks. Reaching the candidate fetch is the exact
  // observable that separates "the guard fired" from "the guard let this through".
  it('lets an ORDINARY reply through the guard — the feature is not disabled', async () => {
    await handlePromptReply({ userId: 2, clientNumber: 'TMC-0001', text: 'yes it is fixed' } as any);
    expect(findMany).toHaveBeenCalled();     // got past the guard, into normal correlation
  });

  it('never even looks for candidates when the turn carries evidence', async () => {
    await handlePromptReply({ userId: 2, clientNumber: 'TMC-0001', text: IMAGE_TURN } as any);
    expect(findMany).not.toHaveBeenCalled(); // declined before any correlation work
  });

  it('is not fooled by a human typing the bare word — only markers Brain mints count', async () => {
    await handlePromptReply({ userId: 2, clientNumber: 'TMC-0001', text: 'send me the [image] again' } as any);
    expect(findMany).toHaveBeenCalled();
  });
});
