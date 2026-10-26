/**
 * DEF-354 — Integrations Stage 1: the PURE run planner (engine/planner.ts).
 *
 * Rules pinned (spec INTEGRATIONS_DESIGN.md §2.4, §2.5, §3; vm 06 §8/§9):
 *  - a blank never produces a reading (vm "blank never overwrites"), under
 *    either blank policy; the policy only decides whether it is reported;
 *  - a value is a number only when it plainly is one — no coercion, no guess;
 *  - a period is read only when unambiguous; a wide header that is not a
 *    period is an anomaly, never a guess; aligned to the KPI grain;
 *  - an approved row on an inactive / missing KPI FAILS the plan (vm §9);
 *  - an identical second run plans 0 changes (idempotency);
 *  - change cap: first load (owns 0) never trips;
 *  - schedule: never a slot before activation, 'once' never due, day_of_month
 *    -1 = last day, run_time honoured for weekly/monthly, in the given zone.
 */
import { describe, it, expect } from 'vitest';
import {
  changeCapVerdict,
  classifyValue,
  isDue,
  nextScheduledRun,
  parseNumber,
  parsePeriod,
  planKpiReadings,
  readingKey,
} from '../src/services/integrations/engine/planner';
import type { ApprovedKpiRow, KpiDefinitionRef, ScheduleConfig } from '../src/services/integrations/types';

const def = (kpiKey: string, extra: Partial<KpiDefinitionRef & { grain: string }> = {}) => ({
  kpiKey, label: kpiKey, unit: null, isActive: true, sourceIntegrationId: 'i1', ...extra,
});
const longRow = (kpi: string, valueField = 'Revenue', periodField = 'Month', dimensionField?: string): ApprovedKpiRow => ({
  suggestionId: `s-${kpi}`, sourceField: valueField, targetKey: `kpi:${kpi}`,
  transform: { mode: 'long', valueField, periodField, ...(dimensionField ? { dimensionField } : {}) },
});

describe('classifyValue — blank detection', () => {
  it.each(['', '   ', '-', '—', 'n/a', 'N/A', '#N/A', ' '])('%j is blank, never a value', (raw) => {
    expect(classifyValue(raw, 'normal').kind).toBe('blank_expected');
    expect(classifyValue(raw, 'abnormal').kind).toBe('blank_alert');
  });
  it('null/undefined are blank; a number passes through; text is invalid', () => {
    expect(classifyValue(null, 'normal').kind).toBe('blank_expected');
    expect(classifyValue(undefined, 'abnormal').kind).toBe('blank_alert');
    expect(classifyValue(12.5, 'normal')).toEqual({ kind: 'ok', value: '12.5' });
    expect(classifyValue('lots', 'normal').kind).toBe('invalid');
  });
});

describe('parseNumber', () => {
  it.each([
    ['1,234.5', '1234.5'], ['12%', '12'], ['(123)', '-123'], ['$1,200', '1200'], ['Rs. 5,000', '5000'],
    ['€ 7.50', '7.5'], ['-$12', '-12'], ['007', '7'], ['0.1234567', '0.123457'], ['-0', '0'], ['.5', '0.5'],
    ['1 000 PKR', null], ['1,23', null], ['12k', null], ['abc', null], ['', null], ['1.2.3', null],
    ['123456789012345', null],
  ])('%j ⇒ %j', (raw, want) => {
    expect(parseNumber(raw as string)).toBe(want);
  });
});

describe('parsePeriod', () => {
  it.each([
    ['Jan 2026', '2026-01-01'], ['January 2026', '2026-01-01'], ['2026-01', '2026-01-01'],
    ['01/2026', '2026-01-01'], ['2026-03-15', '2026-03-15'], ['Jan-26', '2026-01-01'],
    ['15/03/2026', '2026-03-15'], ['3/15/2026', '2026-03-15'], ['2026-03-15T00:00:00Z', '2026-03-15'],
    ['Sept 2026', '2026-09-01'], ['2026 Feb', '2026-02-01'],
    // never a guess:
    ['January', null], ['2026', null], ['03/04/2026', null], ['Q1 2026', null], ['Region', null], ['2026-02-30', null],
  ])('%j ⇒ %j', (raw, want) => {
    expect(parsePeriod(raw as string)).toBe(want);
  });
});

