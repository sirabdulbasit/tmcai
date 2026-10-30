/**
 * Vendored from @tmc/ai-integration c0a6ebe test/integrationPeriods.test.ts — imports re-pointed at
 * src/vendor/ai-integration (see src/vendor/ai-integration/VENDORED.md).
 */
/**
 * A feed's periods, written into a goal's own periods.
 *
 * A run used to write ONE cell per goal — the period the run happened in —
 * from the record for the current month. Attendance sends ten months per person:
 * each run overwrote this month's cell with the month so far, the run on the
 * 1st found the new month empty so last month was never finalised, and no
 * earlier month was ever filled. write every period, and
 * club the values per the goal's own period — month, quarter, half-year, year.
 *
 * The clubbing is the goal's own rule (sum, average or latest — the grid's),
 * never a guess: an average of months is not the model's to estimate.
 */
import { describe, it, expect } from 'vitest';
import { recordPeriod, goalCellFor, clubReadings } from '../src/vendor/ai-integration/mapping/periods';

describe('recordPeriod — what period a record is about', () => {
  it('reads a month however the source writes it', () => {
    expect(recordPeriod('Sep-2026')).toEqual({ year: 2026, month: 9 });
    expect(recordPeriod('2026-09')).toEqual({ year: 2026, month: 9 });
    expect(recordPeriod('09/2026')).toEqual({ year: 2026, month: 9 });
    expect(recordPeriod('2026-09-21')).toEqual({ year: 2026, month: 9 });
    expect(recordPeriod('September 2026')).toEqual({ year: 2026, month: 9 });
  });

  it('reads a quarter, a half-year and a year at their own grain', () => {
    expect(recordPeriod('Q3-2026')).toEqual({ year: 2026, quarter: 3 });
    expect(recordPeriod('2026 H2')).toEqual({ year: 2026, half: 2 });
    expect(recordPeriod('2026')).toEqual({ year: 2026 });
  });

  it('says it cannot tell rather than guess', () => {
    expect(recordPeriod('aai-2026-w39')).toBeNull();
    expect(recordPeriod('')).toBeNull();
    expect(recordPeriod(null)).toBeNull();
  });
});

describe('goalCellFor — which of the goal\'s cells a record fills', () => {
  it('puts a month into a monthly goal\'s month', () => {
    expect(goalCellFor('Monthly', { year: 2026, month: 8 })).toEqual({ seq: 8, label: 'Aug', frequency: 'MONTHLY' });
  });

  it('puts a month into the quarter, half-year or year that holds it', () => {
    expect(goalCellFor('Quarterly', { year: 2026, month: 8 })).toEqual({ seq: 3, label: 'Q3', frequency: 'QUARTERLY' });
    expect(goalCellFor('Bi-Annual', { year: 2026, month: 8 })).toEqual({ seq: 2, label: 'H2', frequency: 'BI-ANNUAL' });
    expect(goalCellFor('Annual', { year: 2026, month: 8 })).toEqual({ seq: 1, label: 'Year', frequency: 'ANNUAL' });
  });

  it('puts a quarter into a half-year or year, never into a month', () => {
    expect(goalCellFor('Bi-Annual', { year: 2026, quarter: 3 })).toEqual({ seq: 2, label: 'H2', frequency: 'BI-ANNUAL' });
    expect(goalCellFor('Monthly', { year: 2026, quarter: 3 })).toEqual({ error: 'finer' });
  });

  it('cannot split a month into weeks', () => {
    expect(goalCellFor('Weekly', { year: 2026, month: 8 })).toEqual({ error: 'finer' });
  });

  it('refuses a frequency it does not know rather than filing it as monthly', () => {
    // Two goals are stored as "Quaterly"; the grid shows them no cells at all.
    expect(goalCellFor('Quaterly', { year: 2026, month: 8 })).toEqual({ error: 'unknown_frequency' });
  });

  it('files a goal with no frequency as monthly, as the grid does', () => {
    expect(goalCellFor(null, { year: 2026, month: 8 })).toEqual({ seq: 8, label: 'Aug', frequency: 'MONTHLY' });
  });
});

