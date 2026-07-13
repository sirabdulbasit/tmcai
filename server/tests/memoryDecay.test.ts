import { describe, it, expect, vi, beforeEach } from 'vitest';

// C5 — no job aged inferred memories: expiresAt was never enforced, stale
// preferences ossified, and confidence never changed after writing. The
// decay job: (1) expired rows go; (2) UNCONFIRMED INFERRED memories not
// touched in 30d lose confidence multiplicatively; (3) rows below the
// floor go entirely. Explicit or user-confirmed memories never decay —
// the user said so; only inferences fade like human impressions do.

const deleteMany = vi.fn(async () => ({ count: 1 }));
const updateManyRaw = vi.fn(async () => 3);

vi.mock('../src/db/prisma', () => ({
  default: {
    userMemory: { deleteMany: (...a: any[]) => deleteMany(...a) },
    $executeRawUnsafe: (...a: any[]) => updateManyRaw(...a),
  },
}));

import { decayUserMemories, DECAY_FACTOR, CONFIDENCE_FLOOR } from '../src/jobs/memoryDecayJob';

beforeEach(() => vi.clearAllMocks());

describe('decayUserMemories', () => {
  it('deletes rows past expiresAt', async () => {
    const now = new Date('2026-07-08T00:00:00Z');
    await decayUserMemories(now);
    expect(deleteMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ expiresAt: { not: null, lt: now } }),
    }));
  });

  it('decays only stale, unconfirmed, inferred memories via SQL multiply', async () => {
    await decayUserMemories(new Date());
    const sql = String(updateManyRaw.mock.calls.find((c) => /UPDATE user_memories/.test(String(c[0])))?.[0] ?? '');
    expect(sql).toContain(`confidence = confidence * ${DECAY_FACTOR}`);
    expect(sql).toContain(`source = 'inferred'`);
    expect(sql).toContain('confirmed_at IS NULL');
    expect(sql).toMatch(/updated_at\s*<\s*\$1/);
  });

  it('deletes rows that fell below the confidence floor', async () => {
    await decayUserMemories(new Date());
    expect(deleteMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        source: 'inferred',
        confirmedAt: null,
        confidence: { lt: CONFIDENCE_FLOOR },
      }),
    }));
  });

  it('reports counts and never throws on DB failure', async () => {
    deleteMany.mockRejectedValueOnce(new Error('db down'));
    const r = await decayUserMemories(new Date());
    expect(r.errors).toBeGreaterThan(0);
  });
});
