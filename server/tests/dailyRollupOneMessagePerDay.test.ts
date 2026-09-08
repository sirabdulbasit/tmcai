import { describe, it, expect, vi, beforeEach } from 'vitest';

// ONE MESSAGE PER DAY — owner ruling 2026-09-08 (CL-057 / DEF-325):
// "i should received one digest email per day instead of n number of email".
//
// The per-item policy could not deliver this and the numbers are why: it digests per ITEM
// and only from the 4th unanswered push about that item in 24h, while his traffic is ~2
// pushes per item. Turning `digest_enabled` on would have changed nothing while reading as
// a fix. These tests pin the rollup AND, more importantly, pin the two guards it must
// never be able to reach.

const count = vi.fn(async () => 0);
vi.mock('../src/db/prisma', () => ({
  default: { brainPromptQueue: { count: (...a: any[]) => count(...a) }, openItem: { findFirst: async () => null } },
}));

const behaviour: Record<string, number> = {};
vi.mock('../src/services/behaviorConfig', () => ({
  getBehaviorValue: async (key: string) => {
    if (key in behaviour) return behaviour[key];
    throw new Error(`unknown behavior key ${key}`);
  },
}));
vi.mock('../src/services/configService', () => ({ getConfig: async () => null }));

import { decideDigest } from '../src/services/selfpruning/digestPolicy';

const base = {
  clientNumber: '111', userId: 2, question: 'Your task is overdue.',
  criticality: 'routine' as const, openItemId: 'item-1',
  now: new Date('2026-09-08T12:00:00.000Z'),
};

beforeEach(() => {
  count.mockReset(); count.mockResolvedValue(0);
  for (const k of Object.keys(behaviour)) delete behaviour[k];
  behaviour['selfpruning.daily_rollup_enabled'] = 1;
  behaviour['selfpruning.digest_enabled'] = 0;
  behaviour['selfpruning.digest_after_pushes'] = 3;
  behaviour['selfpruning.digest_window_hours'] = 24;
});

describe('daily rollup — one message per user per day', () => {
  it('digests a routine push into a per-DAY key, not a per-item one', async () => {
    const d = await decideDigest({ ...base });
    expect(d.action).toBe('digest');
    expect(d.digest!.dedupKey).toBe('selfpruning:rollup:2:2026-09-08');
  });

  it('keys by USER and DAY, so two items on one day collapse to ONE message', async () => {
    const a = await decideDigest({ ...base, openItemId: 'item-1' });
    const b = await decideDigest({ ...base, openItemId: 'item-2' });
    expect(a.digest!.dedupKey).toBe(b.digest!.dedupKey);
  });

  it('rolls to a new key the next day, so "one per day" does not become one forever', async () => {
    const today = await decideDigest({ ...base });
    const tomorrow = await decideDigest({ ...base, now: new Date('2026-09-09T00:05:00.000Z') });
    expect(tomorrow.digest!.dedupKey).not.toBe(today.digest!.dedupKey);
    expect(tomorrow.digest!.dedupKey).toBe('selfpruning:rollup:2:2026-09-09');
  });

  it('fires on the FIRST push of the day — the per-item threshold does not gate it', async () => {
    count.mockResolvedValue(0);           // nothing sent yet today
    behaviour['selfpruning.digest_after_pushes'] = 3;
    const d = await decideDigest({ ...base });
    expect(d.action).toBe('digest');      // per-item policy would have said 'send'
  });
});

describe('daily rollup — the guards it must never reach', () => {
  it('NEVER muffles a high-criticality escalation', async () => {
    const d = await decideDigest({ ...base, criticality: 'high' });
    expect(d.action).toBe('send');
    expect(d.reason).toMatch(/never digested/);
  });

  it('NEVER muffles a top-criticality escalation', async () => {
    const d = await decideDigest({ ...base, criticality: 'top' });
    expect(d.action).toBe('send');
  });

  it('never digests a digest — the recursion cannot eat its own summary', async () => {
    const d = await decideDigest({ ...base, metadata: { source: 'selfpruning_digest' } });
    expect(d.action).toBe('send');
  });

  it('sends when the switch is off, so the default is unchanged behaviour', async () => {
    behaviour['selfpruning.daily_rollup_enabled'] = 0;
    const d = await decideDigest({ ...base });
    expect(d.action).toBe('send');
  });

  it('FAILS OPEN: a broken count sends rather than costing him a message', async () => {
    count.mockRejectedValue(new Error('db down'));
    const d = await decideDigest({ ...base });
    expect(d.action).toBe('send');
    expect(d.reason).toMatch(/fail open/);
  });

  it('never reports more unanswered than were sent', async () => {
    count.mockResolvedValue(4);
    const d = await decideDigest({ ...base });
    expect(d.digest!.coveredCount).toBe(4);
  });
});
