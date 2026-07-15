import { describe, it, expect, vi, beforeEach } from 'vitest';

// C3 — BrainFeedback.correctedOutput (the user literally rewriting Brain's
// output — the strongest correction signal there is) was written and never
// read. The distiller turns a correction into a GOVERNED MEMORY PROPOSAL:
// Brain-proposed → pending_approval → the user approves → active → injected
// on every prompt (C1 read path). Human approval replaces a statistical
// corroboration threshold — one strong correction may propose, the user
// gates whether it becomes durable.

const callLLMMock = vi.fn();
const proposeMemoryMock = vi.fn(async () => ({ id: 'gm_1', status: 'pending_approval' }));
const interactionFindFirst = vi.fn();

vi.mock('../src/services/llmRouter', () => ({ callLLM: (...a: any[]) => callLLMMock(...a) }));
vi.mock('../src/db/prisma', () => ({
  default: { brainInteractionLearningLog: { findFirst: (...a: any[]) => interactionFindFirst(...a) } },
}));

import { distillCorrection } from '../src/services/learning/correctionDistiller';

const base = {
  clientNumber: 'tmc', userId: 2, feedbackId: 'fb_1',
  correctedOutput: 'Sara — need the Q3 numbers by Friday. Thanks.',
  feedbackComment: 'too formal',
};

beforeEach(() => {
  vi.clearAllMocks();
  interactionFindFirst.mockResolvedValue({
    userPrompt: 'draft email to Sara about Q3 numbers',
    brainResponse: 'Dear Ms. Sara, I hope this finds you well...',
  });
  callLLMMock.mockResolvedValue({
    text: JSON.stringify({
      title: 'Email drafts: skip formal salutations',
      content: 'When drafting emails for the user, use direct casual openers, not "Dear X, I hope this finds you well".',
      confidence: 0.85,
    }),
  });
});

describe('distillCorrection', () => {
  it('distills a correction into a pending-approval governed memory proposal', async () => {
    const r = await distillCorrection({ ...base, interactionId: 'ix_1', proposeMemory: proposeMemoryMock });
    expect(callLLMMock).toHaveBeenCalled();
    expect(proposeMemoryMock).toHaveBeenCalledWith(expect.objectContaining({
      clientNumber: 'tmc', userId: 2,
      memoryType: 'correction_pattern',
      createdByBrain: true, // governance forces pending_approval
      title: 'Email drafts: skip formal salutations',
      sourceType: 'brain_feedback',
      sourceReferenceId: 'fb_1',
    }));
    expect(r.proposed).toBe(true);
  });

  it('does not propose below the confidence floor', async () => {
    callLLMMock.mockResolvedValue({ text: JSON.stringify({ title: 't', content: 'c', confidence: 0.3 }) });
    const r = await distillCorrection({ ...base, proposeMemory: proposeMemoryMock });
    expect(proposeMemoryMock).not.toHaveBeenCalled();
    expect(r.proposed).toBe(false);
  });

  it('skips empty corrections without an LLM call', async () => {
    const r = await distillCorrection({ ...base, correctedOutput: '   ', proposeMemory: proposeMemoryMock });
    expect(callLLMMock).not.toHaveBeenCalled();
    expect(r.proposed).toBe(false);
  });

  it('never throws — LLM failure yields no proposal', async () => {
    callLLMMock.mockRejectedValue(new Error('LLM down'));
    const r = await distillCorrection({ ...base, proposeMemory: proposeMemoryMock });
    expect(r.proposed).toBe(false);
  });
});
