/**
 * DEF-095 — Brain stops forgetting that it asked.
 *
 * Owner, 2026-08-07: *"if brain ask me any question from example ask the
 * priority of any item, after an hour when i reply to it with 'High Tomorrow'
 * it didnt corelated my this with his last message even i responded after
 * sometime don't you think it will read last n number message to correlated
 * what i had asked it"*.
 *
 * He was right, and the reality was narrower than he assumed. Correlation was
 * `findFirst({ where: { userId, state: 'awaiting_reply' } })` — ONE row, ONE
 * state, and no `orderBy` at all. Measured on production the moment he raised
 * it: **0 rows in `awaiting_reply`, 119 expired**. So a reply arriving an hour
 * later matched nothing, fell through to chat, and was re-read as a brand-new
 * instruction — which is exactly how "High immediate" became a task (DEF-093).
 *
 * Three properties are pinned here, because each failed independently:
 *   1. ordering is deterministic (was arbitrary — an answer could attach to the
 *      wrong question),
 *   2. expired questions are still answerable (expiry is Brain's bookkeeping,
 *      not the user's deadline),
 *   3. the search is scoped to (clientNumber, userId) — per-user under a
 *      tenant, never a global "the owner".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findMany = vi.hoisted(() => vi.fn());
const findFirst = vi.hoisted(() => vi.fn());
const updateMany = vi.hoisted(() => vi.fn());

vi.mock('../src/db/prisma', () => ({
  default: {
    brainPromptQueue: { findMany, findFirst, updateMany },
  },
}));

import {
  getAnswerableQuestions,
  getAwaitingPrompt,
  reviveExpiredPrompt,
} from '../src/services/brainPrompts/brainPromptQueueService';

beforeEach(() => {
  findMany.mockReset();
  findFirst.mockReset();
  updateMany.mockReset();
});

const row = (id: number, state: string, minutesAgo: number) => ({
  id: BigInt(id),
  state,
  clientNumber: 'TMC-0001',
  userId: 2,
  question: `q${id}`,
  sentAt: new Date(Date.now() - minutesAgo * 60_000),
  openItemId: null,
  sideEffect: { kind: 'set_priority' },
  criticality: 'routine',
  ackMessageId: null,
  metadata: null,
});

describe('DEF-095 — a late reply still finds the question it answers', () => {
  it('searches BOTH awaiting and expired questions', async () => {
    // The heart of the defect: 119 expired questions were invisible, so the
    // owner answering an hour later correlated to nothing.
    findMany.mockResolvedValue([]);
    await getAnswerableQuestions({ userId: 2, clientNumber: 'TMC-0001', lookbackHours: 24, limit: 5 });
    expect(findMany.mock.calls[0][0].where.state).toEqual({ in: ['awaiting_reply', 'expired'] });
  });

  it('scopes the search to BOTH tenant and user', async () => {
    // Owner instruction 2026-08-07: per-user under tenant/client, never a
    // hardcoded "the owner". An unscoped search here would be DEF-091 again.
    findMany.mockResolvedValue([]);
    await getAnswerableQuestions({ userId: 7, clientNumber: 'TMC-0009', lookbackHours: 24, limit: 5 });
    expect(findMany.mock.calls[0][0].where).toMatchObject({ userId: 7, clientNumber: 'TMC-0009' });
  });

  it('honours the look-back window rather than searching all history', async () => {
    findMany.mockResolvedValue([]);
    const before = Date.now();
    await getAnswerableQuestions({ userId: 2, clientNumber: 'TMC-0001', lookbackHours: 6, limit: 5 });
    const gte: Date = findMany.mock.calls[0][0].where.sentAt.gte;
    const hoursBack = (before - gte.getTime()) / 3_600_000;
    expect(hoursBack).toBeGreaterThan(5.9);
    expect(hoursBack).toBeLessThan(6.1);
  });

  it('puts still-awaiting questions ahead of expired ones, newest first', async () => {
    // A question still officially open is the better guess than one Brain has
    // already given up on, even if the expired one is more recent.
    findMany.mockResolvedValue([
      row(10, 'expired', 5),
      row(11, 'awaiting_reply', 90),
      row(12, 'expired', 1),
      row(13, 'awaiting_reply', 30),
    ]);
    const out = await getAnswerableQuestions({ userId: 2, clientNumber: 'TMC-0001', lookbackHours: 24, limit: 4 });
    expect(out.map((r) => Number(r.id))).toEqual([11, 13, 10, 12]);
  });

  it('respects the candidate cap — more candidates is more chances to be wrong', async () => {
    findMany.mockResolvedValue([row(1, 'awaiting_reply', 1), row(2, 'expired', 2), row(3, 'expired', 3)]);
    const out = await getAnswerableQuestions({ userId: 2, clientNumber: 'TMC-0001', lookbackHours: 24, limit: 2 });
    expect(out).toHaveLength(2);
  });

  it('orders the single-awaiting lookup deterministically', async () => {
    // Was unordered: with two questions outstanding, which one an answer
    // attached to was whatever Postgres returned first.
    findFirst.mockResolvedValue(null);
    await getAwaitingPrompt(2, 'TMC-0001');
    expect(findFirst.mock.calls[0][0].orderBy).toEqual([{ sentAt: 'desc' }, { id: 'desc' }]);
    expect(findFirst.mock.calls[0][0].where).toMatchObject({ userId: 2, clientNumber: 'TMC-0001' });
  });

  it('revives ONLY an expired row — never resurrects an answered one', async () => {
    // Guarded in the WHERE clause, not by the caller: an already-answered
    // question being dragged back to awaiting would re-ask the user something
    // they had settled.
    updateMany.mockResolvedValue({ count: 1 });
    await reviveExpiredPrompt(288);
    expect(updateMany.mock.calls[0][0].where).toMatchObject({ id: BigInt(288), state: 'expired' });
    expect(updateMany.mock.calls[0][0].data).toEqual({ state: 'awaiting_reply' });
  });
});
