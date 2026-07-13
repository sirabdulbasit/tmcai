import { describe, it, expect, vi, beforeEach } from 'vitest';

// A8 — instructions that don't match a structured intent used to fall
// through the dispatcher switch with ok:false and empty message: the
// "acknowledged but not saved" failure mode. Now: standing_instruction
// (and any unknown non-none intent the LLM emits) is persisted as a
// free-form active instruction so it reaches future prompts, and the
// ack names it. Never ack without persisting.

vi.mock('../src/services/knowledge/instructionService', () => ({
  createInstructionFromText: vi.fn(async (_cn: string, _uid: number, text: string) => ({
    id: 'wp_test_1',
    structured: { kind: 'standing_rule', title: text.slice(0, 60), originalText: text },
    scope: 'user',
  })),
}));

import { dispatchInstruction } from '../src/services/instructions/instructionDispatcher';
import { createInstructionFromText } from '../src/services/knowledge/instructionService';

const base = { clientNumber: 'c1', userId: 2 };

beforeEach(() => vi.clearAllMocks());

describe('dispatchInstruction — standing/unmatched instructions', () => {
  it('persists a standing_instruction and acks with its summary', async () => {
    const r = await dispatchInstruction({
      ...base,
      instruction: {
        intent: 'standing_instruction' as any,
        confidence: 0.9,
        params: { instructionText: 'always reply in English' } as any,
        summary: 'Always reply in English',
      },
    });
    expect(createInstructionFromText).toHaveBeenCalledWith('c1', 2, 'always reply in English', 'user');
    expect(r.ok).toBe(true);
    expect(r.artifactId).toBe('wp_test_1');
    expect(r.message).toContain('Always reply in English');
  });

  it('persists an UNKNOWN non-none intent instead of dropping it', async () => {
    const r = await dispatchInstruction({
      ...base,
      instruction: {
        intent: 'flag_urgency' as any, // novel intent the LLM invented
        confidence: 0.8,
        params: {} as any,
        summary: 'Flag messages above 80% urgency',
      },
    });
    expect(createInstructionFromText).toHaveBeenCalled();
    expect(r.ok).toBe(true);
    expect(r.message).toContain('Flag messages above 80% urgency');
  });

  it('never acks without persisting — persistence failure returns ok:false', async () => {
    (createInstructionFromText as any).mockResolvedValueOnce(null);
    const r = await dispatchInstruction({
      ...base,
      instruction: {
        intent: 'standing_instruction' as any,
        confidence: 0.9,
        params: { instructionText: 'x'.repeat(20) } as any,
        summary: 'Some rule',
      },
    });
    expect(r.ok).toBe(false);
  });

  it("leaves intent 'none' suppressed as before", async () => {
    const r = await dispatchInstruction({
      ...base,
      instruction: { intent: 'none', confidence: 0, params: {} as any, summary: '' },
    });
    expect(r.ok).toBe(false);
    expect(r.message).toBe('');
    expect(createInstructionFromText).not.toHaveBeenCalled();
  });
});