describe('planKpiReadings', () => {
  const records = [
    { Month: 'Jan 2026', Revenue: '1,000', Region: 'North' },
    { Month: 'Feb 2026', Revenue: '', Region: 'North' },
    { Month: 'Mar 2026', Revenue: 'tbd', Region: 'North' },
    { Month: 'Apr 2026', Revenue: '400', Region: 'North' },
  ];

  it('blank NEVER overwrites: an existing Feb figure stays and is not planned', () => {
    const existing = new Map([[readingKey('revenue', '2026-02-01', ''), '200']]);
    const plan = planKpiReadings(records, [longRow('revenue')], [def('revenue')], existing, 'abnormal');
    expect(plan.failure).toBeNull();
    expect(plan.readings.map((r) => r.periodStart)).toEqual(['2026-01-01', '2026-04-01']);
    expect(plan.readings.find((r) => r.periodStart === '2026-02-01')).toBeUndefined();
    expect(plan.blanks).toBe(1);
    expect(plan.skipped).toBe(1); // 'tbd'
    expect(plan.anomalies.join(' ')).toMatch(/blank cell\(s\) in "Revenue"/);
    expect(plan.anomalies.join(' ')).toMatch(/"tbd"/);
  });

  it("policy 'normal': blank still skipped, but not reported as an anomaly", () => {
    const plan = planKpiReadings(records, [longRow('revenue')], [def('revenue')], new Map(), 'normal');
    expect(plan.blanks).toBe(1);
    expect(plan.anomalies.join(' ')).not.toMatch(/blank/);
  });

  it('an identical second run plans 0 changes (idempotent)', () => {
    const first = planKpiReadings(records, [longRow('revenue')], [def('revenue')], new Map());
    const existing = new Map(first.readings.map((r) => [readingKey(r.kpiKey, r.periodStart, r.dimensionKey), r.value]));
    const second = planKpiReadings(records, [longRow('revenue')], [def('revenue')], existing);
    expect(second.readings).toHaveLength(0);
    expect(second.subjectsAffected).toBe(0);
    expect(second.unchanged).toBe(2);
  });

  it('a stored "1000.000000" equals a sheet "1,000" (canonical compare, no phantom change)', () => {
    const existing = new Map([[readingKey('revenue', '2026-01-01', ''), '1000.000000']]);
    const plan = planKpiReadings(records, [longRow('revenue')], [def('revenue')], existing);
    expect(plan.readings.map((r) => r.periodStart)).toEqual(['2026-04-01']);
    expect(plan.unchanged).toBe(1);
  });

  it('a changed value is planned with its before value', () => {
    const existing = new Map([[readingKey('revenue', '2026-04-01', ''), '300']]);
    const plan = planKpiReadings(records, [longRow('revenue')], [def('revenue')], existing);
    expect(plan.readings.find((r) => r.periodStart === '2026-04-01')).toMatchObject({ before: '300', value: '400', sourceKey: 'row 5 › Revenue' });
  });

  it('dimension makes `<field>=<cell>`; absent ⇒ total ""', () => {
    const plan = planKpiReadings(records, [longRow('revenue', 'Revenue', 'Month', 'Region')], [def('revenue')], new Map());
    expect(plan.readings[0].dimensionKey).toBe('Region=North');
    const total = planKpiReadings(records, [longRow('revenue')], [def('revenue')], new Map());
    expect(total.readings[0].dimensionKey).toBe('');
  });

  it('an inactive KPI definition FAILS the plan (never a silent drop)', () => {
    const plan = planKpiReadings(records, [longRow('revenue')], [def('revenue', { isActive: false })], new Map());
    expect(plan.failure).toMatch(/switched off/);
    expect(plan.readings).toHaveLength(0);
  });

  it('a missing KPI definition FAILS the plan', () => {
    const plan = planKpiReadings(records, [longRow('revenue')], [], new Map());
    expect(plan.failure).toMatch(/no longer in the KPI catalogue/);
    expect(plan.readings).toHaveLength(0);
  });

  it('wide: period from each header; a header that is not a period is an anomaly, never guessed', () => {
    const wide = [
      { Region: 'North', 'Jan 2026': '10', 'Feb 2026': '20', Notes: '99' },
      { Region: 'South', 'Jan 2026': '30', 'Feb 2026': '-', Notes: '1' },
    ];
    const row: ApprovedKpiRow = {
      suggestionId: 's1', sourceField: 'Jan 2026', targetKey: 'kpi:units',
      transform: { mode: 'wide', columns: ['Jan 2026', 'Feb 2026', 'Notes'], periodFrom: 'header', dimensionField: 'Region' },
    };
    const plan = planKpiReadings(wide, [row], [def('units')], new Map(), 'normal');
    expect(plan.readings.map((r) => `${r.periodStart} ${r.dimensionKey} ${r.value}`).sort()).toEqual([
      '2026-01-01 Region=North 10', '2026-01-01 Region=South 30', '2026-02-01 Region=North 20',
    ]);
    expect(plan.anomalies.join(' ')).toMatch(/Column "Notes" is not a period/);
    expect(plan.skipped).toBe(2); // the two Notes cells were not read
    expect(plan.blanks).toBe(1);
  });

  it('two different values for one reading: neither is written', () => {
    const recs = [{ Month: 'Jan 2026', Revenue: '10' }, { Month: '2026-01-15', Revenue: '12' }];
    const plan = planKpiReadings(recs, [longRow('revenue')], [def('revenue')], new Map());
    expect(plan.readings).toHaveLength(0);
    expect(plan.skipped).toBe(2);
    expect(plan.anomalies.join(' ')).toMatch(/more than one different value/);
  });

  it('grain: a day-grain KPI refuses a month-only period; week aligns to Monday', () => {
    const recs = [{ Month: 'Jan 2026', Revenue: '1' }, { Month: '2026-01-15', Revenue: '2' }];
    const day = planKpiReadings(recs, [longRow('d')], [def('d', { grain: 'day' })], new Map());
    expect(day.readings.map((r) => r.periodStart)).toEqual(['2026-01-15']);
    expect(day.skipped).toBe(1);
    const week = planKpiReadings([{ Month: '2026-01-15', Revenue: '2' }], [longRow('w')], [def('w', { grain: 'week' })], new Map());
    expect(week.readings[0].periodStart).toBe('2026-01-12'); // Thursday ⇒ Monday
  });

  it('distinct subjects, not rows', () => {
    const plan = planKpiReadings(records, [longRow('revenue')], [def('revenue')], new Map());
    expect(plan.subjectsAffected).toBe(plan.readings.length);
    expect(new Set(plan.readings.map((r) => readingKey(r.kpiKey, r.periodStart, r.dimensionKey))).size).toBe(plan.subjectsAffected);
  });
});

