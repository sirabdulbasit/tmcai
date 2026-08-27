/**
 * LLM spend over a day, a week, a month, or an arbitrary range.
 *
 * Owner, 2026-08-27: "i need this daily, weekly, monthly and with date range etc".
 *
 * Monthly was not a missing view — it was missing DATA. `recordSpend` pruned every day older
 * than 14, so the month before yesterday had already been deleted and no UI could have answered
 * the question. Measured first: 15 days occupied 5.1 KB (~0.34 KB/day), so 62 days costs ~21 KB.
 * Retention moved to 62; longer belongs in a real table, because every LLM call
 * read-modify-writes this whole row.
 *
 * The aggregation is asserted against a hand-built blob rather than production, so the sums are
 * checkable by eye: three days, two users, two providers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
vi.mock('../src/db/prisma', () => ({
  default: { systemConfig: { findUnique: (...a: any[]) => findUnique(...a) } },
}));

import { getSpendReport } from '../src/services/llmSpendService';

// 100 in + 100 out on gemini-flash per user-day, so every total is a round multiple.
const dayBlock = (calls: number) => ({
  2: { 'gemini-flash': { in: 100, out: 100, calls }, byPurpose: { triage: calls } },
  7: { 'gemini-flash': { in: 100, out: 100, calls }, byPurpose: { triage: calls } },
});

beforeEach(() => {
  findUnique.mockReset();
  findUnique.mockResolvedValue({
    value: JSON.stringify({
      '2026-08-24': dayBlock(1),
      '2026-08-25': dayBlock(2),
      '2026-08-26': dayBlock(3),
    }),
  });
});

describe('spend report over a window', () => {
  it('a single day reports only that day', async () => {
    const r = await getSpendReport('TMC-0001', '2026-08-25');
    expect(r.totals.calls).toBe(4);          // 2 users × 2 calls
    expect(r.days).toBe(1);
    expect(r.from).toBe('2026-08-25');
    expect(r.to).toBe('2026-08-25');
  });

  it('a range sums every day inside it, inclusive at both ends', async () => {
    const r = await getSpendReport('TMC-0001', '2026-08-24', '2026-08-26');
    expect(r.totals.calls).toBe(12);         // 2 users × (1+2+3)
    expect(r.totals.tokens).toBe(1200);      // 6 user-days × 200
    expect(r.days).toBe(3);
  });

  it('returns a per-day series so a range can be drawn, not just totalled', async () => {
    const r = await getSpendReport('TMC-0001', '2026-08-24', '2026-08-26');
    expect(r.series?.map((s) => s.day)).toEqual(['2026-08-24', '2026-08-25', '2026-08-26']);
    expect(r.series?.map((s) => s.calls)).toEqual([2, 4, 6]);
  });

  it('omits days with no activity rather than emitting zeros', async () => {
    // A quiet Sunday and a day before the connector existed are different facts, and only the
    // caller knows which it is looking at.
    const r = await getSpendReport('TMC-0001', '2026-08-01', '2026-08-31');
    expect(r.days).toBe(3);
    expect(r.series).toHaveLength(3);
  });

  it('merges a user across days instead of listing them twice', async () => {
    const r = await getSpendReport('TMC-0001', '2026-08-24', '2026-08-26');
    expect(r.users).toHaveLength(2);
    const u2 = r.users.find((u) => u.userId === 2);
    expect(u2?.totalCalls).toBe(6);          // 1 + 2 + 3
    expect(u2?.byPurpose.triage).toBe(6);    // purposes accumulate too
  });

  it('reversed arguments are read as a window, not as an empty one', async () => {
    const r = await getSpendReport('TMC-0001', '2026-08-26', '2026-08-24');
    expect(r.totals.calls).toBe(12);
    expect(r.from).toBe('2026-08-24');
  });

  it('a window with nothing in it totals zero and says so', async () => {
    const r = await getSpendReport('TMC-0001', '2026-07-01', '2026-07-31');
    expect(r.totals.calls).toBe(0);
    expect(r.days).toBe(0);
    expect(r.users).toHaveLength(0);
  });

  it('defaults to a single day when no window is given — existing callers unchanged', async () => {
    const r = await getSpendReport('TMC-0001');
    expect(r.from).toBe(r.to);
  });
});
