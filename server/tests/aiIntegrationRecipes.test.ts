/**
 * Vendored from @tmc/ai-integration c0a6ebe test/integrationRecipes.test.ts — imports re-pointed at
 * src/vendor/ai-integration (see src/vendor/ai-integration/VENDORED.md).
 */
/**
 * A goal recipe: how the AI says a goal's figure is built from a feed, in a
 * small fixed vocabulary that code checks and computes — the same figure every
 * run, never a number the model produced. the integration
 * wizard is AI-governed; the AI writes the formula, code computes it; how
 * figures combine "depends on the objective and should be mentioned during the
 * wizard".
 *
 * The cases are the four real feeds of tenant 2: Attendance (one row per person
 * per month), Risk & Issues (a snapshot, several rows per person), Work
 * Packages (a snapshot, one row per person) and Bench (month columns, a team).
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateRecipe, validateRecipe, describeRecipe, parseFigure, type GoalRecipe,
} from '../src/vendor/ai-integration/mapping/recipes';

const NOW = { year: 2026, month: 10 }; // October running: Jan–Sep have passed

describe('parseFigure — a cell as the source writes it', () => {
  it('reads numbers and percentages', () => {
    expect(parseFigure('94.0%')).toBe(94);
    expect(parseFigure('1,250')).toBe(1250);
    expect(parseFigure(7)).toBe(7);
  });
  it('reads "-", blanks and text as no figure, never as 0', () => {
    expect(parseFigure('-')).toBeNull();
    expect(parseFigure('')).toBeNull();
    expect(parseFigure(null)).toBeNull();
    expect(parseFigure('n/a')).toBeNull();
  });
});

describe('Bench — month columns, the person and their whole team, averaged', () => {
  const recipe: GoalRecipe = {
    id: 'team-bench', label: 'Team bench %', unit: 'percent',
    shape: { kind: 'month-columns' },
    value: { num: [{ field: '@month' }] },
    rows: 'sum', population: 'team', people: 'mean', year: 'goal-rule',
    guards: { min: 0, max: 100 },
  };
  const row = (code: string, m: Record<string, string>) => ({ 'Employee Code': code, Totals: '99%', ...m });
  const records = new Map([
    ['lead@x.com', [row('E-1', { 'Jan 2026': '0.0%', 'Feb 2026': '-', 'Oct 2026': '50%', 'Nov 2026': '80%' })]],
    ['a@x.com', [row('E-2', { 'Jan 2026': '10.0%', 'Feb 2026': '4.0%', 'Oct 2026': '0%' })]],
    ['b@x.com', [row('E-3', { 'Jan 2026': '20.0%', 'Feb 2026': '-' })]],
  ]);
  const team = (e: string) => (e === 'lead@x.com' ? ['lead@x.com', 'a@x.com', 'b@x.com'] : [e]);

  it('averages each passed month over the people who have a figure', () => {
    const out = evaluateRecipe(recipe, { owner: 'lead@x.com', recordsOf: (e) => records.get(e) ?? [], populationOf: team, now: NOW });
    expect(out.months).toEqual([
      { year: 2026, month: 1, value: 10, people: 3 },
      { year: 2026, month: 2, value: 4, people: 1 },
    ]);
  });

  it('never reads Totals, nor a month still running or to come', () => {
    const out = evaluateRecipe(recipe, { owner: 'lead@x.com', recordsOf: (e) => records.get(e) ?? [], populationOf: team, now: NOW });
    expect(out.months.some((m) => m.month >= 10)).toBe(false);
  });

  it('reads only their own row for someone with no team', () => {
    const out = evaluateRecipe(recipe, { owner: 'a@x.com', recordsOf: (e) => records.get(e) ?? [], populationOf: team, now: NOW });
    expect(out.months.map((m) => m.value)).toEqual([10, 4]);
  });
});

describe('Risk & Issues — a snapshot, rows summed, a ratio of sums', () => {
  const recipe: GoalRecipe = {
    id: 'risk-conversion', label: 'Risks converted to issues %', unit: 'percent',
    shape: { kind: 'snapshot' },
    value: { num: [{ field: 'Risk Converted to Issue' }], den: [{ field: 'Total No of Risk' }], scale: 100 },
    rows: 'sum', population: 'own', people: 'pool', year: 'ratio-of-sums',
  };
  const rows = [
    { RISK_OWNER_NAME_EM: 'C-1 A', 'Total No of Risk': '3', 'Risk Converted to Issue': '1' },
    { RISK_OWNER_NAME_EM: 'C-1 A', 'Total No of Risk': '1', 'Risk Converted to Issue': '0' },
  ];

  it('sums the person\'s rows, then divides — written into the last passed month', () => {
    const out = evaluateRecipe(recipe, { owner: 'a@x.com', recordsOf: () => rows, populationOf: (e) => [e], now: NOW });
    expect(out.months).toEqual([{ year: 2026, month: 9, value: 25, people: 1 }]);
  });

  it('leaves the month blank when there is nothing to divide by', () => {
    const none = [{ 'Total No of Risk': '0', 'Risk Converted to Issue': '1' }];
    const out = evaluateRecipe(recipe, { owner: 'a@x.com', recordsOf: () => none, populationOf: (e) => [e], now: NOW });
    expect(out.months).toEqual([]);
    expect(out.issues.join(' ')).toMatch(/nothing to divide by/);
  });
});

describe('Attendance — a period column, a difference and a ratio', () => {
  const recs = [
    { MonthYear: 'Aug-2026', 'No of Presents': '20', 'No of Check-In Permitted Locations': '18' },
    { MonthYear: 'Sep-2026', 'No of Presents': '22', 'No of Check-In Permitted Locations': '22' },
    { MonthYear: 'Oct-2026', 'No of Presents': '2', 'No of Check-In Permitted Locations': '1' },
    { MonthYear: 'Dec-2025', 'No of Presents': '15', 'No of Check-In Permitted Locations': '0' },
  ];
  const ctx = { owner: 'p@x.com', recordsOf: () => recs, populationOf: (e: string) => [e], now: NOW };

  it('counts check-ins outside a permitted location as Presents minus permitted', () => {
    const recipe: GoalRecipe = {
      id: 'outside', label: 'Check-ins outside a permitted location', unit: 'numerical',
      shape: { kind: 'period-column', field: 'MonthYear' },
      value: { num: [{ field: 'No of Presents' }, { field: 'No of Check-In Permitted Locations', sign: -1 }] },
      rows: 'sum', population: 'own', people: 'sum', year: 'goal-rule',
    };
    expect(evaluateRecipe(recipe, ctx).months.map((m) => [m.month, m.value])).toEqual([[8, 2], [9, 0]]);
  });

  it('gives the share of check-ins at a permitted location, as a percentage', () => {
    const recipe: GoalRecipe = {
      id: 'geo-pct', label: 'Attendance at a permitted location %', unit: 'percent',
      shape: { kind: 'period-column', field: 'MonthYear' },
      value: { num: [{ field: 'No of Check-In Permitted Locations' }], den: [{ field: 'No of Presents' }], scale: 100 },
      rows: 'sum', population: 'own', people: 'pool', year: 'ratio-of-sums', guards: { min: 0, max: 100 },
    };
    const out = evaluateRecipe(recipe, ctx);
    expect(out.months.map((m) => [m.month, m.value])).toEqual([[8, 90], [9, 100]]);
    // The year is the ratio of the year's sums — never an average of monthly percentages.
    expect(out.year).toBeCloseTo((40 / 42) * 100, 6);
  });
});

describe('guards', () => {
  it('drops a month outside the expected range and says so', () => {
    const recipe: GoalRecipe = {
      id: 'r', label: 'r', unit: 'percent', shape: { kind: 'snapshot' },
      value: { num: [{ field: 'c' }], den: [{ field: 't' }], scale: 100 },
      rows: 'sum', population: 'own', people: 'pool', year: 'ratio-of-sums', guards: { min: 0, max: 100 },
    };
    const out = evaluateRecipe(recipe, { owner: 'p', recordsOf: () => [{ c: '5', t: '4' }], populationOf: (e) => [e], now: NOW });
    expect(out.months).toEqual([]);
    expect(out.issues.join(' ')).toMatch(/outside 0–100/);
  });
});

describe('validateRecipe — only what code can compute is accepted', () => {
  const base: GoalRecipe = {
    id: 'x', label: 'x', unit: 'percent', shape: { kind: 'snapshot' },
    value: { num: [{ field: 'A' }] }, rows: 'sum', population: 'own', people: 'sum', year: 'goal-rule',
  };
  it('accepts a recipe whose fields exist', () => {
    expect(validateRecipe(base, ['A', 'B'])).toEqual([]);
  });
  it('refuses a field the source does not have', () => {
    expect(validateRecipe({ ...base, value: { num: [{ field: 'Z' }] } }, ['A'])).toEqual(['The field "Z" is not in the source.']);
  });
  it('refuses month columns read through a named field, and a ratio year without a divisor', () => {
    expect(validateRecipe({ ...base, shape: { kind: 'month-columns' } }, ['A', 'Jan 2026'])[0]).toMatch(/@month/);
    expect(validateRecipe({ ...base, year: 'ratio-of-sums' }, ['A'])[0]).toMatch(/divisor/);
  });
  it('refuses a period column the source does not have', () => {
    expect(validateRecipe({ ...base, shape: { kind: 'period-column', field: 'Month' } }, ['A'])).toEqual(['The field "Month" is not in the source.']);
  });
});

describe('describeRecipe — the sentence shown on the mapping row and the goal', () => {
  it('says what is read, whose rows, and which months', () => {
    expect(describeRecipe({
      id: 'b', label: 'Team bench %', unit: 'percent', shape: { kind: 'month-columns' },
      value: { num: [{ field: '@month' }] }, rows: 'sum', population: 'team', people: 'mean', year: 'goal-rule',
    })).toBe('Team bench %: each month\'s column, averaged over the person and everyone below them; only months that have passed; "-" is no figure.');
    expect(describeRecipe({
      id: 'r', label: 'Risk conversion %', unit: 'percent', shape: { kind: 'snapshot' },
      value: { num: [{ field: 'Risk Converted to Issue' }], den: [{ field: 'Total No of Risk' }], scale: 100 },
      rows: 'sum', population: 'own', people: 'pool', year: 'ratio-of-sums',
    })).toBe('Risk conversion %: (Risk Converted to Issue) ÷ (Total No of Risk) × 100, the person\'s rows added first; the snapshot counts for the last month that has passed; the year is the ratio of the year\'s totals; "-" is no figure.');
  });
});
