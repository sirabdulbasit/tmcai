/**
 * DEF-093 + DEF-094 — the two failures behind one bad night.
 *
 * Traced from production, 2026-08-07:
 *
 *   21:49  Brain → owner:  "what a priority and a deadline should I put on this?"
 *   21:14  owner → Brain:  "Item related to watcher"
 *          Brain → owner:  [update_open_item: couldn't parse dueDate "immediate"]
 *   22:09  owner → Brain:  "High immediate"
 *   17:09:25  prompt-reply-handler  handling prompt reply  promptId=288
 *   17:09:26  whatsapp:inbound      consumed as prompt reply  sideEffect=applied
 *   17:09:27  brain-prompts:piggyback  piggybacked directive dispatched  intent=add_open_item
 *
 * The correlation was RIGHT. One second later the piggyback extractor re-read
 * the same two words with no idea a question had been asked, judged them a new
 * instruction, and created an open item titled "High immediate".
 *
 * DEF-094 is the other half: "immediate" is not a parseable date to chrono, so
 * a perfectly normal human deadline was answered with "try a specific date".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handlePiggybackedInstruction } from '../src/services/brainPrompts/piggybackedInstruction';
import { resolveDate } from '../src/services/knowledge/dateResolver';

vi.mock('../src/services/userTimezoneService', () => ({
  getUserTimezoneOffset: async () => '+05:00',
  getTimezoneOffset: () => '+05:00',
  systemDefaultTimezone: () => 'Asia/Karachi',
}));

describe('DEF-093 — an answer to Brain\'s own question never becomes a task', () => {
  let extract: ReturnType<typeof vi.fn>;
  let dispatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    extract = vi.fn();
    dispatch = vi.fn();
  });

  it('passes the answered question through to the extractor', async () => {
    // The whole defect is that the extractor judged blind. If this context stops
    // being threaded, the "High immediate" bug returns and nothing else here
    // would catch it.
    extract.mockResolvedValue({ intent: 'none', confidence: 0, params: {}, summary: '' });
    await handlePiggybackedInstruction({
      text: 'High immediate',
      clientNumber: 'TMC-0001',
      userId: 2,
      answeredQuestion: 'What priority and deadline should I put on this?',
      deps: { extract, dispatch },
    });
    expect(extract).toHaveBeenCalledWith(expect.objectContaining({
      text: 'High immediate',
      answeredQuestion: 'What priority and deadline should I put on this?',
    }));
  });

  it('dispatches NOTHING when the message is purely an answer', async () => {
    extract.mockResolvedValue({ intent: 'none', confidence: 0, params: {}, summary: '' });
    const r = await handlePiggybackedInstruction({
      text: 'High immediate',
      clientNumber: 'TMC-0001',
      userId: 2,
      answeredQuestion: 'What priority and deadline should I put on this?',
      deps: { extract, dispatch },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(r.dispatched).toBe(false);
  });

  it('still rescues a genuine directive riding alongside the answer (A6 survives)', async () => {
    // The fix must not kill the feature it constrains. "Tomorrow, and always
    // remind me at 5pm" carries a real standing instruction after the answer.
    extract.mockResolvedValue({
      intent: 'create_reminder', confidence: 0.9, params: { at: '17:00' }, summary: 'daily 5pm reminder',
    });
    dispatch.mockResolvedValue({ ok: true, message: 'Standing reminder set for 5pm.' });
    const r = await handlePiggybackedInstruction({
      text: 'tomorrow, and always remind me at 5pm',
      clientNumber: 'TMC-0001',
      userId: 2,
      answeredQuestion: 'When is this due?',
      deps: { extract, dispatch },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(r.dispatched).toBe(true);
    expect(r.ackMessage).toContain('5pm');
  });

  it('respects the confidence floor — a hesitant read is not acted on', async () => {
    extract.mockResolvedValue({ intent: 'add_open_item', confidence: 0.4, params: {}, summary: 'maybe' });
    const r = await handlePiggybackedInstruction({
      text: 'High immediate', clientNumber: 'TMC-0001', userId: 2,
      answeredQuestion: 'What priority and deadline?',
      deps: { extract, dispatch },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(r.dispatched).toBe(false);
  });

  it('never lets extraction failure break the prompt-reply ack', async () => {
    extract.mockRejectedValueOnce(new Error('llm down'));
    const r = await handlePiggybackedInstruction({
      text: 'High immediate', clientNumber: 'TMC-0001', userId: 2,
      answeredQuestion: 'What priority and deadline?',
      deps: { extract, dispatch },
    });
    expect(r.dispatched).toBe(false);
  });
});

describe('DEF-094 — "immediate" is a deadline, not a parse error', () => {
  const ref = new Date('2026-08-07T12:00:00+05:00');
  const today = '2026-08-07';

  it.each([
    'immediate', 'immediately', 'ASAP', 'asap', 'a.s.a.p.',
    'as soon as possible', 'right away', 'right now', 'now',
    'urgent', 'urgently', 'today itself',
  ])('resolves %s to today instead of failing', async (phrase) => {
    expect(await resolveDate(phrase, 2, { referenceDate: ref })).toBe(today);
  });

  it.each(['abhi', 'foran', 'fauran', 'aaj', 'aaj hi'])(
    'resolves the Roman Urdu form %s — the owner mixes languages', async (phrase) => {
      expect(await resolveDate(phrase, 2, { referenceDate: ref })).toBe(today);
    });

  it('leaves ordinary date phrases working exactly as before', async () => {
    expect(await resolveDate('tomorrow', 2, { referenceDate: ref })).toBe('2026-08-08');
    expect(await resolveDate('2026-09-01', 2, { referenceDate: ref })).toBe('2026-09-01');
  });

  it('does NOT invent a date for genuinely vague words', async () => {
    // "Soon" is not a deadline. Turning it into today would be the fabrication
    // this codebase keeps fighting — better to ask than to guess.
    expect(await resolveDate('soon', 2, { referenceDate: ref })).toBeNull();
    expect(await resolveDate('shortly', 2, { referenceDate: ref })).toBeNull();
  });

  it('still returns null for real gibberish', async () => {
    expect(await resolveDate('qwertyuiop', 2, { referenceDate: ref })).toBeNull();
  });
});
