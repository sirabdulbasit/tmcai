/**
 * DEF-354 — Integrations Stage 1, mapping/fieldInventory.ts + mapping/mappingRisk.ts (pure).
 *
 * Rules pinned (spec INTEGRATIONS_DESIGN.md §2.3, vm buildFieldCoverage / assessMappingRisk):
 *  - The inventory is computed from ALL rows, never a sample: a value that
 *    first appears in the last row is counted and its column's fill rate is
 *    exact.
 *  - Every column is accounted for, in sheet order, including a stray key the
 *    headers did not list.
 *  - 2–3 REAL samples; distinct values listed only when ≤12; type by a clear
 *    majority (number / date / text / empty).
 *  - Risk: a never-populated or non-numeric row becomes SET_ASIDE with the
 *    arithmetic in `reason`; a passing row reports DISTINCT subjects, not rows.
 */
import { describe, it, expect } from 'vitest';
import {
  buildFieldCoverage, looksLikeDate, looksNumeric, MAX_LISTED_VALUES, MAX_SAMPLES,
} from '../src/services/integrations/mapping/fieldInventory';
import { assessKpiRowRisk, profileKpiRow, transformFields } from '../src/services/integrations/mapping/mappingRisk';

const rows = (n: number, f: (i: number) => Record<string, string>) => Array.from({ length: n }, (_, i) => f(i));

describe('DEF-354 field inventory', () => {
  it('counts every row: a value only in the last of 5000 rows is seen', () => {
    const records = rows(5000, (i) => ({ Month: 'Jan 2026', Late: i === 4999 ? '42' : '' }));
    const cov = buildFieldCoverage(records, ['Month', 'Late']);
    const late = cov.find((c) => c.field === 'Late')!;
    expect(late.filled).toBe(1);
    expect(late.total).toBe(5000);
    expect(late.samples).toEqual(['42']);
    expect(late.inferredType).toBe('number');
  });

  it('keeps sheet order and appends a stray key instead of dropping it', () => {
    const cov = buildFieldCoverage([{ B: '1', A: 'x', Stray: 'y' }], ['B', 'A']);
    expect(cov.map((c) => c.field)).toEqual(['B', 'A', 'Stray']);
  });

  it('gives at most 3 distinct real samples', () => {
    const cov = buildFieldCoverage(rows(10, (i) => ({ V: String(i % 4) })), ['V']);
    expect(cov[0].samples).toHaveLength(MAX_SAMPLES);
    expect(cov[0].samples).toEqual(['0', '1', '2']);
  });

  it('lists distinct values only when there are 12 or fewer', () => {
    const few = buildFieldCoverage(rows(100, (i) => ({ Region: ['North', 'South', 'East'][i % 3] })), ['Region'])[0];
    expect(few.distinct).toEqual(['North', 'South', 'East']);
    const many = buildFieldCoverage(rows(100, (i) => ({ Id: `id-${i}` })), ['Id'])[0];
    expect(many.distinct).toBeUndefined();
    const exactly = buildFieldCoverage(rows(MAX_LISTED_VALUES, (i) => ({ X: `v${i}` })), ['X'])[0];
    expect(exactly.distinct).toHaveLength(MAX_LISTED_VALUES);
  });

  it('infers number / date / text / empty by majority', () => {
    const records = rows(10, (i) => ({
      Revenue: i === 9 ? 'n/a' : `PKR 1,2${i}0.50`,
      Month: `${['Jan', 'Feb', 'Mar'][i % 3]} 2026`,
      Note: `free text ${i}`,
      Blank: '',
    }));
    const t = Object.fromEntries(buildFieldCoverage(records, ['Revenue', 'Month', 'Note', 'Blank']).map((c) => [c.field, c.inferredType]));
    expect(t).toEqual({ Revenue: 'number', Month: 'date', Note: 'text', Blank: 'empty' });
  });

  it('number and period recognisers', () => {
    for (const s of ['1234', '1,234.5', '(12)', '-3', '45%', '$ 9.99']) expect(looksNumeric(s)).toBe(true);
    for (const s of ['abc', '', '12abc', '1,23,4']) expect(looksNumeric(s)).toBe(false);
    for (const s of ['2026-01', '2026-01-31', '31/01/2026', 'Jan 2026', 'January-26', 'Q1 2026', '2026-Q1']) expect(looksLikeDate(s)).toBe(true);
    for (const s of ['Revenue', 'Notes', '1234']) expect(looksLikeDate(s)).toBe(false);
  });
});

