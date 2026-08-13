/**
 * DEF-170 / C-3 increment 1 — the number that proves the problem.
 *
 * CL-033: ten unactionable pushes from one unknown number in a single morning.
 * Self-Pruning scores 33 with `basis: absent`; suppression built before the
 * count exists would be a guess with no way to tell whether it helped. This
 * increment changes NO behaviour: it counts.
 *
 * ── WHAT ITERATION 26 CORRECTED, PER CODEX'S ITERATION-25 REVIEW ────────────
 *
 * The first version was measured against these tests and still wrong in ways
 * they could not see, because the tests shared its assumptions:
 *
 *   HIGH #1  it grouped by PRODUCER LABEL, so one due nudge each for five
 *            different items read as one five-push "burst". The unit is now the
 *            item/thread identity the row carries; rows with no identity fall
 *            into an explicit low-confidence bucket.
 *   HIGH #2  it windowed on `queuedAt` while the report claimed to describe
 *            delivery. The filter is now `sentAt` between since and until.
 *   MED  #3  `take: 500` ascending silently dropped the NEWEST rows for a busy
 *            owner. Paginated now, with a TRUNCATED flag at the hard cap.
 *   MED  #4  a "burst" had no density bound, so three monthly notices counted
 *            like three pushes in five minutes. A behaviorConfig-driven span
 *            bound applies.
 *   LOW  #5  the joined string key could collide (`a␟b + c` = `a + b␟c`).
 *            Nested maps now; no delimiter exists.
 *
 * The two definitions everything rests on:
 *   REACHED = `sent_at` within the window (delivered, so he had to read it).
 *   ACTED   = `answered_at IS NOT NULL` (he replied).
 * `ignored` is an UPPER BOUND, not a measurement, and the report says so.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let rows: any[] = [];
let lastWhere: any = null;
/** Every write attempted against any model. Must stay empty. */
const writes: string[] = [];

vi.mock('../src/db/prisma', () => {
  const writeTrap = (name: string) => async () => { writes.push(name); return {}; };
  const brainPromptQueue = {
    findMany: async ({ where, skip, take }: any) => {
      lastWhere = where;
      const matched = rows.filter((r) => {
        if (where.clientNumber && r.clientNumber !== where.clientNumber) return false;
        if (where.userId !== undefined && r.userId !== where.userId) return false;
        if (where.sentAt) {
          if (!r.sentAt) return false;
          if (where.sentAt.gte && r.sentAt < where.sentAt.gte) return false;
          if (where.sentAt.lte && r.sentAt > where.sentAt.lte) return false;
        }
        return true;
      }).sort((a, b) => (a.sentAt?.getTime() ?? 0) - (b.sentAt?.getTime() ?? 0));
      // Pagination is part of the contract under test (MEDIUM #3), so the mock
      // honours it rather than returning everything.
      return matched.slice(skip ?? 0, (skip ?? 0) + (take ?? matched.length));
    },
    create: writeTrap('brainPromptQueue.create'),
    update: writeTrap('brainPromptQueue.update'),
    updateMany: writeTrap('brainPromptQueue.updateMany'),
    deleteMany: writeTrap('brainPromptQueue.deleteMany'),
  };
  const empty: any = {
    findMany: async () => [], findFirst: async () => null,
    create: writeTrap('other.create'), update: writeTrap('other.update'),
  };
  const p: any = new Proxy({ brainPromptQueue }, { get: (t: any, k: string) => (k in t ? t[k] : empty) });
  return { __esModule: true, default: p, prisma: p };
});

// The burst span bound is behaviour-configured; injected so the tests do not
// depend on config lookups (D-8's standing rule). 1440 = the shipped default.
vi.mock('../src/services/behaviorConfig', () => ({
  __esModule: true, getBehaviorValue: async () => 1440,
}));

import {
  summariseInboundNoise, renderNoiseReport,
} from '../src/services/selfpruning/inboundNoiseLedger';

const NOW = new Date('2026-08-13T12:00:00Z');

/** One push. `sentAt` = delivered. */
const push = (over: Record<string, any> = {}) => ({
  clientNumber: 'TMC-0001', userId: 2,
  question: 'A push',
  openItemId: null,
  metadata: {}, sideEffect: {},
  queuedAt: new Date('2026-08-13T09:05:00Z'),
  sentAt: new Date('2026-08-13T09:05:00Z'),
  answeredAt: null,
  ...over,
});

/** CL-033's morning: ten pushes from one unknown number, none answered. */
const CL033_FROM = '+923001234567';
const cl033 = () => [
  'Gsus', 'Hello, peace be upon you.', 'First, you have blocked me on all numbers.',
  'Q Kya hwo', 'Ni bat karn to ok', 'Okby', 'Man ni ke cl', 'Passy nhi aya',
  'Asi numr', 'Kon',
].map((body, i) => push({
  question: `${CL033_FROM} replied: "${body}"`,
  metadata: { source: 'unattached_counterpart_reply', from: CL033_FROM, body },
  sentAt: new Date(Date.parse('2026-08-13T09:05:00Z') + i * 5 * 60_000),
}));

