/**
 * DEF-304 — WHICH deadline asks the owner gets, when there are more drafts
 * than slots, and how many refusals it costs to find that out.
 *
 * Measured on production 2026-09-03: **79 DRAFT items**, a 20/day outbound cap
 * with 10 of it available to housekeeping, and `draft_slot_completion` ticking
 * **hourly** and attempting all 79 every tick. `brain_user_messages` held
 * **2,133 suppressed `open_item_draft_ask` rows in 24 hours** — 27 passes over
 * the same 79 items — for at most 10 delivered asks.
 *
 * Two defects, one measurement:
 *
 *  1. **Ordering.** `findMany` carried no `orderBy` at all, so the ten asks he
 *     received were the ten Postgres returned first. Which of his commitments
 *     Brain chased was decided by physical row layout. The cap was containing
 *     the volume correctly (DEF-296) while the production it shaped was
 *     arbitrary — which is why nothing looked wrong from the outside.
 *  2. **Retry classification.** The loop treated every non-send as transient
 *     and continued, which is right for "tenant notifier not configured" and
 *     wrong for a budget hold: that decision stands for the rest of the window,
 *     so the remaining 60-odd items were walked to rediscover a known fact,
 *     one audit row each.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  update: vi.fn(),
  brainContactsUser: vi.fn(),
}));

vi.mock('../src/db/prisma', () => ({
  default: { openItem: { findMany: mocks.findMany, update: mocks.update } },
}));

vi.mock('../src/services/notifications/brainOutboundService', () => ({
  brainContactsUser: mocks.brainContactsUser,
}));

vi.mock('../src/services/notifications/brainHumanComm', () => ({
  phraseDraftAsk: () => 'when is this due?',
  addressUser: async () => 'Basit',
  rememberPending: async () => {},
}));

vi.mock('../src/utils/logger', () => ({
  default: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { runOpenItemDraftAsk } from '../src/jobs/openItemDraftAskJob';

const DAY = 86_400_000;

/** A healthy draft: a real title, so the zombie policy returns `none` and the
 *  item reaches the ask rather than being quarantined. */
