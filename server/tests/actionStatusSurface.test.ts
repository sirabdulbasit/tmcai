import { describe, it, expect, vi } from 'vitest';

// #14 (2026-07-14) — user-facing action statuses: honest wording,
// strict user scoping, no premature completion claims, retry disabled.

const rows: any[] = [
  { id: 1, clientNumber: 'TMC-0001', userId: 2, actionType: 'send_email', status: 'unconfirmed', createdAt: new Date(), updatedAt: new Date() },
  { id: 2, clientNumber: 'TMC-0001', userId: 2, actionType: 'send_whatsapp_message', status: 'stale', createdAt: new Date(), updatedAt: new Date() },
  { id: 3, clientNumber: 'TMC-0001', userId: 3, actionType: 'send_email', status: 'unconfirmed', createdAt: new Date(), updatedAt: new Date() }, // ANOTHER user
];

vi.mock('../src/db/prisma', () => ({
  default: {
    agentAction: {
      findMany: vi.fn(async (args: any) =>
        rows.filter((r) =>
          r.clientNumber === args.where.clientNumber &&
          r.userId === args.where.userId &&
          args.where.status.in.includes(r.status))),
    },
  },
}));

import { listUserActionStatuses, labelFor, rendersAsComplete, STATUS_LABELS } from '../src/services/actions/actionStatusService';

describe('listUserActionStatuses', () => {
  it('returns only the requesting user\'s actions — never another user\'s', async () => {
    const mine = await listUserActionStatuses('TMC-0001', 2);
    expect(mine.map((a) => a.id).sort()).toEqual([1, 2]);
    const theirs = await listUserActionStatuses('TMC-0001', 3);
    expect(theirs.map((a) => a.id)).toEqual([3]);
  });

  it('unconfirmed is NEVER rendered as complete, and retry stays disabled', async () => {
    const mine = await listUserActionStatuses('TMC-0001', 2);
    for (const a of mine) {
      expect(a.claimsCompletion).toBe(false);
      expect(a.retryEnabled).toBe(false);
      expect(a.statusLabel.toLowerCase()).not.toContain('complete');
      expect(a.statusLabel.toLowerCase()).not.toMatch(/^done\b/);
    }
  });
});

describe('wording contract', () => {
  it('distinguishes every required state honestly', () => {
    expect(labelFor('dispatched')).toBe('sent for execution');
    expect(labelFor('executing')).toBe('executing');
    expect(labelFor('done')).toBe('confirmed complete');
    expect(labelFor('unconfirmed')).toContain('confirmation unavailable');
    expect(labelFor('stale')).toContain('outcome unknown');
    expect(labelFor('error')).toBe('failed');
    expect(labelFor('martian_status')).toBe('outcome unknown'); // fail honest
  });

  it("only 'done' may ever read as completed", () => {
    for (const status of Object.keys(STATUS_LABELS)) {
      expect(rendersAsComplete(status)).toBe(status === 'done');
    }
  });
});
