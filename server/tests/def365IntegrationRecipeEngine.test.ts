/**
 * DEF-365 — KPI recipes through the REAL run engine (engine/runEngine.ts →
 * planner → vendored @tmc/ai-integration evaluateRecipe), against the same
 * in-memory Prisma double as def354IntegrationEngine.test.ts (scaffolding
 * copied from it, lines 19–189).
 *
 * Pinned:
 *  - an approved count / sum / ratio recipe writes kpi_readings through the
 *    existing KPI path: one transaction, change rows inside it;
 *  - a dry run writes nothing but its run row and preview change rows;
 *  - only ENDED months are computed (the running month is reported, not written);
 *  - a recipe on a KPI kept per week FAILS the run (never a silent drop);
 *  - a recipe whose period column has gone fails the header check;
 *  - an identical second run changes nothing;
 *  - the change cap applies to recipe readings like any other.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const A = 'TMC-0001';
const B = 'TMC-0002';

type Reading = { clientNumber: string; kpiKey: string; periodStart: string; dimensionKey: string; value: string; integrationId: string };

const db = vi.hoisted(() => ({
  integrations: [] as any[],
  versions: [] as any[],
  suggestions: [] as any[],
  runs: [] as any[],
  changes: [] as any[],
  defs: [] as any[],
  readings: [] as Reading[],
  writes: [] as string[],
  sheet: { headers: [] as string[], records: [] as Record<string, string>[], truncated: false },
  failChangeInsert: false,
  failFullClose: 0,
  seq: 0,
}));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/db/tenantContext', () => ({
  runWithoutTenant: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../src/services/userTimezoneService', () => ({
  isValidTimezone: () => true,
  resolveUserTimezone: async () => 'Asia/Karachi',
}));
vi.mock('../src/services/integrations/sources/gsheetReader', () => ({
  readGsheet: async () => ({
    records: db.sheet.records, headers: db.sheet.headers, rowCount: db.sheet.records.length,
    truncated: db.sheet.truncated, anomalies: [], sourceLabel: 'Sales › Monthly',
  }),
}));

vi.mock('../src/db/prisma', () => {
  const matches = (row: any, where: any = {}): boolean => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in (v as any)) return (v as any).in.includes(row[k]);
    return row[k] === v;
  });
  const pick = (row: any, select?: any) => {
    if (!select) return row;
    const o: any = {};
    for (const k of Object.keys(select)) o[k] = row[k];
    return o;
  };
  const changeCreateMany = (label: string) => async ({ data }: any) => {
    db.writes.push(label);
    if (db.failChangeInsert) throw new Error('disk full');
    for (const d of data) db.changes.push({ id: `c${++db.seq}`, createdAt: new Date(), ...d });
    return { count: data.length };
  };
  const p: any = {
    integrationSync: {
      findFirst: async ({ where }: any) => db.integrations.find((r) => matches(r, where)) ?? null,
      updateMany: async ({ where, data }: any) => {
        db.writes.push('integrationSync.updateMany');
        const rows = db.integrations.filter((r) => matches(r, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
    },
    integrationMappingVersion: {
      findFirst: async ({ where, orderBy, select }: any) => {
        const rows = db.versions.filter((r) => matches(r, where));
        if (orderBy?.version === 'desc') rows.sort((a, b) => b.version - a.version);
        return rows[0] ? pick(rows[0], select) : null;
      },
    },
    integrationSuggestion: {
      findMany: async ({ where, select }: any) => db.suggestions.filter((r) => matches(r, where)).map((r) => pick(r, select)),
      count: async ({ where }: any) => db.suggestions.filter((r) => matches(r, where)).length,
    },
    integrationRun: {
      create: async ({ data }: any) => {
        db.writes.push('integrationRun.create');
        if (db.runs.some((r) => r.integrationId === data.integrationId && r.status === 'RUNNING')) {
          throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
        }
        const row = { id: `run${++db.seq}`, startedAt: new Date(), finishedAt: null, result: null, errorMessage: null, ...data };
        db.runs.push(row);
        return { id: row.id };
      },
      updateMany: async ({ where, data }: any) => {
        db.writes.push('integrationRun.updateMany');
        if (db.failFullClose > 0 && 'result' in data) { db.failFullClose -= 1; throw new Error('Invalid `prisma.integrationRun.updateMany()` invocation in /var/www/tmcai/server/dist/x.js: numeric field overflow'); }
        const rows = db.runs.filter((r) => matches(r, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
      findFirst: async ({ where, select }: any) => {
        const r = db.runs.find((x) => matches(x, where));
        return r ? pick(r, select) : null;
      },
      findMany: async ({ where, select, take }: any) =>
        db.runs.filter((r) => matches(r, where)).reverse().slice(0, take).map((r) => pick(r, select)),
    },
    integrationRunChange: {
      createMany: changeCreateMany('integrationRunChange.createMany'),
      findMany: async ({ where, select }: any) => db.changes.filter((r) => matches(r, where)).map((r) => pick(r, select)),
    },
    kpiDefinition: {
      findMany: async ({ where, select }: any) => db.defs.filter((r) => matches(r, where)).map((r) => pick(r, select)),
    },
    kpiReading: {
      findMany: async ({ where }: any) => db.readings.filter((r) => matches(r, where)).map((r) => ({
        kpiKey: r.kpiKey, periodStart: new Date(`${r.periodStart}T00:00:00Z`), dimensionKey: r.dimensionKey,
        value: Number(r.value).toFixed(6), // as NUMERIC(20,6) prints
      })),
      count: async ({ where }: any) => db.readings.filter((r) => matches(r, where)).length,
      upsert: async () => { db.writes.push('kpiReading.upsert'); },
      create: async () => { db.writes.push('kpiReading.create'); },
      update: async () => { db.writes.push('kpiReading.update'); },
    },
    $executeRaw: async () => { db.writes.push('$executeRaw'); return 0; },
    $queryRaw: async () => { db.writes.push('$queryRaw'); return []; },
    // Interactive transaction with REAL rollback semantics on the double.
    $transaction: async (fn: any) => {
      db.writes.push('$transaction');
      const snapR = db.readings.map((r) => ({ ...r }));
      const snapC = db.changes.slice();
      const snapRuns = db.runs.map((r) => ({ ...r }));
      const snapI = db.integrations.map((r) => ({ ...r }));
      const tx = {
        $queryRaw: async (strings: TemplateStringsArray, ...values: any[]) => {
          db.writes.push('tx.$queryRaw');
          const sql = strings.join('?');
          if (!/INSERT INTO kpi_readings/.test(sql) || !/IS DISTINCT FROM EXCLUDED\.value/.test(sql)) throw new Error('unexpected SQL');
          const [cn, integrationId, , keys, periods, dims, vals] = values;
          const out: any[] = [];
          keys.forEach((k: string, i: number) => {
            const hit = db.readings.find((r) => r.clientNumber === cn && r.kpiKey === k && r.periodStart === periods[i] && r.dimensionKey === dims[i]);
            if (!hit) {
              db.readings.push({ clientNumber: cn, kpiKey: k, periodStart: periods[i], dimensionKey: dims[i], value: vals[i], integrationId });
              out.push({ kpi_key: k, period_start: periods[i], dimension_key: dims[i], inserted: true });
            } else if (Number(hit.value) !== Number(vals[i])) {
              Object.assign(hit, { value: vals[i], integrationId });
              out.push({ kpi_key: k, period_start: periods[i], dimension_key: dims[i], inserted: false });
            }
          });
          return out;
        },
        integrationRunChange: { createMany: changeCreateMany('tx.integrationRunChange.createMany') },
        integrationRun: { updateMany: async (a: any) => { const r = await p.integrationRun.updateMany(a); db.writes.push('tx.integrationRun.updateMany'); return r; } },
        integrationSync: { updateMany: async (a: any) => { const r = await p.integrationSync.updateMany(a); db.writes.push('tx.integrationSync.updateMany'); return r; } },
      };
      try {
        return await fn(tx);
      } catch (e) {
        db.readings = snapR;
        db.changes = snapC;
        db.runs = snapRuns;
        db.integrations = snapI;
        throw e;
      }
    },
  };
  return { __esModule: true, default: p, prisma: p };
});

import { runIntegration, sweepInterruptedRuns, INTERRUPTED_BY_RESTART } from '../src/services/integrations/engine/runEngine';
import { startRun, getRunStatus, listRunChanges } from '../src/services/integrations/engine/runJobs';
import { connectionFingerprint } from '../src/services/integrations/store/integrationStore';
import { IntegrationInputError, IntegrationNotFoundError, RunBusyError } from '../src/services/integrations/types';

const CFG = { sheetId: 'sheet123', gid: '0', link: 'https://docs.google.com/spreadsheets/d/sheet123/edit#gid=0' };

const recipeRow = (id: string, kpi: string, recipe: Record<string, unknown>, dimensionField?: string) => ({
  id, clientNumber: A, integrationId: 'i1', mappingVersionId: 'v1', targetKind: 'kpi',
  sourceField: String(recipe.valueField ?? recipe.numeratorField ?? recipe.periodField), targetKey: `kpi:${kpi}`, status: 'APPROVED',
  transform: { mode: 'recipe', recipe, ...(dimensionField ? { dimensionField } : {}) },
});

function seed() {
  db.integrations = [{
    id: 'i1', clientNumber: A, name: 'Orders', sourceKind: 'gsheet', sourceConfig: CFG, status: 'ACTIVE',
    frequency: 'daily', runTime: '06:00', dayOfWeek: null, dayOfMonth: null, timezone: 'Asia/Karachi',
    changeCapPct: 25, blankPolicy: 'abnormal', connectionTestedAt: new Date(),
    connectionFingerprint: connectionFingerprint('gsheet', CFG), activatedAt: new Date(), approvedVersionId: 'v1',
  }];
  db.versions = [{ id: 'v1', clientNumber: A, integrationId: 'i1', version: 1 }];
  db.suggestions = [
    recipeRow('s1', 'orders', { measure: 'count', periodField: 'Date', label: 'Orders per month' }),
    recipeRow('s2', 'revenue', { measure: 'sum', periodField: 'Date', valueField: 'Amount', label: 'Revenue per month' }, 'Region'),
    recipeRow('s3', 'paid_pct', { measure: 'ratio', periodField: 'Date', numeratorField: 'Paid', denominatorField: 'Amount', scale: 100, label: 'Share paid' }),
  ];
  db.defs = ['orders', 'revenue', 'paid_pct'].map((k) => ({
    clientNumber: A, kpiKey: k, label: k, unit: null, isActive: true, sourceIntegrationId: 'i1', grain: 'month',
  }));
  db.sheet = {
    headers: ['Date', 'Region', 'Amount', 'Paid'],
    records: [
      { Date: '2025-12-20', Region: 'North', Amount: '100', Paid: '100' },
      { Date: '2026-01-05', Region: 'North', Amount: '1,000', Paid: '500' },
      { Date: '2026-01-19', Region: 'South', Amount: '300', Paid: '300' },
      { Date: '2026-02-02', Region: 'North', Amount: '200', Paid: '0' },
      { Date: '2026-05-03', Region: 'North', Amount: '999', Paid: '999' }, // the running month (now = 2026-05-15)
    ],
    truncated: false,
  };
  db.runs = []; db.changes = []; db.readings = []; db.writes = []; db.failChangeInsert = false; db.failFullClose = 0;
}

const live = { dryRun: false, trigger: 'manual' as const, triggeredBy: 'user:7' };
const dry = { dryRun: true, trigger: 'manual' as const, triggeredBy: 'user:7', versionId: 'v1' };
const shown = () => db.readings.map((x) => `${x.kpiKey} ${x.periodStart} ${x.dimensionKey || '-'} ${Number(x.value)}`).sort();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-05-15T09:00:00Z'));
  seed();
});
afterEach(() => { vi.useRealTimers(); });

describe('DEF-365 recipe KPIs through the run engine', () => {
  it('a long-row integration with a timezone Intl rejects still runs (now is computed only for recipe rows)', async () => {
    db.integrations[0].timezone = 'PKT-not-a-zone';
    db.suggestions = [{
      id: 'l1', clientNumber: A, integrationId: 'i1', mappingVersionId: 'v1', targetKind: 'kpi',
      sourceField: 'Amount', targetKey: 'kpi:revenue', status: 'APPROVED',
      transform: { mode: 'long', valueField: 'Amount', periodField: 'Date' },
    }];
    const r = await runIntegration(A, 'i1', live);
    expect(r.status).not.toBe('FAILED');
    expect(db.readings.some((x) => x.kpiKey === 'revenue')).toBe(true);
  });

  it('count / sum per dimension / pooled ratio: ended months only, one transaction', async () => {
    const r = await runIntegration(A, 'i1', live);
    expect(r.status).toBe('SUCCESS');
    expect(shown()).toEqual([
      'orders 2025-12-01 - 1',
      'orders 2026-01-01 - 2',
      'orders 2026-02-01 - 1',
      'paid_pct 2025-12-01 - 100',
      'paid_pct 2026-01-01 - 61.54', // (500 + 300) / (1000 + 300) × 100, pooled — not the mean of 50% and 100%
      'paid_pct 2026-02-01 - 0',
      'revenue 2025-12-01 Region=North 100',
      'revenue 2026-01-01 Region=North 1000',
      'revenue 2026-01-01 Region=South 300',
      'revenue 2026-02-01 Region=North 200',
    ]);
    expect(db.readings.some((x) => x.periodStart === '2026-05-01')).toBe(false); // May is still running
    expect(r.anomalies.join(' ')).toMatch(/current or a future month/);
    expect(db.writes).toContain('$transaction');
    expect(db.writes).toContain('tx.integrationRunChange.createMany');
    expect(db.writes).not.toContain('integrationRunChange.createMany');
  });

  it('a dry run writes no reading — only its run row and preview change rows', async () => {
    const r = await runIntegration(A, 'i1', dry);
    expect(r.status).toBe('SUCCESS');
    expect(db.readings).toEqual([]);
    expect(db.writes).not.toContain('$transaction');
    expect(db.writes).not.toContain('tx.$queryRaw');
    expect(db.changes.length).toBe(10);
  });

  it('an identical second run changes nothing', async () => {
    await runIntegration(A, 'i1', live);
    const before = shown();
    const r2 = await runIntegration(A, 'i1', live);
    expect(r2.status).toBe('SUCCESS');
    expect(r2.writes).toBe(0);
    expect(shown()).toEqual(before);
  });

  it('a recipe on a KPI kept per week fails the run and writes nothing', async () => {
    db.defs[0].grain = 'week';
    const r = await runIntegration(A, 'i1', live);
    expect(r.status).toBe('FAILED');
    expect(db.runs[0].errorMessage).toMatch(/computes monthly figures, but the KPI is kept per week/);
    expect(db.readings).toEqual([]);
  });

  it('a recipe whose period column is gone fails the header check', async () => {
    db.sheet.headers = ['Region', 'Amount', 'Paid'];
    const r = await runIntegration(A, 'i1', live);
    expect(r.status).toBe('FAILED');
    expect(db.runs[0].errorMessage).toMatch(/no longer has the column\(s\) "Date"/);
  });

  it('a non-number in a summed field is skipped and counted — never coerced into the total', async () => {
    db.sheet.records[1]!.Amount = '1,00'; // not a number Nexeo can read without guessing
    const r = await runIntegration(A, 'i1', live);
    expect(r.status).toBe('SUCCESS');
    expect(shown()).not.toContain('revenue 2026-01-01 Region=North 100');
    expect(shown().filter((x) => x.startsWith('revenue 2026-01-01'))).toEqual(['revenue 2026-01-01 Region=South 300']);
    expect(r.anomalies.join(' ')).toMatch(/"Amount" are not numbers/);
  });

  it('the change cap applies to recipe readings: a scheduled run rewriting most owned readings aborts', async () => {
    db.readings = ['2025-12-01', '2026-01-01', '2026-02-01'].map((p) => ({
      clientNumber: A, kpiKey: 'orders', periodStart: p, dimensionKey: '', value: '50', integrationId: 'i1',
    }));
    const r = await runIntegration(A, 'i1', { dryRun: false, trigger: 'scheduled' as const, triggeredBy: 'scheduler' });
    expect(r.status).toBe('ABORTED');
    expect(db.readings.filter((x) => x.kpiKey === 'orders').map((x) => x.value)).toEqual(['50', '50', '50']);
    expect(db.readings.some((x) => x.kpiKey === 'revenue')).toBe(false);
  });

  it('a stored transform that is not a valid recipe fails the run (never executed half-read)', async () => {
    db.suggestions[0]!.transform = { mode: 'recipe', recipe: { measure: 'median', periodField: 'Date' } };
    const r = await runIntegration(A, 'i1', live);
    expect(r.status).toBe('FAILED');
    expect(db.runs[0].errorMessage).toMatch(/no usable layout/);
  });
});
