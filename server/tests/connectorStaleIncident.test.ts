import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();
const updateMany = vi.fn();
const brainContactsUser = vi.fn();

vi.mock('../src/db/prisma', () => ({
  default: {
    userConnector: {
      findMany: (...args: any[]) => findMany(...args),
      updateMany: (...args: any[]) => updateMany(...args),
    },
  },
}));

vi.mock('../src/services/notifications/brainOutboundService', () => ({
  brainContactsUser: (...args: any[]) => brainContactsUser(...args),
}));

vi.mock('../src/services/behaviorConfig', () => ({
  getBehaviorValue: vi.fn(async () => 24),
}));

import { detectStaleConnectors } from '../src/services/connectorHealthService';

const oldSync = new Date(Date.now() - 24 * 60 * 60 * 1000);

beforeEach(() => {
  vi.clearAllMocks();
  brainContactsUser.mockResolvedValue({ sent: true });
});

describe('connector stale incident ownership', () => {
  it('does not manufacture Drive staleness when Drive has no automatic poller', async () => {
    findMany.mockResolvedValue([{
      id: 'drive-1', userId: 7, clientNumber: 'TMC-0001',
      connectorTypeId: 'ct_google_drive_personal', lastSyncAt: oldSync,
      metadata: {},
    }]);

    expect(await detectStaleConnectors()).toEqual({ scanned: 1, flipped: 0 });
    expect(updateMany).not.toHaveBeenCalled();
    expect(brainContactsUser).not.toHaveBeenCalled();
  });

  it('atomically claims a connected-to-stale transition before alerting', async () => {
    findMany.mockResolvedValue([{
      id: 'gmail-1', userId: 7, clientNumber: 'TMC-0001',
      connectorTypeId: 'ct_gmail', lastSyncAt: oldSync, metadata: {},
    }]);
    updateMany.mockResolvedValue({ count: 1 });

    expect(await detectStaleConnectors()).toEqual({ scanned: 1, flipped: 1 });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'gmail-1', status: 'connected' },
    }));
    expect(brainContactsUser).toHaveBeenCalledOnce();
  });

  it('does not alert when another process already claimed the transition', async () => {
    findMany.mockResolvedValue([{
      id: 'gmail-1', userId: 7, clientNumber: 'TMC-0001',
      connectorTypeId: 'ct_gmail', lastSyncAt: oldSync, metadata: {},
    }]);
    updateMany.mockResolvedValue({ count: 0 });

    expect(await detectStaleConnectors()).toEqual({ scanned: 1, flipped: 0 });
    expect(brainContactsUser).not.toHaveBeenCalled();
  });
});
