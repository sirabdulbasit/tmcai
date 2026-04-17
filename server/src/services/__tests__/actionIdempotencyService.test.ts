import { describe, it, expect } from 'vitest';
import { generateKey } from '../actionIdempotencyService';

describe('actionIdempotencyService', () => {
  it('T3-KEY: generates consistent SHA-256 key for same inputs', () => {
    const params = {
      actionType: 'REPLY' as const,
      clientNumber: 'C001',
      userId: 1,
      referenceId: 'thread-123',
    };
    const k1 = generateKey(params);
    const k2 = generateKey(params);
    expect(k1).toBe(k2);
    expect(k1).toHaveLength(64); // SHA-256 hex = 64 chars
  });

  it('T3-DIFF: different tenants produce different keys for same item', () => {
    const base = { actionType: 'REPLY' as const, userId: 1, referenceId: 'thread-123' };
    const k1 = generateKey({ ...base, clientNumber: 'C001' });
    const k2 = generateKey({ ...base, clientNumber: 'C002' });
    expect(k1).not.toBe(k2);
  });

  it('T3-DISAMBIGUATOR: same action with different disambiguator produces different keys', () => {
    const base = { actionType: 'DELEGATE' as const, clientNumber: 'C001', userId: 1, referenceId: 'item-1' };
    const k1 = generateKey({ ...base, disambiguator: 'alice@example.com' });
    const k2 = generateKey({ ...base, disambiguator: 'bob@example.com' });
    expect(k1).not.toBe(k2);
  });

  it('T3-ACTIONTYPE: different action types on same item produce different keys', () => {
    const base = { clientNumber: 'C001', userId: 1, referenceId: 'item-1' };
    const k1 = generateKey({ ...base, actionType: 'REPLY' });
    const k2 = generateKey({ ...base, actionType: 'DELEGATE' });
    expect(k1).not.toBe(k2);
  });
});
