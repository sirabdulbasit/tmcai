/**
 * DEF-170 / C-3 increment 1 — the number that proves the problem.
 *
 * CL-033: ten unactionable pushes from one unknown number in a single morning.
 * Self-Pruning scores 33 with `basis: absent`; suppression built before the
 * count exists would be a guess. This increment changes NO behaviour: it counts.
 *
 * ── THE INSTRUMENT'S OWN DEFECT HISTORY, BECAUSE IT SHAPES THESE TESTS ──────
 *
 * v1 (iter 25) grouped by producer label — five different items read as one
 * burst. v2 (iter 26) grouped sender-first — the SAME item pushed by three
 * subsystems became three groups, so the instrument could not produce the
 * cross-producer finding my build entry quoted; and it read a behaviorConfig
 * key that was NEVER REGISTERED, with tests that mocked the resolver — proving
 * a configuration path production could not take (Codex iteration-26 HIGH #1).
 *
 * So these tests drive the REAL behaviorConfig resolver. The only mocks are the
 * database and the tenant config store, which is what the resolver actually
 * reads. If the key disappears from BEHAVIOR_SPECS, the summariser THROWS here
 * — loudly, the way iteration 26 should have.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let rows: any[] = [];
let lastWhere: any = null;
/** delegation threads, for the thread→item canonicalisation join. */
let threads: Array<{ id: string; openItemId: string | null }> = [];
let threadLookupFails = false;
/** Every write attempted against any model. Must stay empty. */
const writes: string[] = [];
/** Tenant config the REAL behaviorConfig resolver reads. */
let tenantConfig: Record<string, unknown> = {};

