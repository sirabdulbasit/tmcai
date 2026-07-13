import { describe, it, expect, vi } from 'vitest';
import { handlePiggybackedInstruction } from '../src/services/brainPrompts/piggybackedInstruction';

// A6 — a prompt reply like "tomorrow, and always remind me at 5pm" was
// consumed ONLY as a date answer; the piggybacked directive was lost.
// After the prompt side-effect resolves, the LLM extractor judges whether
// the message also carries an instruction (no regex stripping — the LLM
// is the decision boundary), and dispatches it if so.

const mk = (over: any = {}) => ({
  intent: 'add_open_item',
  confidence: 0.9,
  params: { itemTitle: 'remind at 5pm' },
  summary: 'Daily 5pm reminder',
  ...over,
});

describe('handlePiggybackedInstruction', () => {
  it('does not dispatch when extractor says none (plain answer)', async () => {
    const dispatch = vi.fn();
    const r = await handlePiggybackedInstruction({
      text: 'tomorrow', clientNumber: 'c1', userId: 2,
      deps: { extract: async () => mk({ intent: 'none', confidence: 0 }), dispatch },
    });
    expect(r.dispatched).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not dispatch below the confidence threshold', async () => {
    const dispatch = vi.fn();
    const r = await handlePiggybackedInstruction({
      text: 'tomorrow maybe remind me?', clientNumber: 'c1', userId: 2,
      deps: { extract: async () => mk({ confidence: 0.4 }), dispatch },
    });
    expect(r.dispatched).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches a confident directive and returns the ack', async () => {
    const dispatch = vi.fn(async () => ({ ok: true, message: 'Noted: daily 5pm reminder' }));
    const r = await handlePiggybackedInstruction({
      text: 'tomorrow, and always remind me at 5pm', clientNumber: 'c1', userId: 2,
      deps: { extract: async () => mk(), dispatch },
    });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      clientNumber: 'c1', userId: 2,
      instruction: expect.objectContaining({ intent: 'add_open_item' }),
    }));
    expect(r.dispatched).toBe(true);
    expect(r.ackMessage).toBe('Noted: daily 5pm reminder');
  });

  it('never throws — extractor failure yields no dispatch', async () => {
    const dispatch = vi.fn();
    const r = await handlePiggybackedInstruction({
      text: 'whatever', clientNumber: 'c1', userId: 2,
      deps: { extract: async () => { throw new Error('LLM down'); }, dispatch },
    });
    expect(r.dispatched).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});