describe('DEF-354 mapping risk', () => {
  it('never_populated: an all-blank value column is SET_ASIDE with the counts', () => {
    const records = rows(7, () => ({ Month: 'Jan 2026', Revenue: '' }));
    const r = assessKpiRowRisk(records, { mode: 'long', valueField: 'Revenue', periodField: 'Month' }, 'Revenue (kpi:revenue)');
    expect(r.code).toBe('never_populated');
    expect(r.setAside).toBe(true);
    expect(r.reason).toContain('all 7 rows');
    expect(r.reason).toContain('0 of 7 cells');
  });

  it('value_not_numeric: a text column that looks like a KPI by name is SET_ASIDE with the share', () => {
    const records = rows(10, (i) => ({ Month: 'Jan 2026', Revenue: i < 3 ? '100' : 'pending' }));
    const r = assessKpiRowRisk(records, { mode: 'long', valueField: 'Revenue', periodField: 'Month' }, 'Revenue');
    expect(r.code).toBe('value_not_numeric');
    expect(r.setAside).toBe(true);
    expect(r.reason).toContain('only 3 of 10');
    expect(r.reason).toContain('30%');
  });

  it('a few bad cells do not set the row aside, and are counted in the reason', () => {
    const records = rows(10, (i) => ({ Month: `${['Jan', 'Feb', 'Mar', 'Apr', 'May'][i % 5]} 2026`, Revenue: i === 0 ? 'n/a' : '100' }));
    const r = assessKpiRowRisk(records, { mode: 'long', valueField: 'Revenue', periodField: 'Month' }, 'Revenue');
    expect(r.setAside).toBe(false);
    expect(r.reason).toContain('1 filled cell is not a number');
  });

  it('counts DISTINCT subjects, not rows (vm overcounted by summing)', () => {
    // 12 rows, but only 3 months × 2 regions = 6 distinct readings.
    const records = rows(12, (i) => ({ Month: `${['Jan', 'Feb', 'Mar'][i % 3]} 2026`, Region: i % 2 ? 'N' : 'S', Sales: '5' }));
    const p = profileKpiRow(records, { mode: 'long', valueField: 'Sales', periodField: 'Month', dimensionField: 'Region' });
    expect(p.subjects).toBe(6);
    const r = assessKpiRowRisk(records, { mode: 'long', valueField: 'Sales', periodField: 'Month', dimensionField: 'Region' }, 'Sales');
    expect(r.reason).toContain('6 distinct readings from 12 rows');
  });

  it('wide layout: one reading per period column; a non-period header cannot be dated', () => {
    const records = rows(2, (i) => ({ Region: i ? 'N' : 'S', 'Jan 2026': '1', 'Feb 2026': '2', Notes: '3' }));
    const ok = profileKpiRow(records, { mode: 'wide', columns: ['Jan 2026', 'Feb 2026'], periodFrom: 'header', dimensionField: 'Region' });
    expect(ok.subjects).toBe(4);
    const bad = assessKpiRowRisk(records, { mode: 'wide', columns: ['Notes'], periodFrom: 'header' }, 'X');
    expect(bad.code).toBe('period_unreadable');
    expect(bad.setAside).toBe(true);
  });

  it('judges periods with the RUN\'s parser: US month-start dates, "Jan 26", "Q1 2026" are set aside, not approved (review fix)', () => {
    // 1/1/2026 … 12/1/2026: only January is unambiguous to the planner.
    const us = rows(12, (i) => ({ Month: `${i + 1}/1/2026`, Revenue: String(100 + i) }));
    const r = assessKpiRowRisk(us, { mode: 'long', valueField: 'Revenue', periodField: 'Month' }, 'Revenue');
    expect(r.code).toBe('period_unreadable');
    expect(r.setAside).toBe(true);
    expect(r.reason).toContain('only 1 have a period a run can read');
    expect(r.profile.subjects).toBe(1);

    for (const bad of ['Jan 26', 'Q1 2026', '1.2.26']) {
      const recs = rows(3, () => ({ Month: bad, Revenue: '5' }));
      expect(assessKpiRowRisk(recs, { mode: 'long', valueField: 'Revenue', periodField: 'Month' }, 'R').code).toBe('period_unreadable');
    }
  });

  it('the KPI grain counts: month periods cannot feed a per-day KPI', () => {
    const recs = rows(3, (i) => ({ Month: `${['Jan', 'Feb', 'Mar'][i]} 2026`, Revenue: '5' }));
    const t = { mode: 'long' as const, valueField: 'Revenue', periodField: 'Month' };
    expect(assessKpiRowRisk(recs, t, 'R').code).toBe('none');
    expect(assessKpiRowRisk(recs, t, 'R', undefined, 'day').code).toBe('period_unreadable');
  });

  it('transformFields lists every header a run will check', () => {
    expect(transformFields({ mode: 'long', valueField: 'V', periodField: 'P', dimensionField: 'D' })).toEqual(['V', 'P', 'D']);
    expect(transformFields({ mode: 'wide', columns: ['a', 'b'], periodFrom: 'header' })).toEqual(['a', 'b']);
  });
});
