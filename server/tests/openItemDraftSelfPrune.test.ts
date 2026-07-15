import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  brainContactsUser: vi.fn(),
}));

vi.mock('../src/db/prisma', () => ({
  default: {
    openItem: {
      findMany: mocks.findMany,
      update: mocks.update,
    },
  },
}));

vi.mock('../src/services/notifications/brainOutboundService', () => ({
  brainContactsUser: mocks.brainContactsUser,
}));

vi.mock('../src/utils/logger', () => ({
  default: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { runOpenItemDraftAsk } from '../src/jobs/openItemDraftAskJob';
import { SELF_PRUNE_POLICY_VERSION } from '../src/services/openItems/zombieItemPolicy';

function draft(overrides: Record<string, unknown> = {}) {
  return {
    id: 'draft-1',
    title: 'Exam solution of',
    description: null,
    status: 'DRAFT',
    priority: 'medium',
    dueDate: null,
    delegateeId: null,
    delegateeName: null,
    delegateeEmail: null,
    notes: [],
    createdAt: new Date(),
    clientNumber: 'tenant-1',
    userId: 7,
    metadata: { draft: { missingSlots: ['priority', 'dueDate'] } },
    ...overrides,
  };
}

describe('DRAFT job self-pruning integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.update.mockResolvedValue({});
    mocks.brainContactsUser.mockResolvedValue({ sent: true });
  });

  it('quarantines malformed residue and never sends a reminder', async () => {
    mocks.findMany.mockResolvedValue([draft()]);

    const result = await runOpenItemDraftAsk();

    expect(result).toMatchObject({ scanned: 1, quarantined: 1, asked: 0, selfPruned: 0, errors: 0 });
    expect(mocks.brainContactsUser).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'draft-1' },
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          selfPrune: expect.objectContaining({
            state: 'quarantined',
            suppressProactive: true,
          }),
        }),
      }),
    }));
  });

  it('soft-closes an unchanged quarantine after the grace period', async () => {
    mocks.findMany.mockResolvedValue([draft({
      metadata: {
        draft: { missingSlots: ['priority', 'dueDate'] },
        selfPrune: {
          version: SELF_PRUNE_POLICY_VERSION,
          state: 'quarantined',
          reason: 'dangling_fragment',
          suppressProactive: true,
          detectedAt: '2020-01-01T00:00:00.000Z',
          lastEvaluatedAt: '2020-01-01T00:00:00.000Z',
        },
      },
    })]);

    const result = await runOpenItemDraftAsk();

    expect(result).toMatchObject({ scanned: 1, selfPruned: 1, asked: 0, errors: 0 });
    expect(mocks.brainContactsUser).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'CLOSED',
        metadata: expect.objectContaining({
          archivedReason: 'zombie:dangling_fragment',
          selfPrune: expect.objectContaining({ state: 'archived' }),
        }),
      }),
    }));
  });
});
