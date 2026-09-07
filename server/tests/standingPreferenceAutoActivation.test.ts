import { describe, it, expect, vi, beforeEach } from 'vitest';

// LESS HUMAN INTERVENTION — owner decision 2026-09-07: "then make it human
// intervention less".
//
// The gate on a governed memory used to be `createdByBrain`, which defaults to TRUE, so
// EVERY memory required a click and the "user-explicit memories can land active" path
// promised in proposeMemory's own docblock could never fire. Two memories sat in
// pending_approval from 07-14 and 08-07, Active Memories read (0), and `Learn` scored 42
// as the only capability with no movement all campaign.
//
// These tests pin the exact width of the loosening, because the danger is not that it
// fails — it is that it widens later without anyone noticing. Each one names the
// property it protects.

const create = vi.fn(async (...a: any[]) => ({ id: 'm1', status: a[0]?.data?.status }));

vi.mock('../src/db/prisma', () => ({
  default: { governedBrainMemory: { create: (...a: any[]) => create(...a) } },
}));

import { proposeMemory } from '../src/services/learning/learningService';

const base = {
  clientNumber: '111',
  userId: 2,
  memoryScope: 'user',
  memoryType: 'standing_preference',
  title: 'Always send text instead of voice notes',
  content: 'When sending messages, always use text instead of voice notes.',
  createdByBrain: true,
};

beforeEach(() => create.mockClear());

describe('proposeMemory — the self-activating class', () => {
  it('activates a high-confidence standing preference without a human', async () => {
    const r = await proposeMemory({
      ...base, sourceType: 'chat_standing_preference', confidenceScore: 1.0,
    });
    expect(r.status).toBe('active');
  });

  it('stamps approvedAt but NOT approvedBy, so a self-activation is distinguishable', async () => {
    await proposeMemory({
      ...base, sourceType: 'chat_standing_preference', confidenceScore: 1.0,
    });
    const data = (create.mock.calls[0] as any[])[0].data;
    expect(data.approvedAt).toBeInstanceOf(Date);
    expect(data.approvedBy).toBeUndefined();
  });

  it('accepts a Decimal-like confidence, not only a JS number', async () => {
    // confidence_score is Decimal(5,2) in the schema; a caller reading it back from the
    // database hands over an object, and `>= 0.9` on an object is silently false.
    const r = await proposeMemory({
      ...base, sourceType: 'chat_standing_preference',
      confidenceScore: { toString: () => '1.00' } as any,
    });
    expect(r.status).toBe('active');
  });
});

describe('proposeMemory — what still needs his click', () => {
  it('gates a sensitive memory even at confidence 1.0 — the rule that must not move', async () => {
    const r = await proposeMemory({
      ...base, sourceType: 'chat_standing_preference', confidenceScore: 1.0,
      sensitivityLevel: 'sensitive',
    });
    expect(r.status).toBe('pending_approval');
  });

  it('gates a critical memory even at confidence 1.0', async () => {
    const r = await proposeMemory({
      ...base, sourceType: 'chat_standing_preference', confidenceScore: 1.0,
      sensitivityLevel: 'critical',
    });
    expect(r.status).toBe('pending_approval');
  });

  it('gates below the 0.9 bar, which is higher than the 0.6 needed to propose', async () => {
    const r = await proposeMemory({
      ...base, sourceType: 'chat_standing_preference', confidenceScore: 0.7,
    });
    expect(r.status).toBe('pending_approval');
  });

  it('gates a source with no durability filter in front of it — the DEF-149 shape', async () => {
    // The correction distiller has no durability pre-filter and no "does this
    // generalise" distill. "Chase her again" was once filed as a preference when it was
    // an imperative to act; a source without those two filters must never self-activate.
    const r = await proposeMemory({
      ...base, sourceType: 'correction_distiller', confidenceScore: 1.0,
    });
    expect(r.status).toBe('pending_approval');
  });

  it('gates when no source is given at all', async () => {
    const r = await proposeMemory({ ...base, confidenceScore: 1.0 });
    expect(r.status).toBe('pending_approval');
  });

  it('leaves approvedAt null on anything it gates', async () => {
    await proposeMemory({ ...base, sourceType: 'correction_distiller', confidenceScore: 1.0 });
    expect((create.mock.calls[0] as any[])[0].data.approvedAt).toBeNull();
  });
});
