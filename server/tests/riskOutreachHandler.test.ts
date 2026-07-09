import { describe, it, expect, vi, beforeEach } from 'vitest';

// D3 — daily RiskFlagDoc was computed and filed, never surfaced: risks were
// discovered and silently archived. The notify_user_risk registry handler
// routes risk outreach through the executor — so it is autonomy-gated (D1,
// initiator:'brain'), audited as an AgentAction, and confirmed against the
// prompt queue (B2).

const enqueueMock = vi.fn(async () => ({ status: 'queued', promptId: 'bp_1' }));
const queueFindFirst = vi.fn();

vi.mock('../src/services/brainPrompts/brainPromptQueueService', () => ({
  enqueueBrainPrompt: (...a: any[]) => enqueueMock(...a),
}));
vi.mock('../src/db/prisma', () => ({
  default: { brainPromptQueue: { findFirst: (...a: any[]) => queueFindFirst(...a) } },
}));

import { NotifyUserRiskHandler } from '../src/services/actions/handlers/brain/notifyUserRisk';

const ctx = {
  clientNumber: 'tmc', userId: 2,
  payload: {
    docId: 'risk:tmc:2:2026-07-08',
    summary: '2 high-severity risks: FACL payment overdue; Haseeb silent 9 days.',
    highSeverityCount: 2,
  },
};

beforeEach(() => vi.clearAllMocks());

describe('NotifyUserRiskHandler', () => {
  it('execute enqueues a deduped high-criticality brain prompt', async () => {
    const h = new NotifyUserRiskHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(true);
    expect(enqueueMock).toHaveBeenCalledWith(expect.objectContaining({
      userId: 2, clientNumber: 'tmc',
      criticality: 'high',
      dedupKey: 'risk-outreach:risk:tmc:2:2026-07-08',
      question: expect.stringContaining('FACL payment overdue'),
    }));
    expect((out.output as any).dedupKey).toBe('risk-outreach:risk:tmc:2:2026-07-08');
  });

  it('execute treats queue dedup as ok (already surfaced today)', async () => {
    enqueueMock.mockResolvedValue({ status: 'duplicate', reason: 'dedup_key already queued' });
    const h = new NotifyUserRiskHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(true);
    expect((out.output as any).status).toBe('duplicate');
  });

  it('confirm re-reads the queue row by dedupKey — fail closed when absent', async () => {
    const h = new NotifyUserRiskHandler();
    queueFindFirst.mockResolvedValueOnce({ id: 'bp_1' });
    expect(await h.confirm(ctx as any, { dedupKey: 'risk-outreach:risk:tmc:2:2026-07-08' })).toBe(true);
    queueFindFirst.mockResolvedValueOnce(null);
    expect(await h.confirm(ctx as any, { dedupKey: 'risk-outreach:risk:tmc:2:2026-07-08' })).toBe(false);
  });

  it('validate rejects a payload without docId or summary', async () => {
    const h = new NotifyUserRiskHandler();
    const r = await h.validate({ ...ctx, payload: {} } as any);
    expect(r.valid).toBe(false);
  });
});