beforeEach(() => { rows = []; writes.length = 0; lastWhere = null; });

describe('DEF-170 — the measurement unit is the SUBJECT, not the producer', () => {
  it('five different items from one producer are five groups, not one burst', async () => {
    // Codex's HIGH #1, his input: one due nudge each for five open items. Under
    // the old key this was a five-push "burst" and increment 2 would have
    // digested a class in which every reminder was distinct and possibly useful.
    rows = Array.from({ length: 5 }, (_, i) => push({
      openItemId: `item-${i}`,
      metadata: { source: 'preactive_due_nudge' },
      sentAt: new Date(Date.parse('2026-08-13T09:00:00Z') + i * 60_000),
    }));
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });

    expect(s.groups).toHaveLength(5);
    expect(s.bursts, 'distinct subjects must never merge into a burst').toHaveLength(0);
    expect(s.groups.every((g) => g.subjectExact)).toBe(true);
  });

  it('ten repeats about ONE item are one burst', async () => {
    rows = Array.from({ length: 10 }, (_, i) => push({
      openItemId: 'item-leave-request',
      metadata: { source: 'preactive_due_nudge' },
      sentAt: new Date(Date.parse('2026-08-13T09:00:00Z') + i * 10 * 60_000),
    }));
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });

    expect(s.groups).toHaveLength(1);
    expect(s.bursts).toHaveLength(1);
    expect(s.bursts[0].subjectKey).toBe('item:item-leave-request');
    expect(s.bursts[0].subjectExact).toBe(true);
  });

  it('identity in metadata counts when the column is empty', async () => {
    rows = [
      push({ metadata: { source: 'delegation_capture', threadId: 'thr-9' } }),
      push({ metadata: { source: 'delegation_capture', threadId: 'thr-9' } }),
    ];
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].subjectKey).toBe('thread:thr-9');
  });

  it('rows with NO identity land in an explicit low-confidence bucket', async () => {
    // Codex directive #1: unknown-subject rows must be visible as such, because
    // a class-level aggregate is exactly what increment 2 must not suppress on.
    rows = [push({ metadata: { source: 'action_status_update' } })];
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });

    expect(s.groups[0].subjectKey).toBe('class:action_status_update');
    expect(s.groups[0].subjectExact).toBe(false);
    const report = renderNoiseReport(s);
    expect(report).toContain('(class-only)');
  });

  it('a class-only BURST is labelled as possibly spanning several subjects', async () => {
    rows = cl033();
    const report = renderNoiseReport(
      await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW }));
    expect(report).toMatch(/grouped by CLASS, not item/);
  });
});

describe('DEF-170 — the window measures DELIVERY', () => {
  // Codex's HIGH #2, both of his inputs.
  it('queued before the window but delivered inside it IS counted', async () => {
    rows = [push({
      queuedAt: new Date('2026-08-12T20:00:00Z'),   // before the 6h window
      sentAt: new Date('2026-08-13T08:00:00Z'),     // inside it
    })];
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, windowHours: 6, now: NOW });
    expect(s.totalReached, 'he read this during the window; it belongs in the report').toBe(1);
  });

  it('queued inside the window but delivered after `now` is NOT counted', async () => {
    rows = [push({
      queuedAt: new Date('2026-08-13T11:00:00Z'),
      sentAt: new Date('2026-08-13T13:00:00Z'),     // after now
    })];
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, windowHours: 6, now: NOW });
    expect(s.totalReached).toBe(0);
    expect(lastWhere.sentAt, 'the query itself must bound delivery on both sides')
      .toEqual({ gte: s.since, lte: s.until });
  });

  it('a push that never left the queue is not something he had to read', async () => {
    rows = [push({ sentAt: null }), push({ sentAt: null })];
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });
    expect(s.totalReached).toBe(0);
  });
});

