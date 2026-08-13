/**
 * DEF-170 / C-3 increment 1 — the number that proves the problem.
 *
 * CL-033: ten unactionable pushes from one unknown number in a single morning,
 * all of which the owner had to read. *"A professional assistant does not hand
 * its principal ten copies of noise."*
 *
 * Self-Pruning scores 33 with `basis: absent`. Nothing in this codebase can
 * answer "how much of what I sent you was worth sending?", so suppression built
 * now would be a guess with no way to tell afterwards whether it helped. This
 * increment changes NO behaviour: it counts.
 *
 * ── THE TWO DEFINITIONS EVERYTHING RESTS ON ─────────────────────────────────
 *
 *   REACHED = `sent_at IS NOT NULL` — it went to a channel and he had to read it.
 *   ACTED   = `answered_at IS NOT NULL` — he replied.
 *
 * So `ignored` is an UPPER BOUND, not a measurement: acting without replying
 * (doing it himself, or deciding no) is indistinguishable here. That is fine for
 * finding a burst — ten pushes from one stranger with zero replies is noise on
 * any reading — and not fine as evidence about one message. The tests below pin
 * that the report SAYS so, because the failure mode this codebase keeps repeating
 * is a figure quoted without the definition that makes it checkable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let rows: any[] = [];
let lastWhere: any = null;
/** Every write attempted against any model. Must stay empty. */
const writes: string[] = [];

vi.mock('../src/db/prisma', () => {
  const writeTrap = (name: string) => async () => { writes.push(name); return {}; };
  const brainPromptQueue = {
    findMany: async ({ where }: any) => {
      lastWhere = where;
      return rows.filter((r) => {
        if (where.clientNumber && r.clientNumber !== where.clientNumber) return false;
        if (where.userId !== undefined && r.userId !== where.userId) return false;
        if (where.queuedAt?.gte && r.queuedAt < where.queuedAt.gte) return false;
        // `sentAt: { not: null }`
        if (where.sentAt && 'not' in where.sentAt && where.sentAt.not === null && !r.sentAt) return false;
        return true;
      });
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

import {
  summariseInboundNoise, renderNoiseReport,
} from '../src/services/selfpruning/inboundNoiseLedger';

const NOW = new Date('2026-08-13T12:00:00Z');

/** One push in the queue. `sentAt` present = it reached him. */
const push = (over: Record<string, any> = {}) => ({
  clientNumber: 'TMC-0001', userId: 2,
  question: 'A push',
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
  queuedAt: new Date(Date.parse('2026-08-13T09:05:00Z') + i * 5 * 60_000),
  sentAt: new Date(Date.parse('2026-08-13T09:05:00Z') + i * 5 * 60_000),
}));

beforeEach(() => { rows = []; writes.length = 0; lastWhere = null; });

describe('DEF-170 — it counts CL-033 the way the owner experienced it', () => {
  it('ten pushes from one stranger, none answered, reported as one burst', async () => {
    rows = cl033();
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });

    expect(s.totalReached).toBe(10);
    expect(s.totalActed).toBe(0);
    expect(s.totalIgnored).toBe(10);
    expect(s.bursts).toHaveLength(1);

    const b = s.bursts[0];
    expect(b.senderKey).toBe(CL033_FROM);
    expect(b.subjectClass).toBe('unattached_counterpart_reply');
    expect(b.reached).toBe(10);
    expect(b.ignored).toBe(10);
    // 09:05 to 09:50 — the span he actually lived through.
    expect(b.spanMinutes).toBe(45);
  });

  it('quotes his own messages back rather than asserting they were noise', async () => {
    rows = cl033();
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });
    const report = renderNoiseReport(s);

    expect(report).toContain(CL033_FROM);
    expect(report).toContain('10 pushes');
    expect(report, 'a quoted sample makes the count checkable').toMatch(/"[^"]*Gsus[^"]*"/);
  });

  it('the report carries the definition that makes the number checkable', async () => {
    // The specific discipline: "43 of 76" became a fact nobody could verify
    // because it travelled without its definition.
    rows = cl033();
    const report = renderNoiseReport(
      await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW }));

    expect(report).toMatch(/"Reached" =/);
    expect(report).toMatch(/OVERSTATES/);
    expect(report, 'the reader must be told acting-without-replying looks the same')
      .toMatch(/acting without replying|doing it yourself/i);
  });
});

