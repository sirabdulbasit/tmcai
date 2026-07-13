import { describe, it, expect, vi, beforeEach } from 'vitest';

// C4 — ClarificationMemory had write + lookup helpers but ZERO callers on
// the read side: the user answered "which Asad?" once, Brain recorded it,
// then asked again next time anyway. Before an 'ask' decision stands, the
// composer now checks memory; a hit becomes an injected context block and
// the reasoning pass re-runs with the resolution instead of re-asking.

const findResolutionMock = vi.fn();
vi.mock('../src/services/knowledge/clarificationMemoryService', () => ({
  findResolution: (...a: any[]) => findResolutionMock(...a),
  recordResolution: vi.fn(),
}));

import { buildClarificationInjection } from '../src/services/knowledge/reasoningCompose.applyDispatch';

const question = {
  text: 'Which Asad do you mean?',
  slotBeingFilled: 'which_contact',
  contextTokens: ['asad', 'send_email'],
};

beforeEach(() => vi.clearAllMocks());

describe('buildClarificationInjection', () => {
  it('returns an injection block when the slot was previously resolved', async () => {
    findResolutionMock.mockResolvedValue({
      resolutionValue: { answer: 'Asad Khan <asad.khan@tmcltd.com>' },
      usedCount: 3,
    });
    const block = await buildClarificationInjection(2, question);
    expect(findResolutionMock).toHaveBeenCalledWith({
      userId: 2, slotBeingFilled: 'which_contact', contextTokens: ['asad', 'send_email'],
    });
    expect(block).toContain('which_contact');
    expect(block).toContain('Asad Khan <asad.khan@tmcltd.com>');
    expect(block).toContain('Do not re-ask');
  });

  it('returns null on a memory miss (the ask goes through)', async () => {
    findResolutionMock.mockResolvedValue(null);
    expect(await buildClarificationInjection(2, question)).toBeNull();
  });

  it('returns null when the question has no slot (nothing to match on)', async () => {
    expect(await buildClarificationInjection(2, { text: 'hm?', slotBeingFilled: '', contextTokens: [] } as any)).toBeNull();
    expect(findResolutionMock).not.toHaveBeenCalled();
  });

  it('never throws — lookup failure lets the ask go through', async () => {
    findResolutionMock.mockRejectedValue(new Error('db down'));
    expect(await buildClarificationInjection(2, question)).toBeNull();
  });
});