vi.mock('../src/db/prisma', () => {
  const writeTrap = (name: string) => async () => { writes.push(name); return {}; };
  const brainPromptQueue = {
    findMany: async ({ where, cursor, skip, take }: any) => {
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
      }).sort((a, b) =>
        (a.sentAt.getTime() - b.sentAt.getTime()) || (a.id - b.id));
      // Cursor pagination is part of the contract under test (iteration-26
      // directive #4), so the mock implements it rather than ignoring it.
      let start = 0;
      if (cursor?.id !== undefined) {
        const idx = matched.findIndex((r) => r.id === cursor.id);
        start = idx >= 0 ? idx + (skip ?? 0) : matched.length;
      }
      return matched.slice(start, start + (take ?? matched.length));
    },
    create: writeTrap('brainPromptQueue.create'),
    update: writeTrap('brainPromptQueue.update'),
    updateMany: writeTrap('brainPromptQueue.updateMany'),
    deleteMany: writeTrap('brainPromptQueue.deleteMany'),
  };
  const delegationThread = {
    findMany: async ({ where }: any) => {
      if (threadLookupFails) throw new Error('thread join unavailable');
      const ids: string[] = where?.id?.in ?? [];
      return threads.filter((t) => ids.includes(t.id));
    },
  };
  const empty: any = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: writeTrap('other.create'), update: writeTrap('other.update'),
  };
  const p: any = new Proxy(
    { brainPromptQueue, delegationThread },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

// The REAL behaviorConfig runs; only the tenant config STORE it reads is
// substituted, which is the seam production itself goes through.
vi.mock('../src/services/configService', () => ({
  __esModule: true,
  getConfig: async (_client: string, key: string) => tenantConfig[key] ?? null,
}));

import {
  summariseInboundNoise, renderNoiseReport,
} from '../src/services/selfpruning/inboundNoiseLedger';
import { BEHAVIOR_SPECS, clearBehaviorCache } from '../src/services/behaviorConfig';

const NOW = new Date('2026-08-13T12:00:00Z');

let nextId = 1;
/** One push. `sentAt` = delivered. */
const push = (over: Record<string, any> = {}) => ({
  id: nextId++,
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

beforeEach(() => {
  rows = []; threads = []; threadLookupFails = false;
  writes.length = 0; lastWhere = null; nextId = 1;
  tenantConfig = {};
  clearBehaviorCache();
});

const summarise = (over: Record<string, any> = {}) =>
  summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW, ...over });

describe('DEF-170 — the SUBJECT is the unit, across producers', () => {
  it('2+2+2 pushes from three producers about ONE item are one six-push subject', async () => {
    // Codex iteration-26 directive #2's exact mutation case, and his HIGH #2
    // input: under sender-first grouping these were three groups of two, none
    // reached threshold, and the cross-producer drip vanished from `bursts`.
    const producers = ['action_lifecycle_governor', 'action_lifecycle_reply', 'action_status_update'];
    rows = producers.flatMap((source, p) => [0, 1].map((k) => push({
      openItemId: 'item-X',
      metadata: { source },
      sentAt: new Date(Date.parse('2026-08-13T09:00:00Z') + (p * 2 + k) * 10 * 60_000),
    })));
    const s = await summarise();

    expect(s.subjects).toHaveLength(1);
    const g = s.subjects[0];
    expect(g.subjectKey).toBe('item:item-X');
    expect(g.reached).toBe(6);
    expect(g.producers.map((x) => x.producer).sort()).toEqual([...producers].sort());
    expect(s.bursts, 'the drip is now visible as one dense subject').toHaveLength(1);
  });

  it('five distinct items stay five subjects, none a burst', async () => {
    rows = Array.from({ length: 5 }, (_, i) => push({
      openItemId: `item-${i}`,
      metadata: { source: 'preactive_due_nudge' },
      sentAt: new Date(Date.parse('2026-08-13T09:00:00Z') + i * 60_000),
    }));
    const s = await summarise();
    expect(s.subjects).toHaveLength(5);
    expect(s.bursts).toHaveLength(0);
  });

  it('a thread key is canonicalised to its item, so the subject does not split', async () => {
    // Codex MEDIUM #3: one row keyed by item, one by the thread OF that item.
    // Without the join these are two subjects and both undercount.
    threads = [{ id: 'thr-9', openItemId: 'item-X' }];
    rows = [
      push({ openItemId: 'item-X', metadata: { source: 'preactive_due_nudge' } }),
      push({ metadata: { source: 'delegation_capture', threadId: 'thr-9' } }),
      push({ metadata: { source: 'delegation_capture', threadId: 'thr-9' } }),
    ];
    const s = await summarise();
    expect(s.subjects).toHaveLength(1);
    expect(s.subjects[0].subjectKey).toBe('item:item-X');
    expect(s.subjects[0].reached).toBe(3);
    expect(s.canonicalisationFailed).toBe(false);
  });

  it('a failed thread join splits VISIBLY instead of throwing or merging blind', async () => {
    threadLookupFails = true;
    rows = [
      push({ openItemId: 'item-X' }),
      push({ metadata: { threadId: 'thr-9' } }),
    ];
    const s = await summarise();
    expect(s.subjects).toHaveLength(2);
    expect(s.canonicalisationFailed).toBe(true);
    expect(renderNoiseReport(s)).toMatch(/Thread→item lookup failed/);
  });
});

describe('DEF-170 — class aggregates are non-actionable BY CONSTRUCTION', () => {
  it('CL-033 is a sender FLOOD, present and quotable, and not in `bursts`', async () => {
    // Codex MEDIUM #4: the report warned in prose while the data contract let a
    // consumer suppress a class aggregate. Now `bursts` contains only exact
    // subjects, so the forbidden read does not exist.
    rows = cl033();
    const s = await summarise();

    expect(s.bursts).toHaveLength(0);
    expect(s.floods).toHaveLength(1);
    expect(s.floods[0].senderKey).toBe(CL033_FROM);
    expect(s.floods[0].reached).toBe(10);
    expect(s.floods[0].spanMinutes).toBe(45);

    const report = renderNoiseReport(s);
    expect(report).toMatch(/NOT auto-actionable/);
    expect(report, 'a quoted sample keeps the count checkable').toMatch(/"[^"]*Gsus[^"]*"/);
  });

  it('an engaged conversation is neither burst nor flood', async () => {
    rows = Array.from({ length: 5 }, (_, i) => push({
      metadata: { source: 'delegation_reply', from: '+923134199294' },
      answeredAt: new Date('2026-08-13T10:00:00Z'),
      sentAt: new Date(Date.parse('2026-08-13T09:00:00Z') + i * 60_000),
    }));
    const s = await summarise();
    expect(s.bursts).toHaveLength(0);
    expect(s.floods).toHaveLength(0);
  });
});

describe('DEF-170 — the span bound is REAL policy, through the real resolver', () => {
  it('the key is registered — an unregistered key is a build defect, not a fallback', async () => {
    // Codex HIGH #1: iteration 26 read this key without registering it, the
    // resolver threw, and a silent catch pinned the span to 1440 — the owner's
    // override could never take effect. The catch now RETHROWS unknown-key.
    expect(BEHAVIOR_SPECS['selfpruning.burst_max_span_minutes']).toBeDefined();
    expect(BEHAVIOR_SPECS['selfpruning.burst_max_span_minutes'].def).toBe(1440);
    expect(BEHAVIOR_SPECS['selfpruning.burst_max_span_minutes'].scope).toBe('tenant');
  });

  it('with no override, three unanswered pushes across 2 hours ARE a burst (default 1440)', async () => {
    rows = [0, 60, 120].map((min) => push({
      openItemId: 'item-hot',
      sentAt: new Date(Date.parse('2026-08-13T09:00:00Z') + min * 60_000),
    }));
    const s = await summarise();
    expect(s.burstMaxSpanMinutes).toBe(1440);
    expect(s.bursts).toHaveLength(1);
  });

  it("the owner's one-hour policy actually takes effect", async () => {
    // Codex's exact input: tenant sets 60; three pushes over two hours must NOT
    // be a burst. Under iteration 26 the override was silently ignored.
    tenantConfig['behavior.selfpruning.burst_max_span_minutes'] = 60;
    rows = [0, 60, 120].map((min) => push({
      openItemId: 'item-hot',
      sentAt: new Date(Date.parse('2026-08-13T09:00:00Z') + min * 60_000),
    }));
    const s = await summarise();
    expect(s.burstMaxSpanMinutes).toBe(60);
    expect(s.bursts, "the owner's policy was silently nonfunctional").toHaveLength(0);
  });

  it('an out-of-range override is clamped by the spec, not obeyed blindly', async () => {
    tenantConfig['behavior.selfpruning.burst_max_span_minutes'] = 5;   // below min 30
    rows = [push({ openItemId: 'item-x' })];
    const s = await summarise();
    expect(s.burstMaxSpanMinutes).toBe(30);
  });

  it('three unanswered notices a MONTH apart are a cadence, not a burst', async () => {
    rows = [0, 15, 29].map((day) => push({
      openItemId: 'item-monthly',
      sentAt: new Date(Date.parse('2026-07-14T09:00:00Z') + day * 24 * 60 * 60_000),
    }));
    const s = await summarise({ windowHours: 24 * 31 });
    expect(s.subjects[0].ignored).toBe(3);
    expect(s.bursts, 'a 43,000-minute span is not a flood').toHaveLength(0);
  });
});

describe('DEF-170 — the window measures DELIVERY', () => {
  it('queued before the window but delivered inside it IS counted', async () => {
    rows = [push({
      queuedAt: new Date('2026-08-12T20:00:00Z'),
      sentAt: new Date('2026-08-13T08:00:00Z'),
    })];
    const s = await summarise({ windowHours: 6 });
    expect(s.totalReached).toBe(1);
  });

  it('queued inside the window but delivered after `now` is NOT counted', async () => {
    rows = [push({
      queuedAt: new Date('2026-08-13T11:00:00Z'),
      sentAt: new Date('2026-08-13T13:00:00Z'),
    })];
    const s = await summarise({ windowHours: 6 });
    expect(s.totalReached).toBe(0);
    expect(lastWhere.sentAt).toEqual({ gte: s.since, lte: s.until });
  });
});

describe('DEF-170 — exact cap semantics, stable pagination', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => push({
    openItemId: `item-${i % 10}`,
    sentAt: new Date(Date.parse('2026-08-13T00:00:00Z') + i * 5_000),
  }));

  it('counts 1,200 rows completely across pages', async () => {
    rows = many(1200);
    const s = await summarise();
    expect(s.totalReached).toBe(1200);
    expect(s.truncated).toBe(false);
  });

  it('EXACTLY 5,000 rows is a complete count, not a floor', async () => {
    // Codex LOW #5: iteration 26 flagged truncation whenever the last page was
    // full, telling the owner a complete total was merely a floor.
    rows = many(5000);
    const s = await summarise();
    expect(s.totalReached).toBe(5000);
    expect(s.truncated, 'a complete count reported as a floor').toBe(false);
  });

  it('5,001 rows is truncated, capped, and says so', async () => {
    rows = many(5001);
    const s = await summarise();
    expect(s.totalReached).toBe(5000);
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
    const s = await summarise();
    expect(s.totalReached).toBe(10);
    expect(JSON.stringify([s.subjects, s.unattributed])).not.toContain('+999');
    expect(JSON.stringify([s.subjects, s.unattributed])).not.toContain('+888');
  });

  it('writes NOTHING — this increment changes no behaviour', async () => {
    threads = [{ id: 'thr-9', openItemId: 'item-X' }];
    rows = [...cl033(), push({ metadata: { threadId: 'thr-9' } })];
    await summarise();
    expect(writes, 'a read-only counter performed a write').toEqual([]);
  });

  it('a failed read throws rather than reporting a quiet inbox', async () => {
    rows = { filter() { throw new Error('database unavailable'); } } as any;
    await expect(summarise()).rejects.toThrow(/database unavailable/);
  });

  it('the report carries the definition that makes the number checkable', async () => {
    rows = cl033();
    const report = renderNoiseReport(await summarise());
    expect(report).toMatch(/"Delivered" =/);
    expect(report).toMatch(/OVERSTATES/);
  });

  it('reports an empty window as empty, not as an error', async () => {
    const s = await summarise();
    expect(s.totalReached).toBe(0);
    expect(renderNoiseReport(s)).toContain('Nothing reached you');
  });
});
