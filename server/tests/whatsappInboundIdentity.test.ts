import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryRaw = vi.fn();
vi.mock('../src/db/prisma', () => ({
  default: { $queryRawUnsafe: (...args: any[]) => queryRaw(...args) },
}));

import {
  resolveRegisteredWhatsAppUser,
  whatsappPhoneVariants,
} from '../src/services/whatsapp/inboundIdentity';

beforeEach(() => vi.clearAllMocks());

describe('canonical WhatsApp inbound identity', () => {
  it('creates E.164, digits and Pakistan-local variants once', () => {
    expect(whatsappPhoneVariants('+923226288256')).toEqual([
      '+923226288256', '923226288256', '03226288256',
    ]);
  });

  it('tenant-scopes identity and never passes undefined SQL parameters', async () => {
    queryRaw.mockResolvedValueOnce([{
      user_id: 2, connection_id: 7, display_name: 'Basit',
      user_name: 'Abdul Basit', client_number: 'TMC-0001', department: 'MD',
    }]);
    const user = await resolveRegisteredWhatsAppUser('TMC-0001', '+923226288256');
    expect(user).toMatchObject({ userId: 2, connectionId: 7, displayName: 'Basit' });
    expect(queryRaw.mock.calls[0].slice(1)).not.toContain(undefined);
    expect(queryRaw.mock.calls[0][1]).toBe('TMC-0001');
  });

  it('returns null for an unregistered sender', async () => {
    queryRaw.mockResolvedValueOnce([]);
    await expect(resolveRegisteredWhatsAppUser('TMC-0001', '+19999999999')).resolves.toBeNull();
  });
});
