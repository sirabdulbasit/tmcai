import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findFirst, update, transitionStatus, enqueueBrainPrompt } = vi.hoisted(() => ({
  findFirst: vi.fn(),
  update: vi.fn(),
  transitionStatus: vi.fn(),
  enqueueBrainPrompt: vi.fn(),
}));

vi.mock('../src/db/prisma', () => ({
  default: { openItem: { findFirst, update } },
}));
vi.mock('../src/services/itemLifecycle/lifecycleService', () => ({ transitionStatus }));
vi.mock('../src/services/brainPrompts/brainPromptQueueService', () => ({ enqueueBrainPrompt }));

import { recordActionLifecycleReply } from '../src/services/openItems/actionLifecycleService';

const baseItem = {
  id: 'oi-1', clientNumber: 'TMC-0001', userId: 2,
  title: 'EXIM solution', status: 'DELEGATED', dueDate: new Date('2026-07-17T00:00:00Z'),
  metadata: {}, notes: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue({ ...baseItem });
  update.mockResolvedValue({ ...baseItem });
  transitionStatus.mockResolvedValue({ ok: true, from: 'DELEGATED', to: 'CLOSED' });
  enqueueBrainPrompt.mockResolvedValue({ status: 'sent_now', promptId: '1' });
});

describe('action lifecycle reply application', () => {
  it('closes a delegated item only with explicit completion evidence', async () => {
    const result = await recordActionLifecycleReply({
      openItemId: 'oi-1', clientNumber: 'TMC-0001', body: 'Documentation delivered.', source: 'whatsapp',
      interpretation: {
        outcome: 'completed', summary: 'All documentation was delivered.', newDeadline: null,
        delayReason: null, completionEvidence: 'Documentation delivered to Basit.',
        needsUserIntervention: false, confidence: 0.94,
      },
    });
    expect(transitionStatus).toHaveBeenCalledWith('oi-1', 'CLOSED', expect.objectContaining({
      actor: 'agent:action_lifecycle',
    }));
    expect(result).toMatchObject({ handled: true, closed: true, outcome: 'completed' });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        metadata: expect.objectContaining({ actionLifecycle: expect.objectContaining({ phase: 'completed' }) }),
      }),
    }));
  });

  it('records a new commitment and schedules the next check at that deadline', async () => {
    const due = new Date('2026-07-25T00:00:00.000Z');
    const result = await recordActionLifecycleReply({
      openItemId: 'oi-1', clientNumber: 'TMC-0001', body: 'Delayed by ITL; new date July 25.', source: 'email',
      interpretation: {
        outcome: 'in_progress', summary: 'Work continues after an ITL delay.', newDeadline: due,
        delayReason: 'Waiting for ITL', completionEvidence: null,
        needsUserIntervention: false, confidence: 0.9,
      },
    });
    expect(result.newDueDate).toBe(due.toISOString());
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        dueDate: due,
        metadata: expect.objectContaining({ actionLifecycle: expect.objectContaining({
          phase: 'monitoring', nextFollowUpAt: due.toISOString(), currentDelayReason: 'Waiting for ITL',
        }) }),
      }),
    }));
  });

  it('immediately involves the owner for an authority blocker', async () => {
    const result = await recordActionLifecycleReply({
      openItemId: 'oi-1', clientNumber: 'TMC-0001', body: 'Blocked pending budget approval.', source: 'whatsapp',
      interpretation: {
        outcome: 'blocked', summary: 'Budget approval is required.', newDeadline: null,
        delayReason: 'Budget approval pending', completionEvidence: null,
        needsUserIntervention: true, confidence: 0.96,
      },
    });
    expect(result.needsUserIntervention).toBe(true);
    expect(enqueueBrainPrompt).toHaveBeenCalledWith(expect.objectContaining({
      userId: 2, openItemId: 'oi-1', criticality: 'high',
      question: expect.stringContaining('Intervention needed'),
    }));
  });
});
