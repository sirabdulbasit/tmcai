/**
 * DEF-191 (Codex iteration-4 claim 3 / directive 5, the live half) — the
 * delegation follow-up job MUTATES and sends in the owner's name, so its
 * settings read must carry explicit authority: a (tenant, user) pair with NO
 * user row behind it HOLDS the item — it never chases under fabricated
 * default preferences.
 *
 * (The other half of directive 5 — tenant-scoping this job's global
 * enumeration and owner-identity lookup — is the pre-existing carried
 * CRITICAL, recorded OPEN in DEF-191's row for its own scoped turn.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  agentActionCreate: vi.fn(),
  resolveOpenItemsSettings: vi.fn(),
  decideChaseVerdict: vi.fn(),
  composeChaseEmail: vi.fn(),
  getUserNameAndEmail: vi.fn(),
  sendUserEmail: vi.fn(),
}));

vi.mock('../src/db/prisma', () => ({
  default: {
    openItem: { findMany: mocks.findMany, update: mocks.update },
    agentAction: { create: mocks.agentActionCreate },
  },
}));

vi.mock('../src/services/openItems/openItemsSettings', () => ({
  resolveOpenItemsSettings: mocks.resolveOpenItemsSettings,
}));

vi.mock('../src/services/delegation/smartChaseService', () => ({
  decideChaseVerdict: mocks.decideChaseVerdict,
  composeChaseEmail: mocks.composeChaseEmail,
  getUserNameAndEmail: mocks.getUserNameAndEmail,
}));

vi.mock('../src/services/gmailService', () => ({
  sendUserEmail: mocks.sendUserEmail,
}));

vi.mock('../src/utils/logger', () => ({
  default: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { runDelegationFollowUp } from '../src/jobs/delegationFollowUpJob';

function delegatedItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'del-1',
    title: 'ShireMe portal testing',
    status: 'DELEGATED',
    type: 'delegation',
    priority: 'medium',
    dueDate: null,
    delegateeEmail: 'hamna@example.com',
    delegateeName: 'Hamna',
    notes: [],
    metadata: { followUp: { count: 0, maxFollowUps: 3 } },
    createdAt: new Date(Date.now() - 7 * 86_400_000),
    updatedAt: new Date(Date.now() - 7 * 86_400_000),
    userId: 7,
    clientNumber: 'tenant-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockResolvedValue({});
  mocks.agentActionCreate.mockResolvedValue({});
  mocks.getUserNameAndEmail.mockResolvedValue({ name: 'Basit', email: 'basit@example.com' });
  mocks.decideChaseVerdict.mockResolvedValue({ verdict: 'hold', reason: 'not due (test)' });
});

describe('DEF-191 — delegation follow-up holds without settings authority', () => {
  it('a no_user pair is HELD: no verdict is even asked for, and nothing is sent', async () => {
    mocks.resolveOpenItemsSettings.mockResolvedValue({ authority: 'no_user', value: null });
    mocks.findMany.mockResolvedValue([delegatedItem()]);

    const summary = await runDelegationFollowUp();

    expect(summary.held).toBe(1);
    expect(summary.sent).toBe(0);
    expect(summary.errors).toBe(0);
    expect(mocks.decideChaseVerdict, 'no chase decision under fabricated authority').not.toHaveBeenCalled();
    expect(mocks.composeChaseEmail).not.toHaveBeenCalled();
    expect(mocks.sendUserEmail).not.toHaveBeenCalled();
  });

  it('a confirmed pair proceeds with HIS followUpDays, resolved under the item’s tenant', async () => {
    mocks.resolveOpenItemsSettings.mockResolvedValue({
      authority: 'found',
      value: { followUpDays: 5 },
    });
    mocks.findMany.mockResolvedValue([delegatedItem()]);

    await runDelegationFollowUp();

    expect(mocks.resolveOpenItemsSettings).toHaveBeenCalledWith(7, 'tenant-1');
    expect(mocks.decideChaseVerdict).toHaveBeenCalledTimes(1);
    expect(mocks.decideChaseVerdict.mock.calls[0][0].followUpDaysBaseline).toBe(5);
    expect(mocks.decideChaseVerdict.mock.calls[0][2], 'the verdict is asked under the item’s tenant')
      .toBe('tenant-1');
  });

  it('a thrown settings read is an error for that item, not a chase', async () => {
    mocks.resolveOpenItemsSettings.mockRejectedValue(new Error('settings db down'));
    mocks.findMany.mockResolvedValue([delegatedItem()]);

    const summary = await runDelegationFollowUp();

    expect(summary.errors).toBe(1);
    expect(mocks.decideChaseVerdict).not.toHaveBeenCalled();
    expect(mocks.sendUserEmail).not.toHaveBeenCalled();
  });
});
