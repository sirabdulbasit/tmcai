import { beforeEach, describe, expect, it, vi } from 'vitest';

const executeRaw = vi.fn();

vi.mock('../src/db/prisma', () => ({
  default: { $executeRawUnsafe: (...args: any[]) => executeRaw(...args) },
}));

import {
  mirrorNotifierCredentials,
  storeMetaWebhookSecret,
} from '../src/services/whatsapp/whatsappNotifierConfigMirror';

beforeEach(() => {
  vi.clearAllMocks();
  executeRaw.mockResolvedValue(1);
});

describe('Meta notifier / inbound provider isolation', () => {
  it('mirrors outbound credentials without changing an existing inbound provider or session', async () => {
    await mirrorNotifierCredentials({
      clientNumber: 'TMC-0001',
      phoneNumberId: 'meta-phone-id',
      accessToken: 'token',
      wabaId: 'waba',
    });

    expect(executeRaw).toHaveBeenCalledOnce();
    const [sql, ...params] = executeRaw.mock.calls[0];
    const conflictUpdate = String(sql).split('DO UPDATE SET')[1];

    expect(params).toEqual(['TMC-0001', 'meta-phone-id', 'token', 'waba']);
    expect(conflictUpdate).toContain('meta_phone_number_id');
    expect(conflictUpdate).not.toMatch(/\bprovider\s*=/);
    expect(conflictUpdate).not.toMatch(/\bstatus\s*=/);
    expect(conflictUpdate).not.toMatch(/\bconnected_number\s*=/);
    expect(conflictUpdate).not.toMatch(/\bqr_code\s*=/);
  });

  it('creates a missing shared row in safe webjs/disconnected state', async () => {
    await mirrorNotifierCredentials({
      clientNumber: 'TMC-0001', phoneNumberId: 'phone-id',
    });
    const sql = String(executeRaw.mock.calls[0][0]);
    expect(sql).toContain("VALUES ($1, 'webjs', $2, $3, $4, 'disconnected'");
  });

  it('rotates a webhook secret without silently activating Meta inbound', async () => {
    await storeMetaWebhookSecret('TMC-0001', 'verify-secret');
    const [sql, ...params] = executeRaw.mock.calls[0];
    const conflictUpdate = String(sql).split('DO UPDATE SET')[1];

    expect(params).toEqual(['TMC-0001', 'verify-secret']);
    expect(String(sql)).toContain("VALUES ($1, 'webjs', $2, 'disconnected'");
    expect(conflictUpdate).not.toMatch(/\bprovider\s*=/);
    expect(conflictUpdate).not.toMatch(/\bstatus\s*=/);
  });
});
