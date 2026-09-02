/**
 * DEF-261 — the deadline nag repeated every day, forever.
 *
 * Measured 2026-09-02: 71 due-nudges across 17 items, **16 ever answered**. Two items had been
 * asked about **8 days running with zero replies** (08-26 → 09-02); one reached 10. The dedup key
 * is `due-nudge:<item>:<today>`, so "one per item per day" was the only limit — an item nobody
 * answers was asked about again tomorrow, and the day after, indefinitely.
 *
 * That is not just irritating, it is what starves the channel. Those nudges are `high` when
 * overdue, DEF-277 established the queue drains roughly one prompt per in-flight cycle, and on
 * 2026-09-01 two of the owner's REAL relayed messages were pushed out of the daily cap by
 * housekeeping. As of this test being written, `wa_counterpart_message suppressed` rows are still
 * appearing while draft-asks consume the budget.
 *
 * **Silence is an answer.** Asking a ninth time is not persistence, it is noise, and it costs the
 * messages that matter.
 */
import { describe, it, expect } from 'vitest';
import {
  nudgeGapDays, consecutiveUnansweredNudges, mayNudgeNow, MAX_NUDGE_GAP_DAYS,
} from '../src/services/brain/preactiveEngine';

const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
const q = (days: number, state = 'queued') => ({ state, queuedAt: ago(days) });

describe('DEF-261 — the gap widens with each unanswered ask', () => {
  it('asks immediately when it has never asked', () => {
    expect(mayNudgeNow([]).may).toBe(true);
    expect(nudgeGapDays(0)).toBe(0);
  });

  it('doubles the wait each time nobody answers', () => {
    expect(nudgeGapDays(1)).toBe(1);
    expect(nudgeGapDays(2)).toBe(2);
    expect(nudgeGapDays(3)).toBe(4);
  });

  it('BACKS OFF rather than stopping — a real deadline must not go silent', () => {
    // A fortnight's holiday is not consent to drop the item. The floor is weekly, not never.
    expect(nudgeGapDays(9)).toBe(MAX_NUDGE_GAP_DAYS);
    expect(nudgeGapDays(50)).toBe(MAX_NUDGE_GAP_DAYS);
    expect(MAX_NUDGE_GAP_DAYS).toBeGreaterThan(0);
  });

  it('THE REGRESSION: the 8-days-running case is refused', () => {
    // Exactly what the data showed — asked yesterday, seven unanswered before it.
    const eightDaysOfSilence = [1, 2, 3, 4, 5, 6, 7, 8].map((d) => q(d));
    const v = mayNudgeNow(eightDaysOfSilence);
    expect(v.may).toBe(false);
    expect(v.unanswered).toBe(8);
    expect(v.reason).toContain('unanswered');
  });

  it('and asks again once the widened gap has actually elapsed', () => {
    // Backing off must not become never: after the gap, it asks.
    const old = [1, 2, 3].map((d) => q(d + 7));
    expect(mayNudgeNow(old).may).toBe(true);
  });

  it('RESETS the moment he replies — an answer re-earns the cadence', () => {
    // Consecutive, not total: his past silence must not be held against him forever.
    const answeredYesterday = [q(1, 'answered'), q(2), q(3), q(4), q(5)];
    expect(consecutiveUnansweredNudges(answeredYesterday)).toBe(0);
    expect(mayNudgeNow(answeredYesterday).may).toBe(true);
  });

  it('counts only the unanswered run at the top, not every row', () => {
    const mixed = [q(1), q(2), q(3, 'answered'), q(4), q(5)];
    expect(consecutiveUnansweredNudges(mixed)).toBe(2);
  });

  it('does not depend on the order rows arrive in', () => {
    // The query orders by queuedAt desc, but a decision this important should not rely on it:
    // the same SET must give the same answer however it is shuffled.
    const rows = [q(1), q(2), q(3, 'answered'), q(4)];
    const expected = consecutiveUnansweredNudges(rows);
    expect(expected).toBe(2);
    for (const perm of [[...rows].reverse(), [rows[2], rows[0], rows[3], rows[1]]]) {
      expect(consecutiveUnansweredNudges(perm as any)).toBe(expected);
    }
  });

  it('still asks a second time the next day — the first backoff is one day, not a week', () => {
    // Overcorrecting would be its own defect: one unanswered ask is not evidence of disinterest.
    expect(mayNudgeNow([q(1)]).may).toBe(true);
    expect(mayNudgeNow([q(0.2)]).may).toBe(false);
  });
});