describe('DEF-170 — what is NOT noise', () => {
  it('a conversation he engages with is not a burst', async () => {
    // Volume alone is not noise. Five pushes he answered every time are work.
    rows = Array.from({ length: 5 }, (_, i) => push({
      metadata: { source: 'delegation_reply', from: '+923134199294' },
      answeredAt: new Date('2026-08-13T10:00:00Z'),
      queuedAt: new Date(Date.parse('2026-08-13T09:00:00Z') + i * 60_000),
      sentAt: new Date(Date.parse('2026-08-13T09:00:00Z') + i * 60_000),
    }));
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });

    expect(s.totalReached).toBe(5);
    expect(s.totalActed).toBe(5);
    expect(s.bursts, 'engagement means it was worth sending').toHaveLength(0);
  });

  it('a push that never left the queue is not something he had to read', async () => {
    rows = [push({ sentAt: null }), push({ sentAt: null })];
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });
    expect(s.totalReached).toBe(0);
    expect(lastWhere.sentAt, 'the query itself must exclude unsent rows').toEqual({ not: null });
  });

  it('two different subjects from one sender are not ten copies of one thing', async () => {
    // Grouping on sender alone would call an ordinary day a burst.
    rows = [
      ...Array.from({ length: 3 }, () => push({ metadata: { source: 'followup_nudge', from: '+92300' } })),
      ...Array.from({ length: 3 }, () => push({ metadata: { source: 'delegation_reply', from: '+92300' } })),
    ];
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });
    expect(s.groups).toHaveLength(2);
    expect(s.groups.map((g) => g.subjectClass).sort()).toEqual(['delegation_reply', 'followup_nudge']);
  });

  it('a system nudge with no sender is attributed to its subsystem', async () => {
    rows = [push({ metadata: {}, sideEffect: { kind: 'free_form_note' } })];
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });
    expect(s.groups[0].senderKey).toBe('system:free_form_note');
  });
});

describe('DEF-170 — scope and safety', () => {
  it('is scoped to one tenant AND one owner', async () => {
    // Invariant #1. A noise report is about one person's inbox; a cross-tenant
    // total would be both wrong and a leak.
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

  it('respects the window', async () => {
    rows = [
      push({ queuedAt: new Date('2026-08-13T11:00:00Z'), sentAt: new Date('2026-08-13T11:00:00Z') }),
      push({ queuedAt: new Date('2026-08-01T09:00:00Z'), sentAt: new Date('2026-08-01T09:00:00Z') }),
    ];
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, windowHours: 6, now: NOW });
    expect(s.totalReached).toBe(1);
    expect(s.since.toISOString()).toBe('2026-08-13T06:00:00.000Z');
  });

  it('writes NOTHING — this increment changes no behaviour', async () => {
    // The increment's whole safety argument. If it ever writes, "no suppression,
    // no deletion, no behaviour change" stops being true.
    rows = cl033();
    await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });
    expect(writes, 'a read-only counter performed a write').toEqual([]);
  });

  it('a failed read throws rather than reporting a quiet inbox', async () => {
    // DEF-085: a broken query that returns "nothing" becomes a false statement
    // about the owner's inbox. Louder is correct here.
    rows = { filter() { throw new Error('database unavailable'); } } as any;
    await expect(summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW }))
      .rejects.toThrow(/database unavailable/);
  });

  it('reports an empty window as empty, not as an error', async () => {
    const s = await summariseInboundNoise({ clientNumber: 'TMC-0001', userId: 2, now: NOW });
    expect(s.totalReached).toBe(0);
    expect(renderNoiseReport(s)).toContain('Nothing reached you');
  });
});