function draft(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Send the signed audit pack to Hamna (${id})`,
    description: 'agreed on the call',
    status: 'DRAFT',
    priority: 'medium',
    dueDate: null,
    delegateeId: null,
    delegateeName: 'Hamna Latif',
    delegateeEmail: null,
    notes: [],
    createdAt: new Date(Date.now() - 2 * DAY),
    clientNumber: 'TMC-0001',
    userId: 2,
    metadata: { draft: { missingSlots: ['dueDate'] } },
    ...overrides,
  };
}

const askedIds = () => mocks.brainContactsUser.mock.calls.map((c) => /\(([^)]+)\)/.exec(c[0].summary)![1]);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.update.mockResolvedValue({});
  mocks.brainContactsUser.mockResolvedValue({ sent: true });
});

describe('DEF-304 — the asks are ranked, not whatever the table returned first', () => {
  it('asks about the critical item before the medium one', async () => {
    // Mutation: delete the `drafts.sort(importanceOrder)` line and this dies —
    // the loop would preserve the mock's (i.e. the table's) order, which is the
    // production defect exactly.
    mocks.findMany.mockResolvedValue([
      draft('medium-first'),
      draft('critical-last', { priority: 'critical' }),
    ]);
    await runOpenItemDraftAsk();
    expect(askedIds()).toEqual(['critical-last', 'medium-first']);
  });

  it('ranks critical > high > medium > low, not alphabetically', async () => {
    // `priority` is a string column: ordered in SQL it sorts critical, high,
    // low, medium — putting `low` ahead of `medium`. That is why the rank is a
    // table rather than an ORDER BY.
    mocks.findMany.mockResolvedValue([
      draft('low', { priority: 'low' }),
      draft('medium', { priority: 'medium' }),
      draft('high', { priority: 'high' }),
      draft('critical', { priority: 'critical' }),
    ]);
    await runOpenItemDraftAsk();
    expect(askedIds()).toEqual(['critical', 'high', 'medium', 'low']);
  });

  it('within one priority, the nearest deadline first', async () => {
    mocks.findMany.mockResolvedValue([
      draft('later', { dueDate: new Date(Date.now() + 10 * DAY) }),
      draft('sooner', { dueDate: new Date(Date.now() + 1 * DAY) }),
    ]);
    await runOpenItemDraftAsk();
    expect(askedIds()).toEqual(['sooner', 'later']);
  });

  it('an item with no due date waits behind every item that can be late', async () => {
    // Mutation: treat a missing dueDate as 0 rather than MAX and this dies —
    // undated items would crowd out the dated ones, which is the reverse of
    // what a deadline sweep is for.
    mocks.findMany.mockResolvedValue([
      draft('undated'),
      draft('dated', { dueDate: new Date(Date.now() + 30 * DAY) }),
    ]);
    await runOpenItemDraftAsk();
    expect(askedIds()).toEqual(['dated', 'undated']);
  });

  it('oldest first as the tiebreak, so nothing is starved forever', async () => {
    mocks.findMany.mockResolvedValue([
      draft('new', { createdAt: new Date(Date.now() - 1 * DAY) }),
      draft('old', { createdAt: new Date(Date.now() - 8 * DAY) }),
    ]);
    await runOpenItemDraftAsk();
    expect(askedIds()).toEqual(['old', 'new']);
  });

  it('the query itself is deterministically ordered, so `take: 500` is stable', async () => {
    // The rank above is applied to whatever the query returned. An unordered
    // `take` of 500 out of a larger set is the same defect one level up: which
    // 500 get ranked would be arbitrary.
    mocks.findMany.mockResolvedValue([]);
    await runOpenItemDraftAsk();
    expect(mocks.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: { createdAt: 'asc' },
      take: 500,
    }));
  });
});

describe('DEF-304 — a budget hold ends the pass; a transient failure does not', () => {
  it('stops at the first budget refusal instead of walking the rest', async () => {
    // The production shape, scaled down: more drafts than budget. Before this,
    // all 79 were attempted and 79 suppressed rows were written to learn one
    // thing. Mutation: drop the `break` and this dies at 5 calls.
    mocks.findMany.mockResolvedValue([
      draft('a', { priority: 'critical' }), draft('b'), draft('c'), draft('d'), draft('e'),
    ]);
    mocks.brainContactsUser.mockResolvedValue({
      sent: false, reason: 'housekeeping_budget_exceeded (10/10 of 20)', suppressedBy: 'budget',
    });
    const result = await runOpenItemDraftAsk();
    expect(mocks.brainContactsUser).toHaveBeenCalledTimes(1);
    // And it says how many it chose not to attempt, so "no budget to ask with"
    // is distinguishable from "nothing to ask".
    expect(result.budgetHeld).toBe(5);
    expect(result.asked).toBe(0);
    // A budget hold is not an error — counting it as one would make a normal
    // busy day look like a broken sweep.
    expect(result.errors).toBe(0);
  });

  it('spends the budget it has on the ranked items before stopping', async () => {
    // Two slots, four candidates: the two that matter most are the two asked.
    mocks.findMany.mockResolvedValue([
      draft('m1'), draft('m2'),
      draft('crit', { priority: 'critical' }),
      draft('hi', { priority: 'high' }),
    ]);
    let budget = 2;
    mocks.brainContactsUser.mockImplementation(async () => (budget-- > 0
      ? { sent: true }
      : { sent: false, reason: 'housekeeping_budget_exceeded (10/10 of 20)', suppressedBy: 'budget' }));
    const result = await runOpenItemDraftAsk();
    expect(askedIds().slice(0, 2)).toEqual(['crit', 'hi']);
    expect(result.asked).toBe(2);
    expect(result.budgetHeld).toBe(2);
  });

  it('a NON-budget failure still retries next tick, item by item', async () => {
    // The failure the retry rule was written for: `sendViaNotifier` returning
    // ok:false because the tenant notifier is not configured. Every item must
    // still be attempted, and none may be stamped as asked.
    //
    // Mutation: broaden the stop to any `!sent` and this dies — one unconfigured
    // tenant would silently halt the whole sweep.
    mocks.findMany.mockResolvedValue([draft('a'), draft('b'), draft('c')]);
    mocks.brainContactsUser.mockResolvedValue({ sent: false, reason: 'no_phone' });
    const result = await runOpenItemDraftAsk();
    expect(mocks.brainContactsUser).toHaveBeenCalledTimes(3);
    expect(result.errors).toBe(3);
    expect(result.budgetHeld).toBe(0);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('branches on the VALUE, never on the wording of the reason', async () => {
    // `reason` is prose for a log and has already been reworded once — DEF-271
    // turned it into `${tier.label}_budget_exceeded`. A guard anchored on that
    // prose would have stopped guarding silently, which is a recorded pattern
    // in this codebase. So a budget hold whose prose says nothing recognisable
    // must still stop the pass.
    mocks.findMany.mockResolvedValue([draft('a'), draft('b'), draft('c')]);
    mocks.brainContactsUser.mockResolvedValue({
      sent: false, reason: 'some wording nobody has written yet', suppressedBy: 'budget',
    });
    await runOpenItemDraftAsk();
    expect(mocks.brainContactsUser).toHaveBeenCalledTimes(1);
  });
});
