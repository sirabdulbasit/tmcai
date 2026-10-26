/**
 * DEF-362 — Integrations Stage 1b: the run engine with Context rows and the
 * approved record filter (engine/runEngine.ts + engine/contextWriter.ts), and
 * the folder scribe still writing through the shared helper.
 *
 * Rules pinned (spec INTEGRATIONS_DESIGN.md §2b, §2.4, §3):
 *  - a dry run writes NO wiki page — only its preview change rows — and says
 *    what it would create / update / mark stale;
 *  - a live run writes readings in their transaction FIRST, then the pages,
 *    each with its change row; nothing of either if the readings fail;
 *  - an unchanged page is skipped (no write, no change row);
 *  - a record gone from the source ⇒ page 'stale';
 *  - the APPROVED filter is applied before planning (KPI and Context), counted
 *    as filteredOut; a filter on a field the data lacks FAILS the run; a dry run
 *    previews its own version's approved filter row;
 *  - the change cap counts page rewrites like reading rewrites;
 *  - the page cap ⇒ PARTIAL with a note;
 *  - a Context row reading a missing field FAILS the run;
 *  - folderScribe still calls upsertTenantOrgDoc with lastUpdatedBy 'facl_scribe'.
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
import { scribeFaclFolder } from '../src/services/knowledge/folderScribeService';

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

const pageWrites = () => db.writes.filter((w) => w.startsWith('wikiPage'));

describe('DEF-362 run engine — Context', () => {
  it('dry run writes NO wiki page; previews create counts + examples as change rows', async () => {
    const r: any = await runIntegration(A, 'i1', dry);
    expect(r.status).toBe('SUCCESS');
    expect(pageWrites()).toEqual([]);
    expect(db.pages).toEqual([]);
    expect(upsertTenantOrgDoc).not.toHaveBeenCalled();
    const ctx = db.changes.filter((c) => c.targetKind === 'context');
    expect(ctx.map((c) => c.op)).toEqual(['create', 'create', 'create']);
    expect(r.context).toMatchObject({ created: 3, updated: 0, stale: 0 });
    expect(r.anomalies.join(' ')).toMatch(/would create 3 \(e\.g\. "Regions · North"/);
    expect(r.writes).toBe(6); // 3 readings + 3 pages a live run would write
  });

  it('live: readings in their transaction first, then pages through the helper with change rows', async () => {
    const r: any = await runIntegration(A, 'i1', live);
    expect(r).toMatchObject({ status: 'SUCCESS', writes: 6 });
    expect(db.readings).toHaveLength(3);
    expect(db.pages.map((p) => p.title)).toEqual(['Regions · North', 'Regions · South', 'Regions · East']);
    expect(db.pages.every((p) => p.scope === 'tenant' && p.pageType === 'org_doc' && p.userId === 7 && p.lastUpdatedBy === 'integration')).toBe(true);
    expect(db.writes.indexOf('$transaction')).toBeLessThan(db.writes.indexOf('wikiPage.create'));
    expect(db.changes.filter((c) => c.targetKind === 'context')).toHaveLength(3);
    expect(db.runs[0].status).toBe('SUCCESS');
  });

  it('failed readings transaction ⇒ FAILED, and no page is written', async () => {
    db.failReadings = true;
    const r = await runIntegration(A, 'i1', live);
    expect(r.status).toBe('FAILED');
    expect(pageWrites()).toEqual([]);
  });

  it('second identical run: unchanged pages skipped — no page write, no change row', async () => {
    await runIntegration(A, 'i1', live);
    db.writes = []; db.changes = [];
    const r: any = await runIntegration(A, 'i1', live);
    expect(pageWrites()).toEqual([]);
    expect(db.changes).toEqual([]);
    expect(r.context).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    expect(r.writes).toBe(0);
  });

  it('a record gone from the source ⇒ its page is marked stale (never deleted)', async () => {
    await runIntegration(A, 'i1', live);
    db.sheet.records = db.sheet.records.slice(0, 2);
    const r: any = await runIntegration(A, 'i1', live);
    expect(r.context.stale).toBe(1);
    expect(db.pages).toHaveLength(3);
    expect(db.pages.find((p) => p.title === 'Regions · East').status).toBe('stale');
    expect(db.changes.at(-1)).toMatchObject({ op: 'stale', targetKind: 'context' });
  });

  it('a truncated read never marks pages stale', async () => {
    await runIntegration(A, 'i1', live);
    db.sheet.records = db.sheet.records.slice(0, 1);
    db.sheet.truncated = true;
    const r: any = await runIntegration(A, 'i1', live);
    expect(r.status).toBe('PARTIAL');
    expect(db.pages.every((p) => p.status === 'active')).toBe(true);
  });

  it('page cap ⇒ PARTIAL with a note', async () => {
    db.maxPages = 2;
    const r: any = await runIntegration(A, 'i1', live);
    expect(r.status).toBe('PARTIAL');
    expect(db.pages).toHaveLength(2);
    expect(r.anomalies.join(' ')).toMatch(/max_context_pages/);
  });

  it('change cap counts page rewrites like reading rewrites (scheduled run ABORTED, nothing written)', async () => {
    // Revenue unchanged, but every page's Manager changed: 0 reading rewrites, 3 page rewrites.
    await runIntegration(A, 'i1', live);
    db.sheet.records.forEach((r) => { r.Manager = `${r.Manager} 2`; });
    db.writes = [];
    const r = await runIntegration(A, 'i1', scheduled);
    expect(r.status).toBe('ABORTED');
    expect(r.capVerdict.wouldTrip).toBe(true);
    expect(pageWrites()).toEqual([]);
    expect(db.pages[0].bodyMarkdown).not.toContain('Sara 2');
  });

  it('a Context row reading a missing field FAILS the run', async () => {
    db.sheet.headers = db.sheet.headers.filter((h) => h !== 'Manager');
    const r = await runIntegration(A, 'i1', live);
    expect(r.status).toBe('FAILED');
    expect(r.error).toMatch(/"Manager".*Context/);
    expect(pageWrites()).toEqual([]);
  });
});

describe('DEF-362 run engine — approved filter', () => {
  it('applied BEFORE planning: filtered records reach neither KPI nor page; counted', async () => {
    db.integrations[0].approvedFilter = { match: 'all', conditions: [{ field: 'Status', op: 'equals', value: 'active' }] };
    const r = await runIntegration(A, 'i1', live);
    expect(r.filteredOut).toBe(1);
    expect(db.readings.map((x) => x.dimensionKey).sort()).toEqual(['Region=North', 'Region=South']);
    expect(db.pages.map((p) => p.title)).not.toContain('Regions · East');
    expect(db.runs[0].recordsFiltered).toBe(1);
  });

  it('nothing filters until approved: no approved filter ⇒ every record runs', async () => {
    const r = await runIntegration(A, 'i1', live);
    expect(r.filteredOut).toBe(0);
    expect(db.readings).toHaveLength(3);
  });

  it('a filter on a field the data lacks FAILS the run, writing nothing', async () => {
    db.integrations[0].approvedFilter = { match: 'all', conditions: [{ field: 'Country', op: 'equals', value: 'PK' }] };
    const r = await runIntegration(A, 'i1', live);
    expect(r.status).toBe('FAILED');
    expect(r.error).toMatch(/"Country"/);
    expect(db.readings).toEqual([]);
    expect(pageWrites()).toEqual([]);
  });

  it('a dry run previews its own version\'s APPROVED filter row', async () => {
    db.suggestions.push({ clientNumber: A, integrationId: 'i1', mappingVersionId: 'v1', status: 'APPROVED', id: 's3', targetKind: 'filter',
      sourceField: 'Status', targetKey: 'filter', transform: { match: 'all', conditions: [{ field: 'Status', op: 'equals', value: 'closed' }] } });
    const r = await runIntegration(A, 'i1', dry);
    expect(r.filteredOut).toBe(2);
    expect(db.changes.filter((c) => c.targetKind === 'context').map((c) => c.subjectLabel)).toEqual(['Regions · East']);
  });

  it('KPI-only Stage 1 integrations never touch wiki pages', async () => {
    db.suggestions = db.suggestions.filter((s) => s.targetKind === 'kpi');
    const r: any = await runIntegration(A, 'i1', live);
    expect(r.status).toBe('SUCCESS');
    expect(pageWrites()).toEqual([]);
    expect(r.context).toBeUndefined();
  });
});

describe('folder scribe still writes through the shared helper', () => {
  it('calls upsertTenantOrgDoc with its own lastUpdatedBy, scope tenant; an unchanged doc is not rewritten', async () => {
    const s1 = await scribeFaclFolder(A, 9, 'folder1');
    expect(s1.updated).toBe(1);
    expect(upsertTenantOrgDoc).toHaveBeenCalledTimes(1);
    expect(vi.mocked(upsertTenantOrgDoc).mock.calls[0][1]).toMatchObject({ userId: 9, title: 'SOP', lastUpdatedBy: 'facl_scribe' });
    expect(db.pages[0]).toMatchObject({ lastUpdatedBy: 'facl_scribe', scope: 'tenant', pageType: 'org_doc', title: 'SOP' });
    const s2 = await scribeFaclFolder(A, 9, 'folder1');
    expect(s2).toMatchObject({ unchanged: 1, updated: 0 });
    expect(upsertTenantOrgDoc).toHaveBeenCalledTimes(1);
  });
});
