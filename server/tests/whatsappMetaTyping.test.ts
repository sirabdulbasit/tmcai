import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
vi.mock('../src/db/prisma', () => ({
  default: { tenantWhatsappNotifier: { findUnique: (...args: any[]) => findUnique(...args) } },
}));

import { encrypt, sendTypingIndicatorViaNotifier } from '../src/services/notifications/whatsappNotifierService';

const originalFetch = global.fetch;
beforeEach(() => {
  vi.stubEnv('ENCRYPTION_KEY', 'test-encryption-key-long-enough');
  findUnique.mockResolvedValue({
    isActive: true, phoneNumberId: 'phone-id',
    accessTokenEncrypted: encrypt('secret-token'),
  });
});
afterEach(() => {
  global.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('Meta WhatsApp activity', () => {
  it('marks the exact inbound message read and requests native typing', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true })) as any;
    global.fetch = fetchMock;
    await expect(sendTypingIndicatorViaNotifier('TMC-0001', 'wamid.123'))
      .resolves.toEqual({ ok: true });
    const init = fetchMock.mock.calls[0][1];
    expect(JSON.parse(String(init.body))).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.123',
      typing_indicator: { type: 'text' },
    });
  });
});
