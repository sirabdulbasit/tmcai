import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock prisma + config/invite modules used by authService
vi.mock('../../db/prisma', () => ({
  default: {
    user: {
      findFirst: vi.fn(),
      update: vi.fn(async () => ({})),
    },
    session: { create: vi.fn(async () => ({})) },
  },
}));
vi.mock('../configService', () => ({
  getConfig: vi.fn(async () => null),
  encrypt: vi.fn(async (v: string) => v),
}));
vi.mock('../inviteService', () => ({
  sendPasswordChangedEmail: vi.fn(),
}));

import prisma from '../../db/prisma';
import { login } from '../authService';

const findFirst = (prisma as any).user.findFirst as ReturnType<typeof vi.fn>;

describe('login — H5 timing-equalisation', () => {
  beforeEach(() => {
    findFirst.mockReset();
  });

  it('returns invalid-credentials for a missing user (same shape as wrong-password)', async () => {
    findFirst.mockResolvedValue(null);
    const res = await login('ghost@example.com', 'anything');
    expect(res.success).toBe(false);
    expect(res.error).toBe('Invalid credentials');
    expect(res.locked).toBeUndefined();
  });

  it('takes a non-trivial amount of time when the user is missing (bcrypt dummy ran)', async () => {
    findFirst.mockResolvedValue(null);
    const t0 = Date.now();
    await login('ghost@example.com', 'anything');
    const elapsed = Date.now() - t0;
    // bcrypt.compare against a 12-round hash should take > 50ms even on a
    // fast machine. If we ever drop the dummy compare, this drops to <5ms
    // and the test fails, catching the regression.
    expect(elapsed).toBeGreaterThan(50);
  });

  it('still returns invalid-credentials (not "account disabled") when user isActive=false', async () => {
    findFirst.mockResolvedValue({ id: 1, isActive: false, passwordHash: 'x' });
    const res = await login('blocked@example.com', 'whatever');
    expect(res.success).toBe(false);
    expect(res.error).toBe('Invalid credentials');
  });
});