describe('clubReadings — one value per cell, by the goal\'s own rule', () => {
  const r = (seq: number, label: string, period: string, value: number) =>
    ({ seq, label, frequency: 'QUARTERLY', period, value });

  it('adds up the months of a cumulative goal\'s quarter', () => {
    const out = clubReadings([r(3, 'Q3', '2026-07', 2), r(3, 'Q3', '2026-08', 3), r(3, 'Q3', '2026-09', 1)], 'sum');
    expect(out.cells).toEqual([{ seq: 3, label: 'Q3', frequency: 'QUARTERLY', value: 6 }]);
  });

  it('averages the months of a Stay Below goal\'s quarter', () => {
    const out = clubReadings([r(3, 'Q3', '2026-07', 2), r(3, 'Q3', '2026-08', 4)], 'mean');
    expect(out.cells[0]!.value).toBe(3);
  });

  it('keeps one cell per period, in order', () => {
    const out = clubReadings([r(3, 'Q3', '2026-07', 1), r(2, 'Q2', '2026-04', 5)], 'sum');
    expect(out.cells.map((c) => c.seq)).toEqual([2, 3]);
  });

  it('sets aside a cell fed twice for the same period, rather than choose', () => {
    const out = clubReadings([r(3, 'Q3', '2026-08', 1), r(3, 'Q3', '2026-08', 9), r(2, 'Q2', '2026-04', 5)], 'sum');
    expect(out.cells.map((c) => c.seq)).toEqual([2]);
    expect(out.duplicates).toEqual(['Q3']);
  });
});

/* ── the entry log ────────────────────────────────────────────────────────── */

import { integrationAuthor, changedCells } from '../src/vendor/ai-integration/mapping/periods';

describe('integrationAuthor — who an integration entry is by', () => {
  // The grid shows ⚡ and the integration's name for an author "INTEGRATION:<name>",
  // the convention every other integration write follows. A pull stored the
  // person who pressed it, and the entry read as typed by hand.
  it('names the integration, the way the grid recognises it', () => {
    expect(integrationAuthor('Attendance')).toBe('INTEGRATION:Attendance');
  });
});

describe('changedCells — only a period whose figure changed is written and logged', () => {
  const cells = [
    { seq: 1, label: 'Jan', frequency: 'MONTHLY', value: 0 },
    { seq: 2, label: 'Feb', frequency: 'MONTHLY', value: 3 },
    { seq: 3, label: 'Mar', frequency: 'MONTHLY', value: 1 },
  ];

  it('keeps a changed or new period with what it held before', () => {
    const out = changedCells(cells, new Map([[1, 0], [2, 1]]));
    expect(out).toEqual([
      { seq: 2, label: 'Feb', frequency: 'MONTHLY', value: 3, oldValue: 1 },
      { seq: 3, label: 'Mar', frequency: 'MONTHLY', value: 1, oldValue: null },
    ]);
  });

  it('writes nothing when every period already holds its figure', () => {
    expect(changedCells(cells, new Map([[1, 0], [2, 3], [3, 1]]))).toEqual([]);
  });

  it('treats a stored blank as a change', () => {
    expect(changedCells([cells[0]!], new Map([[1, null]]))).toHaveLength(1);
  });
});

/* ── only a period that has passed is written ───────────────────────────── */

import { cellClosed, lastClosedMonth } from '../src/vendor/ai-integration/mapping/periods';

describe('cellClosed — an integration writes a period only after it has passed', () => {
  // "period can only be closed when it has past";
  // "ignore open month figures if coming from integration". A Bench run wrote
  // October on 4 October, and Attendance wrote the month so far into October.
  const oct = { year: 2026, month: 10 };
  const m = (seq: number) => ({ seq, label: '', frequency: 'MONTHLY' });

  it('writes a month only after it ends', () => {
    expect(cellClosed(m(9), 2026, oct)).toBe(true);
    expect(cellClosed(m(10), 2026, oct)).toBe(false);
    expect(cellClosed(m(11), 2026, oct)).toBe(false);
  });

  it('writes a quarter or half-year only after its last month ends', () => {
    expect(cellClosed({ seq: 3, label: 'Q3', frequency: 'QUARTERLY' }, 2026, oct)).toBe(true);
    expect(cellClosed({ seq: 4, label: 'Q4', frequency: 'QUARTERLY' }, 2026, oct)).toBe(false);
    expect(cellClosed({ seq: 1, label: 'H1', frequency: 'BI-ANNUAL' }, 2026, oct)).toBe(true);
    expect(cellClosed({ seq: 2, label: 'H2', frequency: 'BI-ANNUAL' }, 2026, oct)).toBe(false);
  });

  it('writes a year only after the year ends', () => {
    expect(cellClosed({ seq: 1, label: 'Year', frequency: 'ANNUAL' }, 2026, { year: 2026, month: 12 })).toBe(false);
    expect(cellClosed({ seq: 1, label: 'Year', frequency: 'ANNUAL' }, 2025, { year: 2026, month: 1 })).toBe(true);
  });

  it('never writes a period of a future year', () => {
    expect(cellClosed(m(1), 2027, oct)).toBe(false);
  });
});

describe('lastClosedMonth — where a snapshot with no month is written', () => {
  it('is the month before the run', () => {
    expect(lastClosedMonth({ year: 2026, month: 10 })).toEqual({ year: 2026, month: 9 });
  });

  it('is last December for a run in January', () => {
    expect(lastClosedMonth({ year: 2026, month: 1 })).toEqual({ year: 2025, month: 12 });
  });
});
