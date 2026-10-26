/**
 * DEF-354 — Integrations Stage 1: the run engine (engine/runEngine.ts) and run
 * jobs (engine/runJobs.ts), against an in-memory Prisma double.
 *
 * Rules pinned (spec INTEGRATIONS_DESIGN.md §2.4, §3; vm 06 §8/§9):
 *  - a blank never overwrites a stored reading;
 *  - a dry run writes nothing but its run row and preview change rows
 *    (every Prisma write is spied);
 *  - the change cap applies to SCHEDULED live runs only; a first load never
 *    trips; a dry run reports the verdict a scheduled run would get;
 *  - an approved row on an inactive KPI definition FAILS the run;
 *  - a failed transaction writes nothing (readings + change rows together);
 *  - an identical second run = 0 changes;
 *  - approval is version-scoped: only APPROVED rows of the run's version run;
 *  - the run row is the mutex (P2002 ⇒ RunBusyError);
 *  - the boot sweep closes RUNNING rows; status survives in the row;
 *  - no AI provider is imported anywhere under engine/.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

function seed() {
  db.integrations = [{
    id: 'i1', clientNumber: A, name: 'Sales', sourceKind: 'gsheet', sourceConfig: CFG, status: 'ACTIVE',
    frequency: 'daily', runTime: '06:00', dayOfWeek: null, dayOfMonth: null, timezone: 'Asia/Karachi',
    changeCapPct: 25, blankPolicy: 'abnormal', connectionTestedAt: new Date(),
    connectionFingerprint: connectionFingerprint('gsheet', CFG), activatedAt: new Date(), approvedVersionId: 'v1',
  }];
  db.versions = [
    { id: 'v1', clientNumber: A, integrationId: 'i1', version: 1 },
    { id: 'v2', clientNumber: A, integrationId: 'i1', version: 2 },
  ];
  const sug = (id: string, versionId: string, field: string, kpi: string, status: string) => ({
    id, clientNumber: A, integrationId: 'i1', mappingVersionId: versionId, targetKind: 'kpi', sourceField: field,
    targetKey: `kpi:${kpi}`, status, transform: { mode: 'long', valueField: field, periodField: 'Month' },
  });
  db.suggestions = [
    sug('s1', 'v1', 'Revenue', 'revenue', 'APPROVED'),
    sug('s2', 'v1', 'Units', 'units', 'PENDING'), // not approved ⇒ never runs
    sug('s3', 'v2', 'Units', 'units', 'APPROVED'), // approved, but on another version
  ];
  db.defs = [
    { clientNumber: A, kpiKey: 'revenue', label: 'Revenue', unit: 'PKR', isActive: true, sourceIntegrationId: 'i1', grain: 'month' },
    { clientNumber: A, kpiKey: 'units', label: 'Units', unit: null, isActive: true, sourceIntegrationId: 'i1', grain: 'month' },
  ];
  db.sheet = {
    headers: ['Month', 'Revenue', 'Units'],
    records: [
      { Month: 'Jan 2026', Revenue: '1,000', Units: '5' },
      { Month: 'Feb 2026', Revenue: '2,000', Units: '6' },
      { Month: 'Mar 2026', Revenue: '3,000', Units: '7' },
      { Month: 'Apr 2026', Revenue: '4,000', Units: '8' },
    ],
    truncated: false,
  };
  db.runs = []; db.changes = []; db.readings = []; db.writes = []; db.failChangeInsert = false; db.failFullClose = 0;
}

const live = { dryRun: false, trigger: 'manual' as const, triggeredBy: 'user:7' };
const scheduled = { dryRun: false, trigger: 'scheduled' as const, triggeredBy: 'scheduler' };
const dry = { dryRun: true, trigger: 'manual' as const, triggeredBy: 'user:7', versionId: 'v1' };

beforeEach(seed);

describe('DEF-354 run engine', () => {
  it('first live load: all readings + their change rows in ONE transaction; distinct subjects', async () => {
    const r = await runIntegration(A, 'i1', live);
    expect(r).toMatchObject({ status: 'SUCCESS', writes: 4, subjectsAffected: 4, recordsRead: 4, dryRun: false });
    expect(db.readings.map((x) => `${x.kpiKey} ${x.periodStart} ${x.value}`)).toEqual([
      'revenue 2026-01-01 1000', 'revenue 2026-02-01 2000', 'revenue 2026-03-01 3000', 'revenue 2026-04-01 4000',
    ]);
    expect(db.writes).toContain('$transaction');
    expect(db.writes).toContain('tx.integrationRunChange.createMany');
    expect(db.writes).not.toContain('integrationRunChange.createMany'); // never outside the tx on a live run
    expect(db.changes.every((c) => c.op === 'create' && c.beforeValue === null)).toBe(true);
    expect(db.runs[0]).toMatchObject({ status: 'SUCCESS', writes: 4, mappingVersionId: 'v1' });
  });

  it('version-scoped approval: only APPROVED rows of the run\'s version are executed', async () => {
    await runIntegration(A, 'i1', live);
    expect(new Set(db.readings.map((x) => x.kpiKey))).toEqual(new Set(['revenue'])); // not v1 PENDING, not v2 APPROVED
    // A dry run of v2 previews ONLY v2's approved Units row.
    await runIntegration(A, 'i1', { ...dry, versionId: 'v2' });
    const preview = db.changes.filter((c) => c.runId === db.runs[1].id);
    expect(new Set(preview.map((c) => c.targetKey))).toEqual(new Set(['kpi:units']));
  });

  it('blank never overwrites: an emptied cell keeps the stored figure', async () => {
    await runIntegration(A, 'i1', live);
    db.sheet.records[1].Revenue = '';
    const r = await runIntegration(A, 'i1', live);
    expect(r).toMatchObject({ status: 'SUCCESS', writes: 0, blanks: 1 });
    expect(db.readings.find((x) => x.periodStart === '2026-02-01')!.value).toBe('2000');
    expect(r.anomalies.join(' ')).toMatch(/blank/);
  });

  it('an identical second run = 0 changes, 0 change rows', async () => {
    await runIntegration(A, 'i1', live);
    const before = db.changes.length;
    const r = await runIntegration(A, 'i1', live);
    expect(r).toMatchObject({ status: 'SUCCESS', writes: 0, subjectsAffected: 0 });
    expect(db.changes.length).toBe(before);
  });

  it('dry run writes nothing but its run row and preview rows (every write spied)', async () => {
    const r = await runIntegration(A, 'i1', dry);
    expect(r).toMatchObject({ status: 'SUCCESS', dryRun: true, subjectsAffected: 4 });
    expect(db.readings).toHaveLength(0);
    expect(new Set(db.writes)).toEqual(new Set(['integrationRun.create', 'integrationRunChange.createMany', 'integrationRun.updateMany']));
    expect(db.changes).toHaveLength(4);
    expect(db.integrations[0].lastRunAt).toBeUndefined(); // a dry run is not the integration running
  });

  it('change cap: scheduled live run above the cap ⇒ ABORTED, nothing written; manual is never capped', async () => {
    await runIntegration(A, 'i1', live); // owns 4
    db.sheet.records.forEach((rec, i) => { rec.Revenue = String((i + 1) * 9999); });
    const before = JSON.stringify(db.readings);
    const writesBefore = db.writes.length;

    const s = await runIntegration(A, 'i1', scheduled);
    expect(s).toMatchObject({ status: 'ABORTED', writes: 0, capVerdict: { wouldTrip: true, pct: 100, cap: 25 } });
    expect(JSON.stringify(db.readings)).toBe(before);
    expect(db.writes.slice(writesBefore)).not.toContain('$transaction');

    const d = await runIntegration(A, 'i1', dry); // reported as a scheduled run would see it
    expect(d).toMatchObject({ status: 'SUCCESS', capVerdict: { wouldTrip: true } });

    const m = await runIntegration(A, 'i1', live);
    expect(m).toMatchObject({ status: 'SUCCESS', writes: 4 });
  });

  it('change cap: a new period is not a change — a young sheet\'s scheduled run with an appended month SUCCEEDS (review fix)', async () => {
    const april = db.sheet.records.pop()!;
    await runIntegration(A, 'i1', live); // owns 3 (Jan–Mar)
    expect(db.readings).toHaveLength(3);
    db.sheet.records.push(april); // the admin appends April: 1 insert vs 3 owned = 33% by the old count

    const d = await runIntegration(A, 'i1', dry); // the dry run shares the numerator
    expect(d).toMatchObject({ status: 'SUCCESS', capVerdict: { wouldTrip: false, pct: 0 } });

    const s = await runIntegration(A, 'i1', scheduled);
    expect(s).toMatchObject({ status: 'SUCCESS', writes: 1, capVerdict: { wouldTrip: false, pct: 0 } });
    expect(db.readings.find((x) => x.periodStart === '2026-04-01')?.value).toBe('4000');
  });

  it('change cap: rewrites still count — 1 rewrite + 1 new month on 3 owned trips at 33.3%', async () => {
    const april = db.sheet.records.pop()!;
    await runIntegration(A, 'i1', live);
    db.sheet.records[0]!.Revenue = '1,500';
    db.sheet.records.push(april);
    const s = await runIntegration(A, 'i1', scheduled);
    expect(s).toMatchObject({ status: 'ABORTED', writes: 0, capVerdict: { wouldTrip: true, pct: 33.3 } });
  });

  it('the live close commits with the readings: a failed close rolls them back, the run is FAILED with no raw DB text (review fix)', async () => {
    db.failFullClose = 1;
    const r = await runIntegration(A, 'i1', live);
    expect(r.status).toBe('FAILED');
    expect(db.readings).toHaveLength(0); // rolled back with the close
    expect(db.changes).toHaveLength(0);
    const row = db.runs.find((x) => x.id === r.runId)!;
    expect(row.status).toBe('FAILED');
    expect(row.errorMessage).toMatch(/Nothing was written/);
    expect(row.errorMessage).not.toMatch(/prisma|dist|invocation|overflow/i);
    expect(r.error).not.toMatch(/prisma|dist/i);
    expect(db.writes).toContain('$transaction');
  });

  it('a successful live run closes its row INSIDE the write transaction', async () => {
    const r = await runIntegration(A, 'i1', live);
    expect(r).toMatchObject({ status: 'SUCCESS', writes: 4 });
    expect(db.writes).toContain('tx.integrationRun.updateMany');
    expect(db.writes).toContain('tx.integrationSync.updateMany');
    expect(db.runs.find((x) => x.id === r.runId)).toMatchObject({ status: 'SUCCESS', writes: 4 });
  });

  it('a failed full close never leaves the row RUNNING (the mutex): a minimal close follows (review fix)', async () => {
    db.failFullClose = 1;
    const r = await runIntegration(A, 'i1', dry);
    expect(r.status).toBe('SUCCESS');
    expect(db.runs.find((x) => x.id === r.runId)!.status).toBe('SUCCESS');
    await expect(runIntegration(A, 'i1', dry)).resolves.toMatchObject({ status: 'SUCCESS' }); // not RunBusyError
  });

  it('wide layout: a month column added after approval is named as NOT imported, never a quiet "No changes" (review fix)', async () => {
    db.suggestions = [{
      id: 'w1', clientNumber: A, integrationId: 'i1', mappingVersionId: 'v1', targetKind: 'kpi', sourceField: 'Jan 2026',
      targetKey: 'kpi:revenue', status: 'APPROVED',
      transform: { mode: 'wide', columns: ['Jan 2026', 'Feb 2026'], periodFrom: 'header', dimensionField: 'Region' },
    }];
    db.sheet = {
      headers: ['Region', 'Jan 2026', 'Feb 2026', 'Mar 2026', 'Notes'],
      records: [{ Region: 'North', 'Jan 2026': '1', 'Feb 2026': '2', 'Mar 2026': '3', Notes: 'x' }],
      truncated: false,
    };
    const r = await runIntegration(A, 'i1', live);
    expect(r).toMatchObject({ status: 'SUCCESS', writes: 2 });
    const note = r.anomalies.find((a) => /NOT imported/.test(a));
    expect(note).toContain('"Mar 2026"');
    expect(note).not.toContain('Notes');
    expect(db.readings.some((x) => x.periodStart === '2026-03-01')).toBe(false);
  });

  it('change cap: a scheduled FIRST load (owns 0) never trips', async () => {
    const r = await runIntegration(A, 'i1', scheduled);
    expect(r).toMatchObject({ status: 'SUCCESS', writes: 4, capVerdict: { wouldTrip: false } });
  });

  it('an inactive KPI definition FAILS the run; nothing written', async () => {
    db.defs[0].isActive = false;
    const r = await runIntegration(A, 'i1', live);
    expect(r.status).toBe('FAILED');
    expect(r.error).toMatch(/switched off/);
    expect(db.readings).toHaveLength(0);
    expect(db.writes).not.toContain('$transaction');
  });

  it('a KPI owned by ANOTHER integration fails the run (one field, one owner)', async () => {
    db.defs[0].sourceIntegrationId = 'other';
    const r = await runIntegration(A, 'i1', live);
    expect(r).toMatchObject({ status: 'FAILED' });
    expect(db.readings).toHaveLength(0);
  });

  it('transaction failure writes nothing: readings and change rows roll back together', async () => {
    db.failChangeInsert = true;
    const r = await runIntegration(A, 'i1', live);
    expect(r).toMatchObject({ status: 'FAILED', writes: 0 });
    expect(r.error).toMatch(/Nothing was written/);
    expect(db.readings).toHaveLength(0);
    expect(db.changes).toHaveLength(0);
    expect(db.runs[0].status).toBe('FAILED');
  });

  it('header check: a column the approved mapping reads is missing ⇒ FAILED', async () => {
    db.sheet.headers = ['Month', 'Units'];
    const r = await runIntegration(A, 'i1', live);
    expect(r.status).toBe('FAILED');
    expect(r.error).toMatch(/"Revenue"/);
  });

  it('a truncated read is PARTIAL, never a silent SUCCESS', async () => {
    db.sheet.truncated = true;
    const r = await runIntegration(A, 'i1', live);
    expect(r.status).toBe('PARTIAL');
  });

  it('the run row is the mutex: a second run while one is RUNNING ⇒ RunBusyError, no row', async () => {
    db.runs.push({ id: 'busy', clientNumber: A, integrationId: 'i1', status: 'RUNNING' });
    await expect(runIntegration(A, 'i1', live)).rejects.toBeInstanceOf(RunBusyError);
    expect(db.runs).toHaveLength(1);
  });

  it('a live run never executes another version than the approved one', async () => {
    await expect(runIntegration(A, 'i1', { ...live, versionId: 'v2' })).rejects.toBeInstanceOf(IntegrationInputError);
    expect(db.runs).toHaveLength(0);
  });

  it('a live run refuses a connection that has not passed its test (fingerprint mismatch)', async () => {
    db.integrations[0].connectionFingerprint = 'stale';
    const r = await runIntegration(A, 'i1', live);
    expect(r.status).toBe('FAILED');
    expect(db.readings).toHaveLength(0);
  });

  it('tenant: another tenant\'s integration id is not found', async () => {
    await expect(runIntegration(B, 'i1', live)).rejects.toBeInstanceOf(IntegrationNotFoundError);
  });

  it('boot sweep: every RUNNING row ⇒ FAILED "interrupted by server restart"; status survives in the row', async () => {
    db.runs.push({ id: 'r9', clientNumber: A, integrationId: 'i1', status: 'RUNNING', dryRun: false, trigger: 'manual',
      mappingVersionId: 'v1', startedAt: new Date(), finishedAt: null, result: null, errorMessage: null });
    expect(await sweepInterruptedRuns()).toBe(1);
    const v = await getRunStatus(A, 'i1', 'r9');
    expect(v).toMatchObject({ status: 'FAILED', error: INTERRUPTED_BY_RESTART, result: null });
    expect(await getRunStatus(B, 'i1', 'r9')).toBeNull();
  });
});

describe('DEF-354 run jobs', () => {
  it('startRun returns the runId; the status and changes are read back from the rows', async () => {
    const { runId } = await startRun(A, 'i1', dry);
    expect(runId).toMatch(/^run/);
    await vi.waitFor(async () => expect((await getRunStatus(A, 'i1', runId))?.status).toBe('SUCCESS'));
    const view = await getRunStatus(A, 'i1', runId);
    expect(view?.result).toMatchObject({ runId, dryRun: true, subjectsAffected: 4 });
    expect(view?.triggeredBy).toBe('user:7'); // Run History "Who" (review fix)
    expect(await listRunChanges(A, 'i1', runId)).toHaveLength(4);
  });

  it('startRun rejects with RunBusyError before a row exists', async () => {
    db.runs.push({ id: 'busy', clientNumber: A, integrationId: 'i1', status: 'RUNNING' });
    await expect(startRun(A, 'i1', dry)).rejects.toBeInstanceOf(RunBusyError);
  });
});

describe('DEF-354 engine is model-free', () => {
  it('no file under services/integrations/engine imports an AI provider', () => {
    const dir = path.join(__dirname, '../src/services/integrations/engine');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect(src, f).not.toMatch(/llmRouter|callLLM|gemini|claude|anthropic|openai|providerRegistry|getProvider|aiProposer/i);
    }
  });
});
