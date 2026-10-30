/**
 * Integration sync — a feed's periods, written into a goal's own periods.
 * ======================================================================
 *
 * A run used to write one cell per goal: the period the run happened in, from
 * the record for the current month. A feed that sends ten months per person
 * therefore had this month's cell overwritten with the month so far, last month
 * never finalised (the run on the 1st finds the new month empty), and no earlier
 * month filled. write every period, clubbed per the goal's
 * own period — month, quarter, half-year, year.
 *
 * Three pure steps: what period a record is about (`recordPeriod`), which of
 * the goal's cells it fills (`goalCellFor`, the grid's own frequencies and
 * cell labels), and one value per cell (`clubReadings`, by the goal's own
 * aggregation rule — the grid's, shared through periodActualAggregate). The
 * clubbing is arithmetic, never an estimate.
 */
import { aggregate, type Aggregation } from './aggregate';

export type RecordPeriod =
  | { year: number; month: number }
  | { year: number; quarter: number }
  | { year: number; half: number }
  | { year: number };

const MONTH_BY_NAME: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const fullYear = (y: string): number => (y.length === 2 ? 2000 + Number(y) : Number(y));
const month = (year: number, m: number): RecordPeriod | null =>
  (Number.isInteger(m) && m >= 1 && m <= 12 ? { year, month: m } : null);

/**
 * The period a record's period value names, at the grain it states — or null
 * when it is not a calendar at all ("aai-2026-w39"): guessing would file a
 * figure under a period it does not belong to.
 */
