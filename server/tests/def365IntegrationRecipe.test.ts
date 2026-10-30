/**
 * DEF-365 — KPI recipes, design-time and planner level.
 *
 * Pinned:
 *  - engine/kpiRecipe reads/validates a recipe through the FRAMEWORK's
 *    validateRecipe (real headers, exact match) and compiles count / sum /
 *    ratio to a framework GoalRecipe;
 *  - the planner computes recipes with the framework's evaluateRecipe (spied),
 *    after Nexeo's own cell rules: blanks / non-numbers / unreadable periods
 *    are skipped AND counted; earlier years are complete, the running month
 *    is never computed; no `now` ⇒ the plan fails (the planner reads no clock);
 *  - mappingRisk judges a recipe row with the run's own planner (reading
 *    count) and sets aside one that can never produce a figure;
 *  - the proposer accepts a "recipe" row only on real headers, and the
 *    "KPI rows never count/sum" restriction is gone from its prompt.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const spy = vi.hoisted(() => ({ evaluate: 0, validate: 0 }));

vi.mock('../src/vendor/ai-integration/mapping/recipes', async () => {
  const real: any = await vi.importActual('../src/vendor/ai-integration/mapping/recipes');
  return {
    ...real,
    evaluateRecipe: (...a: any[]) => { spy.evaluate += 1; return real.evaluateRecipe(...a); },
    validateRecipe: (...a: any[]) => { spy.validate += 1; return real.validateRecipe(...a); },
  };
});
vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/services/behaviorConfig', () => ({ getBehaviorValue: async () => 3_600_000 }));
vi.mock('../src/services/llmRouter', () => ({ callLLM: async () => ({ text: '', provider: 'gemini' }) }));
vi.mock('../src/services/integrations/sources/gsheetReader', () => ({ readGsheet: async () => null }));
vi.mock('../src/services/integrations/store/integrationStore', () => ({
  readSourceConfig: (raw: any) => raw, isConnectionOk: () => true,
}));
vi.mock('../src/db/prisma', () => ({ __esModule: true, default: {}, prisma: {} }));

import { readKpiRecipe, toGoalRecipe, describeKpiRecipe, recipeTransformFields, COUNT_FIELD } from '../src/services/integrations/engine/kpiRecipe';
import { planKpiReadings, monthIn, type PlannerKpiDef } from '../src/services/integrations/engine/planner';
import { readTransform as engineReadTransform, fieldsRead } from '../src/services/integrations/engine/runEngine';
import { assessKpiRowRisk } from '../src/services/integrations/mapping/mappingRisk';
import { PROPOSER_SYSTEM_PROMPT, readTransform, validateProposal } from '../src/services/integrations/mapping/aiProposer';
import type { ApprovedKpiRow, KpiTransform } from '../src/services/integrations/types';

const HEADERS = ['Date', 'Region', 'Amount', 'Paid'];
const RECORDS: Record<string, string>[] = [
  { Date: '2025-11-03', Region: 'North', Amount: '10', Paid: '10' },
  { Date: '2026-01-05', Region: 'North', Amount: '$1,000', Paid: '400' },
  { Date: '2026-01-19', Region: 'South', Amount: '300', Paid: '' },
  { Date: 'Jan 2026', Region: 'South', Amount: 'n/a', Paid: '1' },
  { Date: '03/04/2026', Region: 'North', Amount: '5', Paid: '5' }, // March or April? never guessed
  { Date: '2026-04-30', Region: '', Amount: '7', Paid: '7' },
  { Date: '2026-05-02', Region: 'North', Amount: '9', Paid: '9' }, // running month
];
const NOW = { year: 2026, month: 5 };
const def = (kpiKey: string, grain = 'month'): PlannerKpiDef => ({ kpiKey, label: kpiKey, unit: null, isActive: true, sourceIntegrationId: 'i1', grain });
const row = (kpiKey: string, transform: KpiTransform): ApprovedKpiRow => ({ suggestionId: kpiKey, sourceField: 'x', targetKey: `kpi:${kpiKey}`, transform });
const recipe = (r: Record<string, unknown>, dimensionField?: string): KpiTransform => {
  const k = readKpiRecipe(r, HEADERS);
  if (typeof k === 'string') throw new Error(k);
  return { mode: 'recipe', recipe: k, ...(dimensionField ? { dimensionField } : {}) };
};
const readings = (p: ReturnType<typeof planKpiReadings>) => p.readings.map((r) => `${r.periodStart} ${r.dimensionKey || '-'} ${r.value}`);

beforeEach(() => { spy.evaluate = 0; spy.validate = 0; });

describe('DEF-365 kpiRecipe: read, validate, compile', () => {
  it('validates through the framework against the real headers', () => {
    expect(readKpiRecipe({ measure: 'sum', periodField: 'Date', valueField: 'Amount', label: 'Revenue' }, HEADERS))
      .toEqual({ measure: 'sum', periodField: 'Date', valueField: 'Amount', label: 'Revenue' });
    expect(spy.validate).toBe(1);
    expect(readKpiRecipe({ measure: 'sum', periodField: 'Date', valueField: 'Total', label: 'x' }, HEADERS)).toMatch(/"Total" is not in the source/);
    // Exact match, as the run's header check: the framework alone would accept a case difference.
    expect(readKpiRecipe({ measure: 'sum', periodField: 'date', valueField: 'Amount', label: 'x' }, HEADERS)).toMatch(/"date" is not in the source/);
  });
  it('refuses what cannot be computed', () => {
    expect(readKpiRecipe({ measure: 'median', periodField: 'Date' })).toMatch(/count", "sum" or "ratio/);
    expect(readKpiRecipe({ measure: 'count' })).toMatch(/periodField/);
    expect(readKpiRecipe({ measure: 'sum', periodField: 'Date' })).toMatch(/valueField/);
    expect(readKpiRecipe({ measure: 'ratio', periodField: 'Date', numeratorField: 'Paid', denominatorField: 'Paid' })).toMatch(/same field/);
    expect(readKpiRecipe({ measure: 'ratio', periodField: 'Date', numeratorField: 'Paid', denominatorField: 'Amount', scale: -1 })).toMatch(/scale/);
    expect(readKpiRecipe({ measure: 'sum', periodField: 'Amount', valueField: 'Amount' })).toMatch(/period field is also used/);
    expect(readKpiRecipe({ measure: 'count', periodField: 'Date' }, [...HEADERS, COUNT_FIELD])).toMatch(/reserve/);
  });
  it('compiles to a framework GoalRecipe: one owner, rows summed, a ratio POOLED', () => {
    const g = toGoalRecipe({ measure: 'ratio', periodField: 'Date', numeratorField: 'Paid', denominatorField: 'Amount', scale: 100, label: 'Paid %' });
    expect(g).toMatchObject({ population: 'own', rows: 'sum', people: 'pool', unit: 'percent', shape: { kind: 'period-column', field: 'Date' } });
    expect(g.value).toEqual({ num: [{ field: 'Paid' }], den: [{ field: 'Amount' }], scale: 100 });
    expect(toGoalRecipe({ measure: 'count', periodField: 'Date', label: 'n' }).value).toEqual({ num: [{ field: COUNT_FIELD }] });
  });
  it('says what it does in plain words, and lists every field the header check needs', () => {
    const t = recipe({ measure: 'sum', periodField: 'Date', valueField: 'Amount', label: 'Revenue' }, 'Region');
    expect(describeKpiRecipe((t as any).recipe, 'Region')).toBe('Adds up "Amount" per month (dated by "Date"), separately for each "Region"; only months that have ended; blanks and non-numbers are skipped.');
    expect(recipeTransformFields(t)).toEqual(['Date', 'Amount', 'Region']);
    expect(fieldsRead(t)).toEqual(['Date', 'Amount', 'Region']);
  });
  it('the engine re-reads a stored recipe and refuses a broken one', () => {
    const t = recipe({ measure: 'count', periodField: 'Date', label: 'Orders' });
    expect(engineReadTransform(JSON.parse(JSON.stringify(t)))).toEqual(t);
    expect(engineReadTransform({ mode: 'recipe', recipe: { measure: 'sum', periodField: 'Date' } })).toBeNull();
  });
});

describe('DEF-365 planner: recipes computed by the framework after Nexeo\'s cell rules', () => {
  it('count per month: earlier years complete, the running month and unreadable periods excluded', () => {
    const p = planKpiReadings(RECORDS, [row('orders', recipe({ measure: 'count', periodField: 'Date', label: 'Orders' }))], [def('orders')], new Map(), 'normal', NOW);
    expect(p.failure).toBeNull();
    expect(readings(p)).toEqual(['2025-11-01 - 1', '2026-01-01 - 3', '2026-04-01 - 1']);
    expect(spy.evaluate).toBe(2); // 2025 and 2026, one call each
    expect(p.anomalies.join(' ')).toMatch(/1 row\(s\) have a "Date" that is not a readable period \(e\.g\. "03\/04\/2026"\)/);
    expect(p.anomalies.join(' ')).toMatch(/1 record\(s\) for "orders" fall in the current or a future month/);
    expect(p.skipped).toBe(1);
  });
  it('sum per dimension: currency and thousands read by Nexeo; a non-number and a blank dimension are skipped and counted', () => {
    const p = planKpiReadings(RECORDS, [row('rev', recipe({ measure: 'sum', periodField: 'Date', valueField: 'Amount', label: 'Revenue' }, 'Region'))], [def('rev')], new Map(), 'normal', NOW);
    expect(readings(p)).toEqual(['2025-11-01 Region=North 10', '2026-01-01 Region=North 1000', '2026-01-01 Region=South 300']);
    expect(p.anomalies.join(' ')).toMatch(/"Region"/);
    // "n/a" is a blank token; the unreadable period and the blank Region are skipped.
    expect(p.blanks).toBe(1);
    expect(p.skipped).toBe(2);
  });
  it('ratio is pooled (Σnum ÷ Σden), and a blank part leaves the record out — never a partial figure', () => {
    const p = planKpiReadings(RECORDS, [row('paid', recipe({ measure: 'ratio', periodField: 'Date', numeratorField: 'Paid', denominatorField: 'Amount', scale: 100, label: 'Paid %' }))], [def('paid')], new Map(), 'normal', NOW);
    // January: (400) / (1000) — the South row has a blank Paid and the "n/a" row a blank Amount.
    expect(readings(p)).toEqual(['2025-11-01 - 100', '2026-01-01 - 40', '2026-04-01 - 100']);
  });
  it('an unchanged reading is not rewritten', () => {
    const t = recipe({ measure: 'count', periodField: 'Date', label: 'Orders' });
    const existing = new Map([['orders|2026-01-01|', '3.000000']]);
    const p = planKpiReadings(RECORDS, [row('orders', t)], [def('orders')], existing as any, 'normal', NOW);
    expect(p.unchanged).toBe(1);
    expect(readings(p)).not.toContain('2026-01-01 - 3');
  });
  it('fails without the current month, and on a KPI not kept per month', () => {
    const t = recipe({ measure: 'count', periodField: 'Date', label: 'Orders' });
    expect(planKpiReadings(RECORDS, [row('orders', t)], [def('orders')], new Map()).failure).toMatch(/without the current month/);
    expect(planKpiReadings(RECORDS, [row('orders', t)], [def('orders', 'week')], new Map(), 'normal', NOW).failure).toMatch(/kept per week/);
    expect(spy.evaluate).toBe(0);
  });
  it('monthIn reads the month in the integration\'s zone', () => {
    expect(monthIn(new Date('2026-04-30T20:00:00Z'), 'Asia/Karachi')).toEqual({ year: 2026, month: 5 });
    expect(monthIn(new Date('2026-04-30T20:00:00Z'), 'UTC')).toEqual({ year: 2026, month: 4 });
  });
});

describe('DEF-365 mapping risk and proposer', () => {
  it('a recipe row says how many monthly readings a run would write', () => {
    const t = recipe({ measure: 'count', periodField: 'Date', label: 'Orders' });
    const r = assessKpiRowRisk(RECORDS, t, 'Orders (kpi:orders)');
    expect(r.setAside).toBe(false);
    expect(r.reason).toMatch(/^Computes Orders \(kpi:orders\): Counts the records per month/);
    expect(r.reason).toMatch(/\d+ monthly readings? from 7 records/);
  });
  it('a recipe that can never produce a figure is set aside; so is one on a weekly KPI', () => {
    const t = recipe({ measure: 'sum', periodField: 'Date', valueField: 'Amount', label: 'Revenue' });
    const none = assessKpiRowRisk(RECORDS.map((x) => ({ ...x, Amount: '' })), t, 'Revenue');
    expect(none).toMatchObject({ setAside: true, code: 'never_populated' });
    const weekly = assessKpiRowRisk(RECORDS, t, 'Revenue (kpi:rev)', undefined, 'week');
    expect(weekly.setAside).toBe(true);
    expect(weekly.reason).toMatch(/kept per week/);
  });
  it('readTransform accepts a recipe on real headers only', () => {
    expect(readTransform({ mode: 'recipe', recipe: { measure: 'count', periodField: 'Date', label: 'n' }, dimensionField: 'Region' }, HEADERS))
      .toEqual({ mode: 'recipe', recipe: { measure: 'count', periodField: 'Date', label: 'n' }, dimensionField: 'Region' });
    expect(readTransform({ mode: 'recipe', recipe: { measure: 'sum', periodField: 'Date', valueField: 'Nope' } }, HEADERS)).toMatch(/not in the source/);
    expect(readTransform({ mode: 'recipe', recipe: { measure: 'sum', periodField: 'Date', valueField: 'Amount' }, dimensionField: 'Amount' }, HEADERS)).toMatch(/dimension column is also used/);
  });
  it('validateProposal turns a recipe row into a PENDING KPI suggestion with its transform', () => {
    const out = validateProposal({
      integrationId: 'i1',
      answer: { summary: '', notices: [], rows: [{ kind: 'kpi', targetKey: 'kpi:new:orders', newKpi: { kpiKey: 'orders', label: 'Orders' }, transform: { mode: 'recipe', recipe: { measure: 'count', periodField: 'Date', label: 'Orders per month' } } }] },
      read: { records: RECORDS, headers: HEADERS },
      coverage: [],
      defs: [],
      carried: [],
      rejected: [],
      hasAdminPrompt: false,
    });
    expect(out.notices).toEqual([]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({ targetKind: 'kpi', targetKey: 'kpi:new:orders', sourceField: 'Date', status: 'PENDING', transform: { mode: 'recipe' } });
  });
  it('the prompt offers recipes and no longer forbids counting or summing', () => {
    expect(PROPOSER_SYSTEM_PROMPT).toMatch(/"mode":"recipe"/);
    expect(PROPOSER_SYSTEM_PROMPT).not.toMatch(/can never count, sum or average/);
    expect(PROPOSER_SYSTEM_PROMPT).toMatch(/only months that have ended/);
  });
});
