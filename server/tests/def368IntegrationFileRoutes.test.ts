/**
 * DEF-368 — the uploaded-file source over HTTP: POST /:id/source-file, the tab
 * through PUT /:id {sheetName}, connection-check, and the store rules behind
 * them (store/sourceFileStore.ts, integrationStore 'file' branches).
 *
 * Drives the REAL router with the REAL integrationStore, sourceFileStore,
 * source router and fileReader (the workbook is opened in the real worker) on
 * the in-memory FakeDb; only auth, the doc reader and the job runners are mocked.
 *
 * Rules pinned:
 *  U1 upload stores THE copy and answers {file:{fileName,sizeBytes,uploadedAt,tabs}, integration}
 *     with sourceConfig {fileName, sha256} and sourceFile — never the bytes, on any response.
 *  U2 the cap: over integrations.file_max_bytes ⇒ 413, nothing stored; no file ⇒ 400.
 *  U3 tenant scoping: another tenant's id is a 404 and nothing is stored or read.
 *  U4 only a 'file' integration takes an upload (sourceKind refused otherwise);
 *     a link on a file integration / a tab on another kind is refused.
 *  U5 connection-check reads the stored copy: ONE sample row; a NEW upload clears
 *     the test, the SAME bytes again do not.
 *  U6 the tab: PUT sheetName only to a tab the stored file has (400 naming the tabs),
 *     and choosing another tab clears the test.
 *  U7 an ACTIVE integration refuses a new upload and a tab change (pause first).
 *  U8 fingerprint: sha256 + sheetName, never the file name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import xlsx from 'xlsx';
import { makeFakeDb } from './def354IntegrationFakeDb';

const A = 'TMC-0001';
const B = 'OTHER-9';
const SLOW = 60_000;
const MAX = 64 * 1024;

const h = vi.hoisted(() => ({ db: null as any }));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/db/prisma', () => {
  const p = new Proxy({}, { get: (_t, k) => h.db.prisma[k] });
  return { __esModule: true, default: p, prisma: p };
});
vi.mock('../src/middleware/auth', () => ({
  __esModule: true,
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireAdmin: (_req: any, _res: any, next: any) => next(),
}));
vi.mock('../src/services/userTimezoneService', () => ({
  isValidTimezone: (tz: unknown) => typeof tz === 'string' && tz.length > 0,
  resolveUserTimezone: async () => 'Asia/Karachi',
}));
vi.mock('../src/services/behaviorConfig', async (orig) => ({
  ...(await orig<any>()),
  getBehaviorValue: async (key: string) => (key === 'integrations.file_max_bytes' ? MAX : key === 'integrations.max_rows' ? 50000 : 500),
}));
vi.mock('../src/services/integrations/sources/docReader', async (orig) => ({
  ...(await orig<any>()),
  attachApiDocument: vi.fn(),
  readApiDocument: vi.fn(),
}));
vi.mock('../src/services/integrations/mapping/proposalJobs', () => ({ startProposalJob: vi.fn(), getProposalJob: vi.fn() }));
vi.mock('../src/services/integrations/engine/runJobs', () => ({
  startRun: vi.fn(), getRunStatus: vi.fn(), listRuns: vi.fn(), listRunChanges: vi.fn(),
}));

import router from '../src/routes/admin/integrationAdminRoutes';
import { currentFingerprint, fileConnectionFingerprint } from '../src/services/integrations/store/integrationStore';
import { INTEGRATION_INPUT_KEYS } from '../src/services/integrations/types';

let nextUserId = 700;
function appAs(cn = A) {
  const id = nextUserId++;
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req: any, _res, next) => { req.user = { id, clientNumber: cn, isAdmin: true, isSuperAdmin: false }; next(); });
  app.use('/api/v1/admin/integrations', router);
  return app;
}
const P = '/api/v1/admin/integrations';
const CSV = Buffer.from('Month,Revenue\n2026-01,100\n2026-02,120\n');
const CSV2 = Buffer.from('Month,Revenue\n2026-01,100\n2026-02,125\n');

function workbook(): Buffer {
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([['Note'], ['summary']]), 'Summary');
  xlsx.utils.book_append_sheet(wb, xlsx.utils.aoa_to_sheet([['Month', 'Revenue'], ['2026-01', 5]]), 'Monthly data');
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

beforeEach(() => { h.db = makeFakeDb(); });

async function create(app: any, extra: Record<string, unknown> = {}) {
  const r = await request(app).post(`${P}/`).send({ name: `Sales ${Math.random()}`, sourceKind: 'file', ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.integration.id as string;
}
const upload = (app: any, id: string, buf: Buffer, name = 'sales.csv') =>
  request(app).post(`${P}/${id}/source-file`).attach('file', buf, name);
const row = (id: string) => h.db.tables.integrationSync.find((r: any) => r.id === id);
const files = () => h.db.tables.integrationSourceFile as any[];

describe('U1 — upload stores the copy; never the bytes back', () => {
  it('answers {file, integration} with sourceConfig and sourceFile; GET /:id and GET / carry no bytes', async () => {
    const app = appAs();
    const id = await create(app);
    const r = await upload(app, id, CSV, 'C:\\Users\\me\\sales.csv');
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.file).toEqual({ fileName: 'sales.csv', sizeBytes: CSV.length, uploadedAt: expect.any(String), tabs: [] });
    expect(r.body.integration.sourceConfig).toEqual({ fileName: 'sales.csv', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(r.body.integration.sourceFile).toEqual({ fileName: 'sales.csv', sizeBytes: CSV.length, uploadedAt: expect.any(String) });
    expect(files()).toHaveLength(1);
    expect(files()[0]).toMatchObject({ integrationId: id, clientNumber: A, sizeBytes: CSV.length });
    const bodies = [
      JSON.stringify(r.body),
      JSON.stringify((await request(app).get(`${P}/${id}`)).body),
      JSON.stringify((await request(app).get(`${P}/`)).body),
      JSON.stringify((await request(app).get(`${P}/${id}/source-file`)).body),
    ];
    for (const b of bodies) {
      expect(b).not.toContain('2026-02,120');
      expect(b).not.toContain(CSV.toString('base64'));
      expect(b).not.toMatch(/"bytes"/);
    }
  });
  it('a re-upload REPLACES the one stored copy', async () => {
    const app = appAs();
    const id = await create(app);
    await upload(app, id, CSV);
    await upload(app, id, CSV2, 'sales v2.csv');
    expect(files()).toHaveLength(1);
    expect(files()[0].filename).toBe('sales v2.csv');
  });
});

describe('U2 — the cap', () => {
  it('over integrations.file_max_bytes ⇒ 413 and nothing stored', async () => {
    const app = appAs();
    const id = await create(app);
    const big = Buffer.concat([Buffer.from('a,b\n'), Buffer.alloc(MAX, 0x31)]);
    const r = await upload(app, id, big);
    expect(r.status).toBe(413);
    expect(r.body.field).toBe('file');
    expect(r.body.error).toMatch(/the limit is 64 KB/);
    expect(files()).toHaveLength(0);
    expect(row(id).sourceConfig).toEqual({});
  });
  it('no file ⇒ 400; a non-spreadsheet ⇒ 400 and nothing stored', async () => {
    const app = appAs();
    const id = await create(app);
    expect((await request(app).post(`${P}/${id}/source-file`).send({})).status).toBe(400);
    const r = await upload(app, id, Buffer.from('<!DOCTYPE html><p>hi</p>'), 'x.csv');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/web page/);
    expect(files()).toHaveLength(0);
  });
});

describe('U3 — tenant scoping', () => {
  it("another tenant's id is a 404 — nothing stored, nothing read", async () => {
    const id = await create(appAs(A));
    const other = appAs(B);
    expect((await upload(other, id, CSV)).status).toBe(404);
    expect(files()).toHaveLength(0);
    await upload(appAs(A), id, CSV);
    expect((await request(other).get(`${P}/${id}/source-file`)).status).toBe(404);
    expect((await request(other).get(`${P}/${id}/connection-check`)).status).toBe(404);
    expect((await request(other).put(`${P}/${id}`).send({ sheetName: null })).status).toBe(404);
    for (const c of h.db.calls.filter((x: any) => x.model === 'integrationSourceFile')) {
      expect(c.args.where?.clientNumber ?? c.args.data?.clientNumber, JSON.stringify(c.args)).toBe(A);
    }
  });
});

describe('U4 — only a file integration takes a file; fields match the kind', () => {
  it('a Google Sheet integration refuses the upload', async () => {
    const app = appAs();
    const r0 = await request(app).post(`${P}/`).send({ name: 'Sheet', sourceKind: 'gsheet' });
    const r = await upload(app, r0.body.integration.id, CSV);
    expect(r.status).toBe(400);
    expect(r.body.field).toBe('sourceKind');
    expect(files()).toHaveLength(0);
  });
  it('a link on a file integration, a tab on a sheet one, and a tab at create are refused', async () => {
    const app = appAs();
    const id = await create(app);
    expect((await request(app).put(`${P}/${id}`).send({ link: 'https://docs.google.com/spreadsheets/d/abc/edit#gid=0' })).status).toBe(400);
    const s = await request(app).post(`${P}/`).send({ name: 'Sheet', sourceKind: 'gsheet' });
    expect((await request(app).put(`${P}/${s.body.integration.id}`).send({ sheetName: 'Data' })).status).toBe(400);
    expect((await request(app).post(`${P}/`).send({ name: 'X', sourceKind: 'file', sheetName: 'Data' })).status).toBe(400);
  });
  it('the whitelist carries sheetName (and still never the bytes or a fingerprint)', () => {
    const keys = new Set<string>(INTEGRATION_INPUT_KEYS as readonly string[]);
    expect(keys.has('sheetName')).toBe(true);
    for (const k of ['sourceFile', 'bytes', 'sha256', 'connectionFingerprint']) expect(keys.has(k), k).toBe(false);
  });
});

describe('U5 — connection-check reads the stored copy', () => {
  it('ONE sample row; a NEW upload clears the test, the SAME bytes do not', async () => {
    const app = appAs();
    const id = await create(app);
    const before = await request(app).get(`${P}/${id}/connection-check`);
    expect(before.status).toBe(400);
    expect(before.body.field).toBe('file');
    await upload(app, id, CSV);
    const c = await request(app).get(`${P}/${id}/connection-check`);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.ok).toBe(true);
    expect(c.body.sampleRecord).toEqual({ Month: '2026-01', Revenue: '100' });
    expect(c.body.columns).toEqual(['Month', 'Revenue']);
    expect(c.body.integration.connectionOk).toBe(true);

    const same = await upload(app, id, CSV, 'renamed.csv');
    expect(same.body.integration.connectionOk).toBe(true);
    const fresh = await upload(app, id, CSV2);
    expect(fresh.body.integration.connectionOk).toBe(false);
    expect(row(id).connectionTestedAt).toBeNull();
  });
});

describe('U6 — the tab', () => {
  it('upload lists the tabs; PUT sheetName to a real tab clears the test; an unknown tab is refused naming the tabs', async () => {
    const app = appAs();
    const id = await create(app);
    const u = await upload(app, id, workbook(), 'sales.xlsx');
    expect(u.status, JSON.stringify(u.body)).toBe(201);
    expect(u.body.file.tabs).toEqual(['Summary', 'Monthly data']);
    const c = await request(app).get(`${P}/${id}/connection-check`);
    expect(c.body.sampleRecord).toEqual({ Note: 'summary' }); // the first sheet by default
    expect(c.body.integration.connectionOk).toBe(true);

    const bad = await request(app).put(`${P}/${id}`).send({ sheetName: 'Nope' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/no tab "Nope".*"Summary", "Monthly data"/);
    expect(bad.body.field).toBe('sheetName');

    const ok = await request(app).put(`${P}/${id}`).send({ sheetName: 'Monthly data' });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.integration.sourceConfig.sheetName).toBe('Monthly data');
    expect(ok.body.integration.connectionOk).toBe(false);
    const c2 = await request(app).get(`${P}/${id}/connection-check`);
    expect(c2.body.sampleRecord).toEqual({ Month: '2026-01', Revenue: '5' });

    const info = await request(app).get(`${P}/${id}/source-file`);
    expect(info.body.file.tabs).toEqual(['Summary', 'Monthly data']);
  }, SLOW);
  it('a CSV upload drops a chosen tab (a CSV has none)', async () => {
    const app = appAs();
    const id = await create(app);
    await upload(app, id, workbook(), 'sales.xlsx');
    await request(app).put(`${P}/${id}`).send({ sheetName: 'Monthly data' });
    const r = await upload(app, id, CSV);
    expect(r.body.integration.sourceConfig.sheetName).toBeUndefined();
  }, SLOW);
});

describe('U7 — an ACTIVE integration keeps the file it was tested with', () => {
  it('refuses a new upload and a tab change', async () => {
    const app = appAs();
    const id = await create(app);
    await upload(app, id, CSV);
    row(id).status = 'ACTIVE';
    const r = await upload(app, id, CSV2);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Pause this integration/);
    expect(files()[0].sha256).toBe(row(id).sourceConfig.sha256);
  });
  it('refuses a tab change while ACTIVE', async () => {
    const app = appAs();
    const id = await create(app);
    await upload(app, id, workbook(), 'sales.xlsx');
    row(id).status = 'ACTIVE';
    const r = await request(app).put(`${P}/${id}`).send({ sheetName: 'Monthly data' });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Pause this integration before changing its file or tab/);
    expect(row(id).sourceConfig.sheetName).toBeUndefined();
  }, SLOW);
});

describe('U8 — the fingerprint', () => {
  it('covers sha256 + sheetName, never the file name', () => {
    const sha = 'a'.repeat(64);
    const base = fileConnectionFingerprint({ fileName: 'a.xlsx', sha256: sha });
    expect(fileConnectionFingerprint({ fileName: 'renamed.xlsx', sha256: sha })).toBe(base);
    expect(fileConnectionFingerprint({ fileName: 'a.xlsx', sha256: 'b'.repeat(64) })).not.toBe(base);
    expect(fileConnectionFingerprint({ fileName: 'a.xlsx', sha256: sha, sheetName: 'Data' })).not.toBe(base);
    const cols = { sourceKind: 'file', apiConfig: null, secretSetAt: null };
    expect(currentFingerprint({ ...cols, sourceConfig: { fileName: 'a.xlsx', sha256: sha } })).toBe(base);
    expect(currentFingerprint({ ...cols, sourceConfig: {} })).toBeNull();
    // A sheet config under kind 'file' is not a file connection.
    expect(currentFingerprint({ ...cols, sourceConfig: { sheetId: 'x', gid: '0', link: '' } })).toBeNull();
  });
});