export const recordPeriod = (raw: unknown): RecordPeriod | null => {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let x: RegExpMatchArray | null;
  if ((x = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/))) return month(Number(x[1]), Number(x[2]));
  if ((x = s.match(/^(\d{4})[-/.](\d{1,2})$/))) return month(Number(x[1]), Number(x[2]));
  if ((x = s.match(/^(\d{1,2})[-/.](\d{4})$/))) return month(Number(x[2]), Number(x[1]));
  if ((x = s.match(/^([A-Za-z]{3,9})[\s\-/.,']*(\d{4}|\d{2})$/))) {
    const m = MONTH_BY_NAME[x[1]!.toLowerCase()];
    return m ? month(fullYear(x[2]!), m) : null;
  }
  if ((x = s.match(/^(\d{4})[\s\-/.,]*([A-Za-z]{3,9})$/))) {
    const m = MONTH_BY_NAME[x[2]!.toLowerCase()];
    return m ? month(Number(x[1]), m) : null;
  }
  if ((x = s.match(/^Q([1-4])[\s\-/.]*(\d{4})$/i))) return { year: Number(x[2]), quarter: Number(x[1]) };
  if ((x = s.match(/^(\d{4})[\s\-/.]*Q([1-4])$/i))) return { year: Number(x[1]), quarter: Number(x[2]) };
  if ((x = s.match(/^H([12])[\s\-/.]*(\d{4})$/i))) return { year: Number(x[2]), half: Number(x[1]) };
  if ((x = s.match(/^(\d{4})[\s\-/.]*H([12])$/i))) return { year: Number(x[1]), half: Number(x[2]) };
  if ((x = s.match(/^(\d{4})$/))) {
    const y = Number(x[1]);
    return y >= 1900 && y <= 2200 ? { year: y } : null;
  }
  return null;
};

/** A stable key for "the same period" — two records for one period are a conflict. */
export const periodKey = (p: RecordPeriod): string =>
  'month' in p ? `${p.year}-M${String(p.month).padStart(2, '0')}`
    : 'quarter' in p ? `${p.year}-Q${p.quarter}`
      : 'half' in p ? `${p.year}-H${p.half}`
        : `${p.year}`;

export interface GoalCell { seq: number; label: string; frequency: string }

/**
 * The grid's frequencies (client/src/utils/frequency.ts): no frequency is
 * monthly; anything else it does not recognise has no grid at all, and is
 * refused here rather than filed as monthly where no one would ever see it.
 */
const goalFrequency = (updfreq: unknown): 'weekly' | 'monthly' | 'quarterly' | 'bi-annual' | 'annual' | null => {
  const s = String(updfreq ?? '').trim().toLowerCase();
  if (!s) return 'monthly';
  if (s.startsWith('week')) return 'weekly';
  if (s.startsWith('month')) return 'monthly';
  if (s.startsWith('quarter')) return 'quarterly';
  if (s.startsWith('bi')) return 'bi-annual';
  if (s.startsWith('year') || s.startsWith('annual')) return 'annual';
  return null;
};

/**
 * Which of the goal's cells a record fills. A record at a coarser grain than
 * the goal cannot be split across its cells ('finer'): a month is not four
 * weeks, a quarter is not three months.
 */
export const goalCellFor = (
  updfreq: unknown,
  p: RecordPeriod,
): GoalCell | { error: 'finer' | 'unknown_frequency' } => {
  const f = goalFrequency(updfreq);
  if (!f) return { error: 'unknown_frequency' };
  if (f === 'annual') return { seq: 1, label: 'Year', frequency: 'ANNUAL' };
  if (f === 'weekly') return { error: 'finer' };
  if (f === 'monthly') {
    return 'month' in p ? { seq: p.month, label: MONTHS[p.month - 1]!, frequency: 'MONTHLY' } : { error: 'finer' };
  }
  if (f === 'quarterly') {
    const q = 'month' in p ? Math.ceil(p.month / 3) : 'quarter' in p ? p.quarter : null;
    return q ? { seq: q, label: `Q${q}`, frequency: 'QUARTERLY' } : { error: 'finer' };
  }
  // bi-annual
  const h = 'month' in p ? (p.month <= 6 ? 1 : 2)
    : 'quarter' in p ? (p.quarter <= 2 ? 1 : 2)
      : 'half' in p ? p.half : null;
  return h ? { seq: h, label: `H${h}`, frequency: 'BI-ANNUAL' } : { error: 'finer' };
};

export interface Reading extends GoalCell { /** periodKey of the record it came from */ period: string; value: number }

/**
 * One value per cell, by the goal's own rule: the readings of one cell — the
 * months of a quarter, say — clubbed the way the grid turns periods into an
 * Actual (sum, average or latest). Two readings for the SAME source period in
 * one cell are a conflict: that cell is set aside, never chosen between.
 */
export const clubReadings = (
  readings: Reading[],
  /** How readings in one period combine — the host's rule for this target. */
  how: Aggregation,
): { cells: Array<GoalCell & { value: number }>; duplicates: string[] } => {
  const bySeq = new Map<number, Reading[]>();
  for (const r of readings) bySeq.set(r.seq, [...(bySeq.get(r.seq) ?? []), r]);
  const cells: Array<GoalCell & { value: number }> = [];
  const duplicates: string[] = [];
  for (const [seq, group] of [...bySeq.entries()].sort((a, b) => a[0] - b[0])) {
    const periods = group.map((g) => g.period);
    if (new Set(periods).size !== periods.length) { duplicates.push(group[0]!.label); continue; }
    // Oldest period first, so "latest" means the most recent period.
    const ordered = [...group].sort((a, b) => a.period.localeCompare(b.period));
    const value = aggregate(ordered.map((g, i) => ({ seq: i + 1, value: g.value })), how);
    if (value === null || !Number.isFinite(value)) continue;
    cells.push({ seq, label: group[0]!.label, frequency: group[0]!.frequency, value });
  }
  return { cells, duplicates };
};

/* ── the entry log ────────────────────────────────────────────────────────── */

/**
 * The author of an integration's entry. The grid shows ⚡ and the integration's
 * name for "INTEGRATION:<name>" — the convention every integration write
 * follows — so an entry never reads as typed by the person who pressed Pull.
 */
export const integrationAuthor = (integrationName: string): string => `INTEGRATION:${integrationName}`;

/**
 * The periods whose figure actually changed, each with what it held before.
 *
 * Every run rewrites every period the feed carries; writing and logging the
 * unchanged ones would stamp nine months "updated" and put nine identical
 * lines in the entry log on every run. A period is written, and logged old →
 * new, only when its figure differs — a blank before counts as a change.
 */
export const changedCells = <C extends GoalCell & { value: number }>(
  cells: C[],
  stored: Map<number, number | null>,
): Array<C & { oldValue: number | null }> => cells.flatMap((c) => {
  const before = stored.has(c.seq) ? stored.get(c.seq)! : null;
  if (before !== null && Math.abs(Number(before) - c.value) < 1e-9) return [];
  return [{ ...c, oldValue: before }];
});

/* ── only a period that has passed is written ────────────────────────────── */

/**
 * Whether a goal cell's period has fully passed by `now` (local time year and month),
 * so an integration may write it. A period still running is never written:
 * its figure is partial (Attendance's October after three days) or not a figure
 * for that period at all (a Bench run put the sheet's year total into October)
 * — and either one, averaged into the year, moves a goal's score for nothing.
 * "period can only be closed when it has past". A quarter,
 * half-year or year is written only once its last month has ended.
 */
export const cellClosed = (cell: GoalCell, year: number, now: { year: number; month: number }): boolean => {
  if (year !== now.year) return year < now.year;
  const f = String(cell.frequency).toUpperCase();
  const lastMonth = f === 'QUARTERLY' ? cell.seq * 3
    : f === 'BI-ANNUAL' ? cell.seq * 6
      : f === 'ANNUAL' ? 12
        : cell.seq;
  return lastMonth < now.month;
};

/**
 * The period a record with no month belongs to: the last month that has
 * passed. A snapshot "as of today" taken in October is September's figure —
 * October is written once October is over.
 */
export const lastClosedMonth = (now: { year: number; month: number }): { year: number; month: number } =>
  (now.month === 1 ? { year: now.year - 1, month: 12 } : { year: now.year, month: now.month - 1 });
