/**
 * DEF-274 — Brain asked him a question, then ate his answer to it.
 *
 * CL-044, 19:32: *"can you list the the numbers?"* → *"Which numbers are you asking for, Sir?"*
 * → *"yes"* → **"Okay, I've noted that."** Then *"not me, who messaged you"* →
 * `[blocker recorded — intervention flagged]`.
 *
 * Verified from data, not inferred: prompts #487 and #491 carry `answered_at` at 19:32:49 and
 * 19:32:58. **Both were legitimately answerable** — genuinely delivered (10:09 and 12:11), inside
 * the lookback, past both existing gates. Nothing about them was wrong. The hole is that the
 * question Brain asked NINE SECONDS earlier was not a candidate at all, so the queue was the
 * only bidder.
 *
 * `pending-prompt-eats-command`, 4th occurrence. The guard comment in the file under test says
 * in writing that *"a third narrowing of the classifier would produce a fifth occurrence"* — so
 * the test that matters most here is the LAST one: the fix must not be able to starve the queue.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const rawQuery = vi.fn();
const promptFindFirst = vi.fn();
const getAnswerable = vi.fn();
const classify = vi.fn();

vi.mock('../src/db/prisma', () => ({
  default: {
    $queryRawUnsafe: (...a: any[]) => rawQuery(...a),
    brainPromptQueue: { findFirst: (...a: any[]) => promptFindFirst(...a) },
    openItem: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));
// Partial mock: only the two functions this test steers are replaced. Spreading the real module
// keeps every other export real, so the test cannot pass because of a mock that drifted from the
// module it stands in for.
vi.mock('../src/services/brainPrompts/brainPromptQueueService', async (importOriginal) => {
  const actual = await (importOriginal as any)();
  return {
    ...actual,
    getAnswerableQuestions: (...a: any[]) => getAnswerable(...a),
    recordAnswer: vi.fn().mockResolvedValue({}),
  };
});
vi.mock('../src/services/brainPrompts/promptReplyRelevance', () => ({
  classifyPromptReplyRelevance: (...a: any[]) => classify(...a),
  mayConsumeAsAnswer: () => true,
  mayConsumePartially: () => false,
}));
vi.mock('../src/services/behaviorConfig', () => ({
  getBehaviorValue: async (k: string) => (k === 'prompt_reply.lookback_hours' ? 24 : 5),
}));

import { handlePromptReply } from '../src/services/brainPrompts/promptReplyHandler';

const INPUT = { userId: 2, clientNumber: 'TMC-0001', text: 'yes' } as any;
const AT = new Date('2026-09-01T14:32:33Z');

const brainAsked = (content: string, at = AT) =>
  [{ direction: 'outbound', content, created_at: at }];

beforeEach(() => {
  vi.clearAllMocks();
  getAnswerable.mockResolvedValue([
    { id: 487n, question: 'Hi, this is a reminder that the "Provide Support" task…', sideEffect: { kind: 'noop' }, state: 'awaiting_reply', openItemId: null },
  ]);
  classify.mockResolvedValue({ verdict: 'answers', confidence: 0.9 });
  promptFindFirst.mockResolvedValue(null);   // no prompt delivered near that turn
});

describe('DEF-274 — a live conversation outranks a queued prompt', () => {
  it('does NOT consume the reply to a question Brain just asked', async () => {
    rawQuery.mockResolvedValue(brainAsked('Which numbers are you asking for, Sir? Are you referring to the phone numbers?'));
    const r = await handlePromptReply(INPUT);
    expect(r.handled).toBe(false);          // falls through to the composer, in context
  });

  it('declines BEFORE the classifier — no confidence score can override it', async () => {
    // DEF-241's shape. If the classifier is consulted at all, a future high-confidence verdict
    // reopens this bug.
    rawQuery.mockResolvedValue(brainAsked('Which numbers are you asking for, Sir?'));
    await handlePromptReply(INPUT);
    expect(classify).not.toHaveBeenCalled();
  });

  it('still consumes the answer to a PROMPT Brain delivered — the queue is not starved', async () => {
    // THE TEST THAT MATTERS. A prompt is delivered as an ordinary outbound message ending in
    // "?", so a naive "last turn was a question" rule would break prompt replies entirely.
    rawQuery.mockResolvedValue(brainAsked('When will "Provide Support for CGA Project" be done?'));
    promptFindFirst.mockResolvedValue({ id: 487n });   // a prompt WAS sent at that moment
    const r = await handlePromptReply(INPUT);
    expect(r.handled).toBe(true);
  });

  it('matches a prompt delivery by TIME, never by text', async () => {
    // The model owns the wording of every prompt it sends (standing rule), so the outbound text
    // is deliberately not comparable to the stored question.
    rawQuery.mockResolvedValue(brainAsked('Sir, any update on the CGA piece?'));
    promptFindFirst.mockResolvedValue({ id: 487n });
    const r = await handlePromptReply(INPUT);
    expect(r.handled).toBe(true);
    const where = promptFindFirst.mock.calls[0][0].where;
    expect(where.sentAt).toBeDefined();
    expect(where.clientNumber).toBe('TMC-0001');   // tenant-scoped, invariant #1
    expect(JSON.stringify(where)).not.toContain('question');
  });

  it('does not decline when Brain\'s last turn was a STATEMENT', async () => {
    rawQuery.mockResolvedValue(brainAsked('Noted, Sir. I have recorded that.'));
    const r = await handlePromptReply(INPUT);
    expect(r.handled).toBe(true);
  });

  it('does not decline when the last turn was the USER, not Brain', async () => {
    // Two messages from him in a row: there is no live question of Brain's to protect.
    rawQuery.mockResolvedValue([{ direction: 'inbound', content: 'actually hold on', created_at: AT }]);
    const r = await handlePromptReply(INPUT);
    expect(r.handled).toBe(true);
  });

  it('ignores the turn being handled when it is already stored', async () => {
    // The inbound is often written before the handler runs; it is not its own predecessor.
    rawQuery.mockResolvedValue([
      { direction: 'inbound', content: 'yes', created_at: new Date('2026-09-01T14:32:42Z') },
      { direction: 'outbound', content: 'Which numbers are you asking for, Sir?', created_at: AT },
    ]);
    const r = await handlePromptReply(INPUT);
    expect(r.handled).toBe(false);
  });

  it('is bounded to a recent window, so a stale question cannot block the queue forever', async () => {
    rawQuery.mockResolvedValue(brainAsked('Which numbers are you asking for, Sir?'));
    await handlePromptReply(INPUT);
    const sql = String(rawQuery.mock.calls.find((c) => String(c[0]).includes('whatsapp_messages'))?.[0] ?? '');
    expect(sql).toContain('minutes');
    expect(sql).toContain('ORDER BY created_at DESC');
  });

  it('falls through safely when the conversation cannot be read', async () => {
    // A failed lookup must not silently disable the queue.
    rawQuery.mockRejectedValue(new Error('db down'));
    const r = await handlePromptReply(INPUT);
    expect(r.handled).toBe(true);
  });

  it('survives a SYNCHRONOUS throw, not just a rejected promise', async () => {
    // The gap this test exists for: the first version guarded the call with `.catch()`, which
    // covers a rejection but not a call that throws before a promise exists. The DEF-241 suite
    // caught it — its prisma mock has no `$queryRawUnsafe` at all, so the call threw straight
    // through the reply path and would have cost the owner his answer entirely.
    rawQuery.mockImplementation(() => { throw new TypeError('not a function'); });
    const r = await handlePromptReply(INPUT);
    expect(r.handled).toBe(true);
  });
});
