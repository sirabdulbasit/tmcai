import { describe, it, expect, vi, beforeEach } from 'vitest';

// D2 — autonomy levels were static: no mechanism ever proposed promoting an
// action type from supervised toward full_auto as trust builds, so autonomy
// never graduated. The promotion job looks for action types the user has
// consistently approved and PROPOSES promotion via the Brain prompt queue —
// never auto-promotes silently (the user flips the level themselves).

const groupBy = vi.fn();
const findMany = vi.fn();
const enqueueMock = vi.fn(async () => ({ status: 'queued', promptId: 'bp_9' }));
const getLevelMock = vi.fn(async () => 'supervised');

vi.mock('../src/db/prisma', () => ({
  default: { agentAction: { groupBy: (...a: any[]) => groupBy(...a), findMany: (...a: any[]) => findMany(...a) } },
}));
vi.mock('../src/services/brainPrompts/brainPromptQueueService', () => ({
  enqueueBrainPrompt: (...a: any[]) => enqueueMock(...a),
}));
vi.mock('../src/services/brainConfigService', () => ({
  getAutomationLevel: (...a: any[]) => getLevelMock(...a),
}));

import { proposeTrustPromotions, PROMOTION_STREAK } from '../src/jobs/trustPromotionJob';

beforeEach(() => {
  vi.clearAllMocks();
  getLevelMock.mockResolvedValue('supervised');
});

const candidate = { clientNumber: 'tmc', userId: 2, actionType: 'send_email', _count: { _all: 12 } };

describe('proposeTrustPromotions', () => {
  it('proposes promotion after a clean approval streak', async () => {
    groupBy.mockResolvedValue([candidate]);
    findMany.mockResolvedValue(Array.from({ length: PROMOTION_STREAK }, () => ({ status: 'done' })));
    const r = await proposeTrustPromotions();
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 2, clientNumber: 'tmc',
      dedupKey: 'trust-promo:send_email',
      question: expect.stringContaining('send_email'),
    }));
    expect(r.proposed).toBe(1);
  });

  it('does not propose when the streak contains a rejection', async () => {
    groupBy.mockResolvedValue([candidate]);
    findMany.mockResolvedValue([
      { status: 'done' }, { status: 'rejected' },
      ...Array.from({ length: PROMOTION_STREAK - 2 }, () => ({ status: 'done' })),
    ]);
    const r = await proposeTrustPromotions();
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(r.proposed).toBe(0);
  });

  it('skips users already on full_auto', async () => {
    groupBy.mockResolvedValue([candidate]);
    findMany.mockResolvedValue(Array.from({ length: PROMOTION_STREAK }, () => ({ status: 'done' })));
    getLevelMock.mockResolvedValue('full_auto');
    const r = await proposeTrustPromotions();
    expect(enqueueMock).not.toHaveBeenCalled();
    expect(r.proposed).toBe(0);
  });

  it('never auto-promotes — the proposal is a prompt, nothing writes the level', async () => {
    groupBy.mockResolvedValue([candidate]);
    findMany.mockResolvedValue(Array.from({ length: PROMOTION_STREAK }, () => ({ status: 'done' })));
    await proposeTrustPromotions();
    // The only side effect is the queue enqueue; no config write exists in the job.
    expect(enqueueMock).toHaveBeenCalledTimes(1);
  });
});