describe('changeCapVerdict', () => {
  it('first load (owns 0) never trips', () => {
    expect(changeCapVerdict(5000, 0, 25)).toEqual({ wouldTrip: false, pct: 0, cap: 25 });
  });
  it('trips only when strictly above the cap', () => {
    expect(changeCapVerdict(25, 100, 25).wouldTrip).toBe(false);
    expect(changeCapVerdict(26, 100, 25)).toEqual({ wouldTrip: true, pct: 26, cap: 25 });
    expect(changeCapVerdict(1, 3, 25).pct).toBe(33.3);
    // DECIMAL(6,2): a huge ratio is stored clamped, and still trips (review fix).
    expect(changeCapVerdict(144, 1, 25)).toEqual({ wouldTrip: true, pct: 9999.99, cap: 25 });
  });
});

describe('schedule — isDue / nextScheduledRun', () => {
  const KHI = 'Asia/Karachi'; // UTC+5, no DST
  const daily: ScheduleConfig = { frequency: 'daily', runTime: '06:00', dayOfWeek: null, dayOfMonth: null };

  it('never owes a slot before activation (switched on at 10:34, 06:00 already past)', () => {
    const activated = new Date('2026-10-26T05:34:00Z'); // 10:34 PKT
    expect(isDue(daily, new Date('2026-10-26T06:00:00Z'), null, activated, KHI)).toBeNull();
    // next day 06:00 PKT = 01:00Z is owed
    const slot = isDue(daily, new Date('2026-10-27T01:30:00Z'), null, activated, KHI);
    expect(slot?.toISOString()).toBe('2026-10-27T01:00:00.000Z');
  });

  it('a claimed slot is not owed again; NULL activatedAt owes nothing', () => {
    const now = new Date('2026-10-27T01:30:00Z');
    const act = new Date('2026-10-01T00:00:00Z');
    expect(isDue(daily, now, new Date('2026-10-27T01:00:00Z'), act, KHI)).toBeNull();
    expect(isDue(daily, now, null, null, KHI)).toBeNull();
  });

  it('missed days collapse to the latest slot (one run, not one per missed day)', () => {
    const slot = isDue(daily, new Date('2026-10-30T03:00:00Z'), new Date('2026-10-26T01:00:00Z'), new Date('2026-10-01T00:00:00Z'), KHI);
    expect(slot?.toISOString()).toBe('2026-10-30T01:00:00.000Z');
  });

  it("'once' is never due and has no next run", () => {
    const once: ScheduleConfig = { ...daily, frequency: 'once' };
    expect(isDue(once, new Date(), null, new Date(0), KHI)).toBeNull();
    expect(nextScheduledRun(once, new Date(), KHI)).toBeNull();
  });

  it('weekly honours run_time and the weekday', () => {
    const weekly: ScheduleConfig = { frequency: 'weekly', runTime: '09:30', dayOfWeek: 1, dayOfMonth: null };
    // Mon 2026-10-26 09:30 PKT = 04:30Z
    expect(nextScheduledRun(weekly, new Date('2026-10-25T00:00:00Z'), KHI)?.toISOString()).toBe('2026-10-26T04:30:00.000Z');
    expect(nextScheduledRun(weekly, new Date('2026-10-26T04:30:00Z'), KHI)?.toISOString()).toBe('2026-11-02T04:30:00.000Z');
  });

  it('monthly -1 = last day; 31 clamps to a short month', () => {
    const last: ScheduleConfig = { frequency: 'monthly', runTime: '00:00', dayOfWeek: null, dayOfMonth: -1 };
    expect(nextScheduledRun(last, new Date('2026-02-01T00:00:00Z'), KHI)?.toISOString()).toBe('2026-02-27T19:00:00.000Z');
    const d31: ScheduleConfig = { ...last, dayOfMonth: 31 };
    expect(nextScheduledRun(d31, new Date('2026-04-01T00:00:00Z'), KHI)?.toISOString()).toBe('2026-04-29T19:00:00.000Z');
  });

  it('the time zone is the integration\'s own (DST zone, both sides of the change)', () => {
    const ny = 'America/New_York';
    expect(nextScheduledRun(daily, new Date('2026-07-01T00:00:00Z'), ny)?.toISOString()).toBe('2026-07-01T10:00:00.000Z');
    expect(nextScheduledRun(daily, new Date('2026-12-01T00:00:00Z'), ny)?.toISOString()).toBe('2026-12-01T11:00:00.000Z');
  });
});
