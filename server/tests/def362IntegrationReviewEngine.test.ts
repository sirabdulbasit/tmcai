/**
 * DEF-362 — Integrations Stage 1b, fixes from the four-angle review (rules and
 * end-to-end lenses): the run engine and the Context writer.
 *
 * The prisma / reader mocks are the same as def362IntegrationEngineContext.
 * Each block pins one verified finding and fails without its fix:
 *  E1. A dry run uses ONLY its own version's approved filter row — never the
 *      running version's integration.approved_filter — so it previews exactly
 *      what turning that version on will run.
 *  E2. The stale fact survives the hourly wiki linter (which rewrites every
 *      link-less page to 'orphan'): a staled page is not re-staled on the next
 *      run (no new change row, no change-cap growth), its body says it is
 *      stale, and a record that comes back is rewritten live again.
 *  E3. Context page identity does not depend on row order: swapping the load
 *      order, or adding a second per_record row that sorts first, leaves every
 *      existing page unchanged.
 *  E4. A planned title still held by another record's stored page takes the
 *      id form, instead of failing the write on the unique title every run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const A = 'TMC-0001';

const db = vi.hoisted(() => ({
  integrations: [] as any[],
  versions: [] as any[],
  suggestions: [] as any[],
  runs: [] as any[],
  changes: [] as any[],
  defs: [] as any[],
  readings: [] as any[],
  pages: [] as any[],
  writes: [] as string[],
  sheet: { headers: [] as string[], records: [] as Record<string, string>[], truncated: false },
  maxPages: 500,
  failReadings: false,
  seq: 0,
}));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/db/tenantContext', () => ({ runWithoutTenant: (fn: () => Promise<unknown>) => fn() }));
vi.mock('../src/services/userTimezoneService', () => ({ isValidTimezone: () => true, resolveUserTimezone: async () => 'Asia/Karachi' }));
vi.mock('../src/services/behaviorConfig', () => ({ getBehaviorValue: async (k: string) => (k === 'integrations.max_context_pages' ? db.maxPages : 0) }));
vi.mock('../src/services/knowledge/wikiEmbeddingService', () => ({ embedWikiPage: async () => {} }));
vi.mock('../src/services/integrations/sources/gsheetReader', () => ({
  readGsheet: async () => ({
    records: db.sheet.records.map((r) => ({ ...r })), headers: db.sheet.headers, rowCount: db.sheet.records.length,
    truncated: db.sheet.truncated, anomalies: [], sourceLabel: 'Ops › Regions',
  }),
}));
// Call-through spies on the ONE helper, so a test can see who called it and how.
vi.mock('../src/services/knowledge/tenantOrgDoc', async (importOriginal) => {
  const real: any = await importOriginal();
  return { ...real, upsertTenantOrgDoc: vi.fn(real.upsertTenantOrgDoc), findTenantOrgDoc: vi.fn(real.findTenantOrgDoc) };
});
// Folder scribe dependencies (Drive + the summary model) — never reached for real.
vi.mock('googleapis', () => ({
  google: {
    drive: () => ({
      files: {
        list: async () => ({ data: { files: [{ id: 'f1', name: 'SOP', mimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-01' }] } }),
        export: async () => ({ data: 'The standard operating procedure for refunds is ...' }),
      },
    }),
  },
}));
vi.mock('../src/services/integrationService', () => ({ getAuthenticatedClient: async () => ({ client: {} }) }));
vi.mock('../src/services/llmRouter', () => ({ callLLM: async () => ({ text: '- Purpose: refunds SOP, short summary.' }) }));

vi.mock('../src/db/prisma', () => {
  const matches = (row: any, where: any = {}): boolean => Object.entries(where).every(([k, v]: [string, any]) => {
    if (k === 'metadata' && v?.path) return row.metadata?.[v.path[0]] === v.equals;
    if (v && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
    if (v && typeof v === 'object' && 'not' in v) return row[k] !== v.not;
    return row[k] === v;
  });
  const pick = (row: any, select?: any) => {
    if (!select) return row;
    const o: any = {};
    for (const k of Object.keys(select)) o[k] = row[k];
    return o;
  };
  const p: any = {
    integrationSync: {
      findFirst: async ({ where }: any) => db.integrations.find((r) => matches(r, where)) ?? null,
      updateMany: async ({ where, data }: any) => {
        const rows = db.integrations.filter((r) => matches(r, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
    },
    integrationMappingVersion: {
      findFirst: async ({ where, select }: any) => {
        const rows = db.versions.filter((r) => matches(r, where));
        return rows[0] ? pick(rows[0], select) : null;
      },
    },
    integrationSuggestion: {
      findMany: async ({ where, select }: any) => db.suggestions.filter((r) => matches(r, where)).map((r) => pick(r, select)),
      count: async ({ where }: any) => db.suggestions.filter((r) => matches(r, where)).length,
    },
    integrationRun: {
      create: async ({ data }: any) => {
        const row = { id: `run${++db.seq}`, ...data };
        db.runs.push(row);
        return { id: row.id };
      },
      updateMany: async ({ where, data }: any) => {
        const rows = db.runs.filter((r) => matches(r, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
    },
    integrationRunChange: {
      createMany: async ({ data }: any) => { db.writes.push('change.createMany'); db.changes.push(...data); return { count: data.length }; },
      create: async ({ data }: any) => { db.writes.push('change.create'); db.changes.push(data); return data; },
    },
    kpiDefinition: { findMany: async ({ where, select }: any) => db.defs.filter((r) => matches(r, where)).map((r) => pick(r, select)) },
    kpiReading: {
      findMany: async ({ where }: any) => db.readings.filter((r) => matches(r, where)).map((r) => ({
        kpiKey: r.kpiKey, periodStart: new Date(`${r.periodStart}T00:00:00Z`), dimensionKey: r.dimensionKey, value: r.value,
      })),
      count: async ({ where }: any) => db.readings.filter((r) => matches(r, where)).length,
    },
    wikiPage: {
      findFirst: async ({ where, select }: any) => { const r = db.pages.find((x) => matches(x, where)); return r ? pick(r, select) : null; },
      findMany: async ({ where, select }: any) => db.pages.filter((x) => matches(x, where)).map((r) => pick({ ...r }, select)),
      create: async ({ data }: any) => { db.writes.push('wikiPage.create'); const row = { id: `w${++db.seq}`, ...data }; db.pages.push(row); return row; },
      update: async ({ where, data }: any) => { db.writes.push('wikiPage.update'); const r = db.pages.find((x) => x.id === where.id); Object.assign(r, data); return r; },
      updateMany: async ({ where, data }: any) => {
        db.writes.push('wikiPage.updateMany');
        const rows = db.pages.filter((x) => matches(x, where));
        rows.forEach((r) => Object.assign(r, data));
        return { count: rows.length };
      },
    },
    $transaction: async (fn: any) => {
      db.writes.push('$transaction');
      const snapR = db.readings.map((r) => ({ ...r }));
      const snapC = db.changes.slice();
      const tx = {
        $queryRaw: async (_s: TemplateStringsArray, ...values: any[]) => {
          if (db.failReadings) throw new Error('deadlock');
          const [cn, integrationId, , keys, periods, dims, vals] = values;
          const out: any[] = [];
          keys.forEach((k: string, i: number) => {
            const hit = db.readings.find((r) => r.kpiKey === k && r.periodStart === periods[i] && r.dimensionKey === dims[i]);
            if (!hit) {
              db.readings.push({ clientNumber: cn, kpiKey: k, periodStart: periods[i], dimensionKey: dims[i], value: vals[i], integrationId });
              out.push({ kpi_key: k, period_start: periods[i], dimension_key: dims[i], inserted: true });
            } else if (Number(hit.value) !== Number(vals[i])) {
              hit.value = vals[i];
              out.push({ kpi_key: k, period_start: periods[i], dimension_key: dims[i], inserted: false });
            }
          });
          return out;
        },
        integrationRunChange: { createMany: async ({ data }: any) => { db.writes.push('tx.change.createMany'); db.changes.push(...data); return { count: data.length }; } },
        integrationRun: p.integrationRun,
        integrationSync: p.integrationSync,
      };
      try { return await fn(tx); } catch (e) { db.readings = snapR; db.changes = snapC; throw e; }
    },
  };
  return { __esModule: true, default: p, prisma: p };
});

import { runIntegration } from '../src/services/integrations/engine/runEngine';
import { connectionFingerprint } from '../src/services/integrations/store/integrationStore';
import { upsertTenantOrgDoc } from '../src/services/knowledge/tenantOrgDoc';
import { diffContextPages, planContextPages } from '../src/services/integrations/engine/contextWriter';

const CFG = { sheetId: 'sheet123', gid: '0', link: 'https://docs.google.com/spreadsheets/d/sheet123/edit#gid=0' };
const live = { dryRun: false, trigger: 'manual' as const, triggeredBy: 'user:7' };
const scheduled = { dryRun: false, trigger: 'scheduled' as const, triggeredBy: 'scheduler' };
const dry = { dryRun: true, trigger: 'manual' as const, triggeredBy: 'user:7', versionId: 'v1' };

function seed() {
  db.integrations = [{
    id: 'i1', clientNumber: A, name: 'Regions', sourceKind: 'gsheet', sourceConfig: CFG, status: 'ACTIVE',
    frequency: 'daily', runTime: '06:00', dayOfWeek: null, dayOfMonth: null, timezone: 'Asia/Karachi',
    changeCapPct: 25, blankPolicy: 'abnormal', connectionTestedAt: new Date(),
    connectionFingerprint: connectionFingerprint('gsheet', CFG), activatedAt: new Date(), approvedVersionId: 'v1',
    createdBy: 7, approvedFilter: null, apiConfig: null,
  }];
  db.versions = [{ id: 'v1', clientNumber: A, integrationId: 'i1', version: 1 }];
  const base = { clientNumber: A, integrationId: 'i1', mappingVersionId: 'v1', status: 'APPROVED' };
  db.suggestions = [
    { ...base, id: 's1', targetKind: 'kpi', sourceField: 'Revenue', targetKey: 'kpi:revenue', transform: { mode: 'long', valueField: 'Revenue', periodField: 'Month', dimensionField: 'Region' } },
    { ...base, id: 's2', targetKind: 'context', sourceField: 'Region', targetKey: 'context:per_record', transform: { mode: 'per_record', titleField: 'Region', bodyFields: ['Manager', 'Status'] } },
  ];
  db.defs = [{ clientNumber: A, kpiKey: 'revenue', label: 'Revenue', unit: null, isActive: true, sourceIntegrationId: 'i1', grain: 'month' }];
  db.sheet = {
    headers: ['Month', 'Region', 'Revenue', 'Manager', 'Status'],
    records: [
      { Month: 'Jan 2026', Region: 'North', Revenue: '100', Manager: 'Sara', Status: 'Active' },
      { Month: 'Jan 2026', Region: 'South', Revenue: '200', Manager: 'Ali', Status: 'Active' },
      { Month: 'Jan 2026', Region: 'East', Revenue: '300', Manager: 'Omar', Status: 'Closed' },
    ],
    truncated: false,
  };
  db.runs = []; db.changes = []; db.readings = []; db.pages = []; db.writes = [];
  db.maxPages = 500; db.failReadings = false;
  vi.mocked(upsertTenantOrgDoc).mockClear();
}
beforeEach(seed);


const ctxChanges = () => db.changes.filter((c) => c.targetKind === 'context');
const pageWrites = () => db.writes.filter((w) => w.startsWith('wikiPage'));

describe('E1 — a dry run previews only its own version\'s filter', () => {
  it('the running version\'s approved_filter is NOT applied to a version that has no filter row', async () => {
    // V1 is running with "Status equals active"; the version under test withdrew it.
    db.integrations[0].approvedFilter = { match: 'all', conditions: [{ field: 'Status', op: 'equals', value: 'active' }] };
    const r = await runIntegration(A, 'i1', dry);
    expect(r.filteredOut).toBe(0);
    expect(ctxChanges().map((c) => c.subjectLabel)).toContain('Regions · East');
  });

  it('a live run still applies integration.approved_filter (the running version\'s)', async () => {
    db.integrations[0].approvedFilter = { match: 'all', conditions: [{ field: 'Status', op: 'equals', value: 'active' }] };
    const r = await runIntegration(A, 'i1', live);
    expect(r.filteredOut).toBe(1);
  });
});

describe('E2 — the stale mark survives the wiki linter', () => {
  async function staleEast() {
    await runIntegration(A, 'i1', live);
    db.sheet.records = db.sheet.records.slice(0, 2);
    await runIntegration(A, 'i1', live);
    // The hourly linter: every page with no links/sources becomes 'orphan'.
    db.pages.forEach((p) => { p.status = 'orphan'; });
    db.changes = []; db.writes = [];
  }

  it('a staled page is not staled again on the next run', async () => {
    await staleEast();
    const east = db.pages.find((p) => p.title === 'Regions · East');
    expect(east.metadata.integrationStale).toBe(true);
    const r: any = await runIntegration(A, 'i1', live);
    expect(r.context.stale).toBe(0);
    expect(ctxChanges()).toEqual([]);
    expect(pageWrites()).toEqual([]);
  });

  it('a scheduled run is not pushed over the change cap by pages already staled', async () => {
    await staleEast();
    const r = await runIntegration(A, 'i1', scheduled);
    expect(r.status).toBe('SUCCESS');
    expect(r.capVerdict.wouldTrip).toBe(false);
  });

  it('the stale page says so in its body (Brain retrieval does not filter by status)', async () => {
    await staleEast();
    expect(db.pages.find((p) => p.title === 'Regions · East').bodyMarkdown).toMatch(/no longer in the source/);
  });

  it('a record that comes back is rewritten live, even with unchanged content', async () => {
    await staleEast();
    db.sheet.records.push({ Month: 'Jan 2026', Region: 'East', Revenue: '300', Manager: 'Omar', Status: 'Closed' });
    const r: any = await runIntegration(A, 'i1', live);
    expect(r.context.updated).toBe(1);
    const east = db.pages.find((p) => p.title === 'Regions · East');
    expect(east.metadata.integrationStale).toBeUndefined();
    expect(east.status).toBe('active');
    expect(east.bodyMarkdown).not.toMatch(/no longer in the source/);
  });
});

describe('E3 — page identity does not depend on row order', () => {
  const second = () => ({ clientNumber: A, integrationId: 'i1', mappingVersionId: 'v1', status: 'APPROVED', id: 's9',
    targetKind: 'context', sourceField: 'Manager', targetKey: 'context:per_record',
    transform: { mode: 'per_record', titleField: 'Manager', bodyFields: ['Region'] } });

  it('the same rows loaded in another order change nothing', async () => {
    db.suggestions.push(second());
    await runIntegration(A, 'i1', live);
    db.suggestions.reverse();
    db.changes = []; db.writes = [];
    const r: any = await runIntegration(A, 'i1', live);
    expect(ctxChanges()).toEqual([]);
    expect(r.context).toMatchObject({ created: 0, updated: 0, unchanged: 6 });
  });

  it('adding a row that sorts first keeps the existing row\'s pages (it still owns the bare key)', async () => {
    await runIntegration(A, 'i1', live);
    const before = db.pages.map((p) => [p.metadata.recordKey, p.bodyMarkdown]);
    db.suggestions.unshift(second());
    db.changes = []; db.writes = [];
    const r: any = await runIntegration(A, 'i1', live);
    expect(r.context).toMatchObject({ created: 3, updated: 0, unchanged: 3 });
    expect(db.pages.slice(0, 3).map((p) => [p.metadata.recordKey, p.bodyMarkdown])).toEqual(before);
  });
});

describe('E4 — titles are chosen against stored pages too', () => {
  it('a record whose plain title another record\'s page still holds keeps the id form', () => {
    const integ = { id: 'i1', name: 'HR' };
    const rows: any = [{ suggestionId: 's1', targetKey: 'context:per_record', transform: { mode: 'per_record', titleField: 'name', bodyFields: ['dept'] } }];
    const stored: any[] = [
      { id: 'w5', title: 'HR · Ali Khan', status: 'active', bodyMarkdown: 'x', metadata: { integrationId: 'i1', recordKey: 'i1:5', contentHash: 'h5' } },
      { id: 'w9', title: 'HR · Ali Khan (9)', status: 'active', bodyMarkdown: 'y', metadata: { integrationId: 'i1', recordKey: 'i1:9', contentHash: 'h9' } },
    ];
    // Employee 5 was filtered out; employee 9 is planned alone and changed.
    const plan = planContextPages(integ, [{ id: '9', name: 'Ali Khan', dept: 'Sales' }], rows, 'id', 500);
    expect(plan.pages[0].title).toBe('HR · Ali Khan');
    const diff = diffContextPages(plan, stored, 1, true);
    const upd = diff.ops.find((o) => o.op === 'update') as any;
    expect(upd.existing.id).toBe('w9');
    expect(upd.page.title).toBe('HR · Ali Khan (9)');
  });
});
