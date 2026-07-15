import { describe, it, expect, vi, beforeEach } from 'vitest';

// B3 — two idempotency-cache gaps:
//  1. FAILED results were cached: executeViaRegistry's closure returns
//     {ok:false} without throwing, storeKey cached it, and every retry for
//     7 days got the stale failure back without re-attempting.
//  2. Cached SUCCESSES were returned without re-confirming the side effect
//     still holds in the system of record.

const findUnique = vi.fn();
const upsert = vi.fn(async () => ({}));
vi.mock('../src/db/prisma', () => ({
  default: { actionIdempotencyLog: { findUnique: (...a: any[]) => findUnique(...a), upsert: (...a: any[]) => upsert(...a), deleteMany: vi.fn() } },
}));
vi.mock('../src/utils/redisClient', () => ({
  getRedis: () => ({
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
  }),
  REDIS_KEY_PATTERNS: { idempotency: (cn: string, k: string) => `idem:${cn}:${k}` },
  REDIS_TTL: { idempotencyHours: 24 },
}));

import { withIdempotency } from '../src/services/actionIdempotencyService';

const params = { actionType: 'REPLY' as any, clientNumber: 'tmc', userId: 2, referenceId: 'oi1', disambiguator: 'x' };
const future = new Date(Date.now() + 86400_000);

beforeEach(() => vi.clearAllMocks());

describe('B3 — idempotency cache', () => {
  it('re-confirms a cached success before returning it', async () => {
    findUnique.mockResolvedValue({ result: { ok: true, output: { messageId: 'm1' } }, expiresAt: future });
    const reconfirm = vi.fn(async () => true);
    const action = vi.fn();
    const r = await withIdempotency(params, action, { reconfirm });
    expect(reconfirm).toHaveBeenCalledWith({ ok: true, output: { messageId: 'm1' } });
    expect(action).not.toHaveBeenCalled();
    expect((r as any).ok).toBe(true);
  });

  it('re-executes when re-confirmation says the side effect did not stick', async () => {
    findUnique.mockResolvedValue({ result: { ok: true, output: { messageId: 'm1' } }, expiresAt: future });
    const reconfirm = vi.fn(async () => false);
    const action = vi.fn(async () => ({ ok: true, output: { messageId: 'm2' } }));
    const r = await withIdempotency(params, action, { reconfirm });
    expect(action).toHaveBeenCalled();
    expect((r as any).output.messageId).toBe('m2');
  });

  it('does not cache results the caller marks uncacheable (failures)', async () => {
    findUnique.mockResolvedValue(null);
    const action = vi.fn(async () => ({ ok: false, error: 'transient LLM timeout' }));
    await withIdempotency(params, action, { shouldCache: (r: any) => r?.ok === true });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('keeps legacy behavior without options: cached returned as-is, successes cached', async () => {
    findUnique.mockResolvedValue(null);
    const action = vi.fn(async () => ({ ok: true }));
    await withIdempotency(params, action);
    expect(upsert).toHaveBeenCalled();
  });
});