describe('DEF-170 — a burst is volume AND disengagement AND density', () => {
  it('counts CL-033 the way the owner experienced it', async () => {
    rows = cl033();
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });

    expect(s.totalReached).toBe(10);
    expect(s.totalActed).toBe(0);
    expect(s.bursts).toHaveLength(1);
    expect(s.bursts[0].spanMinutes).toBe(45);

    const report = renderNoiseReport(s);
    expect(report).toContain(CL033_FROM);
    expect(report, 'a quoted sample makes the count checkable').toMatch(/"[^"]*Gsus[^"]*"/);
  });

  it('a conversation he engages with is not a burst', async () => {
    rows = Array.from({ length: 5 }, (_, i) => push({
      metadata: { source: 'delegation_reply', from: '+923134199294' },
      answeredAt: new Date('2026-08-13T10:00:00Z'),
      sentAt: new Date(Date.parse('2026-08-13T09:00:00Z') + i * 60_000),
    }));
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });
    expect(s.totalActed).toBe(5);
    expect(s.bursts, 'engagement means it was worth sending').toHaveLength(0);
  });

  it('three unanswered notices a MONTH apart are a cadence, not a burst', async () => {
    // Codex's MEDIUM #4, his input: sparse monthly status notices. Volume without
    // density must not classify; a digest policy built on it would conflate
    // repetition with flooding.
    rows = [0, 15, 29].map((day) => push({
      openItemId: 'item-monthly',
      metadata: { source: 'status_notice' },
      sentAt: new Date(Date.parse('2026-07-14T09:00:00Z') + day * 24 * 60 * 60_000),
    }));
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, windowHours: 24 * 31, now: NOW });

    expect(s.groups[0].reached).toBe(3);
    expect(s.groups[0].ignored).toBe(3);
    expect(s.groups[0].burst, 'a 43,000-minute span is not a flood').toBe(false);
    expect(s.bursts).toHaveLength(0);
  });

  it('the same three unanswered pushes inside an hour ARE a burst', async () => {
    rows = [0, 20, 40].map((min) => push({
      openItemId: 'item-hot',
      metadata: { source: 'status_notice' },
      sentAt: new Date(Date.parse('2026-08-13T09:00:00Z') + min * 60_000),
    }));
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });
    expect(s.bursts).toHaveLength(1);
  });
});

describe('DEF-170 — truthful pagination', () => {
  it('counts past the old 500-row cap instead of silently dropping the newest', async () => {
    // Codex's MEDIUM #3: ascending + take:500 dropped exactly the CURRENT rows
    // for the high-volume owner the detector exists to protect.
    rows = Array.from({ length: 1200 }, (_, i) => push({
      openItemId: `item-${i % 40}`,
      metadata: { source: 'preactive_due_nudge' },
      sentAt: new Date(Date.parse('2026-08-13T00:00:00Z') + i * 30_000),
    }));
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });
    expect(s.totalReached).toBe(1200);
    expect(s.truncated).toBe(false);
  });

  it('past the hard cap it says TRUNCATED rather than pretending', async () => {
    rows = Array.from({ length: 5600 }, (_, i) => push({
      openItemId: `item-${i % 10}`,
      sentAt: new Date(Date.parse('2026-08-13T00:00:00Z') + i * 5_000),
    }));
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });
    expect(s.truncated).toBe(true);
    expect(renderNoiseReport(s)).toMatch(/TRUNCATED/);
    expect(renderNoiseReport(s)).toMatch(/FLOOR, not a count/);
  });
});

describe('DEF-170 — scope, safety, honesty', () => {
  it('is scoped to one tenant AND one owner', async () => {
    rows = [
      ...cl033(),
      push({ clientNumber: 'TMC-0002', metadata: { from: '+999', source: 'x' } }),
      push({ userId: 99, metadata: { from: '+888', source: 'x' } }),
    ];
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });
    expect(s.totalReached).toBe(10);
    expect(lastWhere.clientNumber).toBe('TMC-0001');
    expect(lastWhere.userId).toBe(2);
    expect(JSON.stringify(s.groups)).not.toContain('+999');
    expect(JSON.stringify(s.groups)).not.toContain('+888');
  });

  it('the key cannot collide across the sender/subject boundary', async () => {
    // Codex's LOW #5. The colliding pair has to be built against the CURRENT
    // key shapes (`thread:` prefixes included): under any joined string key,
    // both of these produce `a␟thread:b␟thread:c` and merge. Nested maps leave
    // no delimiter to exploit, whatever prefixes the parts carry.
    rows = [
      push({ metadata: { from: 'a␟thread:b', threadId: 'c' } }),
      push({ metadata: { from: 'a', threadId: 'b␟thread:c' } }),
    ];
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });
    expect(s.groups).toHaveLength(2);
  });

  it('writes NOTHING — this increment changes no behaviour', async () => {
    rows = cl033();
    await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });
    expect(writes, 'a read-only counter performed a write').toEqual([]);
  });

  it('a failed read throws rather than reporting a quiet inbox', async () => {
    rows = { filter() { throw new Error('database unavailable'); } } as any;
    await expect(summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW }))
      .rejects.toThrow(/database unavailable/);
  });

  it('the report carries the definition that makes the number checkable', async () => {
    rows = cl033();
    const report = renderNoiseReport(
      await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW }));
    expect(report).toMatch(/"Delivered" =/);
    expect(report).toMatch(/OVERSTATES/);
    expect(report).toMatch(/acting without replying|doing it yourself/i);
  });

  it('reports an empty window as empty, not as an error', async () => {
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });
    expect(s.totalReached).toBe(0);
    expect(renderNoiseReport(s)).toContain('Nothing reached you');
  });
});
