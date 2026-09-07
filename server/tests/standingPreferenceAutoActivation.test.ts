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
const findMany = vi.fn(async () => [] as any[]);
const update = vi.fn(async () => ({}));

vi.mock('../src/db/prisma', () => ({
  default: {
    governedBrainMemory: {
      create: (...a: any[]) => create(...a),
      findMany: (...a: any[]) => findMany(...a),
      update: (...a: any[]) => update(...a),
    },
  },
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

// ── THE LEARN SWEEP ────────────────────────────────────────────────────────────
//
// Owner, 2026-09-07: "make it part of brain's capability (nightly cron)". The
// creation-time rule only helps memories created AFTER it existed; anything captured
// before stays pending forever and still needs a hand. The nightly runs this so the
// residue drains itself. These tests pin that it applies the SAME bar — a sweep with its
// own copy of the rule is how a gate ends up wider in the background than in the
// foreground.

import { sweepQualifyingMemories } from '../src/services/learning/learningService';

const row = (over: Record<string, any> = {}) => ({
  id: 'a', title: 'Always send text', sourceType: 'chat_standing_preference',
  confidenceScore: 1.0, sensitivityLevel: 'normal', ...over,
});

describe('sweepQualifyingMemories', () => {
  beforeEach(() => { findMany.mockReset(); update.mockReset(); update.mockResolvedValue({}); });

  it('activates a qualifying pending memory and reports it', async () => {
    findMany.mockResolvedValue([row()]);
    const r = await sweepQualifyingMemories();
    expect(r.activated).toBe(1);
    expect(r.titles).toEqual(['Always send text']);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('writes approvedBy NULL, so a swept row is not attributed to a human', async () => {
    findMany.mockResolvedValue([row()]);
    await sweepQualifyingMemories();
    const data = (update.mock.calls[0] as any[])[0].data;
    expect(data.status).toBe('active');
    expect(data.approvedBy).toBeNull();
    expect(data.approvedAt).toBeInstanceOf(Date);
  });

  it('never touches a sensitive memory, at any confidence', async () => {
    findMany.mockResolvedValue([row({ sensitivityLevel: 'sensitive', confidenceScore: 1.0 })]);
    const r = await sweepQualifyingMemories();
    expect(r.activated).toBe(0);
    expect(r.held).toBe(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('never touches a critical memory, at any confidence', async () => {
    findMany.mockResolvedValue([row({ sensitivityLevel: 'critical', confidenceScore: 1.0 })]);
    expect((await sweepQualifyingMemories()).activated).toBe(0);
    expect(update).not.toHaveBeenCalled();
  });

  it('holds a memory below the 0.9 bar', async () => {
    findMany.mockResolvedValue([row({ confidenceScore: 0.7 })]);
    expect((await sweepQualifyingMemories()).activated).toBe(0);
  });

  it('holds a source with no durability filter in front of it', async () => {
    findMany.mockResolvedValue([row({ sourceType: 'correction_distiller' })]);
    expect((await sweepQualifyingMemories()).activated).toBe(0);
  });

  it('reads ONLY pending_approval, which is what makes a second run in one night a no-op', async () => {
    findMany.mockResolvedValue([]);
    await sweepQualifyingMemories();
    expect((findMany.mock.calls[0] as any[])[0].where).toEqual({ status: 'pending_approval' });
  });

  it('--dry-run reports what it would do and writes nothing', async () => {
    findMany.mockResolvedValue([row()]);
    const r = await sweepQualifyingMemories({ dryRun: true });
    expect(r.activated).toBe(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('separates activated from held in one mixed sweep', async () => {
    findMany.mockResolvedValue([
      row({ id: 'a' }),
      row({ id: 'b', sensitivityLevel: 'critical' }),
      row({ id: 'c', confidenceScore: 0.5 }),
      row({ id: 'd', sourceType: 'correction_distiller' }),
    ]);
    const r = await sweepQualifyingMemories();
    expect({ scanned: r.scanned, activated: r.activated, held: r.held })
      .toEqual({ scanned: 4, activated: 1, held: 3 });
  });
});
