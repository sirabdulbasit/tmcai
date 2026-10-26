/**
 * DEF-362 — Admin → Integrations, Stage 1b endpoints and the store/mapping
 * rules behind them (spec INTEGRATIONS_DESIGN.md §2b).
 *
 * Drives the REAL router over HTTP with the REAL integrationStore, mappingStore
 * and secretStore on the in-memory FakeDb; only the network (API test), the
 * document reader and the job runners are mocked.
 *
 * Rules pinned (each test fails when its rule is removed):
 *  S1 the secret NEVER appears in any response — not the plaintext, not the
 *     ciphertext — on GET /, GET /:id, PUT /:id, connection-check, PUT /secret.
 *  S2 PUT /:id/secret is test-first: a failing candidate is not stored and the
 *     working secret stays; a passing one is stored ({stored, verified}).
 *  S3 the closed whitelist: PUT cannot set approvedFilter, the secret, or a
 *     credential hidden in apiConfig (unknown key / credential-named query param).
 *  S4 approved_filter is written ONLY by approval (row approval while nothing is
 *     turned on; turn-on of a version), cleared by withdrawal; a newer draft of
 *     an ACTIVE integration does not change what the running version filters.
 *  S5 API document upload: capped at doc_max_bytes BEFORE extraction (multipart
 *     and JSON base64 / text), API integrations only.
 *  S6 connection-check answers {ok, sampleRecord, pageRecords, declaredTotal,
 *     columns, reason}; a config edited while the test ran does not inherit it.
 *  S7 the api connection fingerprint covers api_config + secret_set_at: editing
 *     either clears the test and blocks turn-on; filter words do not.
 *  S8 Context rows are approved without a catalogue; a layout/key mismatch is refused.
 *  S9 the AI document reading runs as a tenant-scoped async job.
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import { makeFakeDb } from './def354IntegrationFakeDb';

const A = 'TMC-0001';
const B = 'OTHER-9';
const SECRET = 'sk_live_SUPERSECRET_123456789';
const KEY = 'a'.repeat(64);

const h = vi.hoisted(() => ({
  db: null as any,
  testApiWith: null as any,
  testSource: null as any,
  attach: null as any,
  readDoc: null as any,
}));

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
  getBehaviorValue: async (key: string) => (key === 'integrations.doc_max_bytes' ? 5 * 1024 * 1024 : 500),
}));
vi.mock('../src/services/integrations/sources/apiReader', async (orig) => ({
  ...(await orig<any>()),
  testApiWith: (...a: any[]) => h.testApiWith(...a),
}));
vi.mock('../src/services/integrations/sources', async (orig) => ({
  ...(await orig<any>()),
  testSource: (...a: any[]) => h.testSource(...a),
}));
vi.mock('../src/services/integrations/sources/docReader', () => ({
  attachApiDocument: (...a: any[]) => h.attach(...a),
  readApiDocument: (...a: any[]) => h.readDoc(...a),
}));
vi.mock('../src/services/integrations/mapping/proposalJobs', () => ({ startProposalJob: vi.fn(), getProposalJob: vi.fn() }));
vi.mock('../src/services/integrations/engine/runJobs', () => ({
  startRun: vi.fn(), getRunStatus: vi.fn(), listRuns: vi.fn(), listRunChanges: vi.fn(),
}));

import router, { __resetDocReadJobs } from '../src/routes/admin/integrationAdminRoutes';
import { encryptSecret } from '../src/services/integrations/store/secretStore';
import { isConnectionOk } from '../src/services/integrations/store/integrationStore';

let savedKey: string | undefined;
beforeAll(() => { savedKey = process.env.ENCRYPTION_KEY; process.env.ENCRYPTION_KEY = KEY; });
afterAll(() => { if (savedKey === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = savedKey; });

let nextUserId = 500;
function appAs(cn = A) {
  const id = nextUserId++;
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req: any, _res, next) => { req.user = { id, clientNumber: cn, isAdmin: true, isSuperAdmin: false }; next(); });
  app.use('/api/v1/admin/integrations', router);
  return app;
}
const P = '/api/v1/admin/integrations';

const API_CONFIG = {
  baseUrl: 'https://api.example.com/v1', method: 'GET', path: '/customers', query: { status: 'all' },
  authScheme: 'BEARER', recordsPath: 'data', idField: 'id', pagination: { kind: 'none' },
};
const OK_TEST = {
  ok: true, rows: 25, columns: ['id', 'name'], sampleRow: { id: 'C-1', name: 'Acme' }, pageRecords: 25, declaredTotal: 980,
};

beforeEach(() => {
  h.db = makeFakeDb();
  __resetDocReadJobs();
  h.testApiWith = vi.fn(async () => OK_TEST);
  h.testSource = vi.fn(async () => OK_TEST);
  h.attach = vi.fn(async (_cn: string, _id: string, input: any) => ({ name: input.filename ?? input.name ?? 'Pasted text', chars: 10, redactions: 0 }));
  h.readDoc = vi.fn(async () => ({ draft: {}, gaps: [], summary: 'Read.' }));
});

async function createApi(app = appAs(), extra: Record<string, unknown> = {}) {
  const r = await request(app).post(`${P}/`).send({ name: `CRM ${Math.random()}`, sourceKind: 'api', apiConfig: API_CONFIG, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.integration.id as string;
}
const row = (id: string) => h.db.tables.integrationSync.find((r: any) => r.id === id);
function plantSecret(id: string, plain = SECRET) {
  Object.assign(row(id), { secretEnc: encryptSecret(plain), secretSetAt: new Date(Date.now() - 60_000) });
}

describe('S1 — the secret never appears in any response', () => {
  it('GET /, GET /:id, PUT /:id, connection-check and PUT /secret carry neither plaintext nor ciphertext', async () => {
    const app = appAs();
    const id = await createApi(app);
    plantSecret(id);
    const enc = row(id).secretEnc as string;
    const bodies: string[] = [];
    bodies.push(JSON.stringify((await request(app).get(`${P}/`)).body));
    bodies.push(JSON.stringify((await request(app).get(`${P}/${id}`)).body));
    bodies.push(JSON.stringify((await request(app).put(`${P}/${id}`).send({ connectInstructions: 'map it' })).body));
    bodies.push(JSON.stringify((await request(app).get(`${P}/${id}/connection-check`)).body));
    bodies.push(JSON.stringify((await request(app).put(`${P}/${id}/secret`).send({ secret: 'sk_live_NEWSECRET_987654321' })).body));
    for (const b of bodies) {
      expect(b).not.toContain(SECRET);
      expect(b).not.toContain('NEWSECRET');
      expect(b).not.toContain(enc.split(':')[3]);
      expect(b).not.toContain('secretEnc');
      expect(b).not.toContain('apiDocText');
    }
    const dto = (await request(app).get(`${P}/${id}`)).body.integration;
    expect(dto.hasSecret).toBe(true);
  });
});

describe('S2 — PUT /:id/secret is test-first', () => {
  it('a failing candidate is not stored; the working secret stays', async () => {
    const app = appAs();
    const id = await createApi(app);
    plantSecret(id);
    const before = row(id).secretEnc;
    h.testApiWith = vi.fn(async () => ({ ok: false, rows: 0, columns: [], sampleRow: null, reason: 'The API refused the credential (401).' }));
    const r = await request(app).put(`${P}/${id}/secret`).send({ secret: 'wrong-key-123' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ stored: false, verified: false, reason: 'The API refused the credential (401).' });
    expect(row(id).secretEnc).toBe(before);
    // The candidate was tested against the stored config with the CANDIDATE secret.
    expect(h.testApiWith.mock.calls[0][0]).toBe(A);
    expect(h.testApiWith.mock.calls[0][1]).toMatchObject({ baseUrl: 'https://api.example.com/v1', path: '/customers' });
    expect(h.testApiWith.mock.calls[0][2]).toBe('wrong-key-123');
  });

  it('a passing candidate is stored encrypted and reported verified', async () => {
    const app = appAs();
    const id = await createApi(app);
    const r = await request(app).put(`${P}/${id}/secret`).send({ secret: SECRET });
    expect(r.body).toMatchObject({ stored: true, verified: true, reason: null });
    expect(row(id).secretEnc).toMatch(/^v1:/);
    expect(row(id).secretEnc).not.toContain(SECRET);
    expect(r.body.integration.hasSecret).toBe(true);
  });

  it('refuses extra keys, a gsheet integration, and an API set to sign in with nothing', async () => {
    const app = appAs();
    const id = await createApi(app);
    expect((await request(app).put(`${P}/${id}/secret`).send({ secret: 'x', apiConfig: {} })).status).toBe(400);
    const sheet = await request(app).post(`${P}/`).send({ name: 'Sheet', link: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0' });
    expect((await request(app).put(`${P}/${sheet.body.integration.id}/secret`).send({ secret: 'x' })).status).toBe(400);
    const open = await createApi(app, { apiConfig: { ...API_CONFIG, authScheme: 'NONE' } });
    expect((await request(app).put(`${P}/${open}/secret`).send({ secret: 'x' })).status).toBe(400);
    expect(h.testApiWith).not.toHaveBeenCalled();
  });

  it('another tenant cannot set the secret (404, nothing stored)', async () => {
    const id = await createApi(appAs(A));
    const r = await request(appAs(B)).put(`${P}/${id}/secret`).send({ secret: SECRET });
    expect(r.status).toBe(404);
    expect(row(id).secretEnc).toBeUndefined();
  });
});

describe('S3 — PUT cannot set approved_filter, the secret, or a credential in apiConfig', () => {
  it.each([
    [{ approvedFilter: { match: 'all', conditions: [{ field: 'status', op: 'equals', value: 'x' }] } }, 'approvedFilter'],
    [{ secret: SECRET }, 'secret'],
    [{ secretEnc: 'v1:a:b:c' }, 'secretEnc'],
    [{ apiDocText: 'x' }, 'apiDocText'],
    [{ apiDocReading: {} }, 'apiDocReading'],
  ])('%j is a 400 and nothing is written', async (body, field) => {
    const app = appAs();
    const id = await createApi(app);
    const snapshot = JSON.stringify(row(id));
    const r = await request(app).put(`${P}/${id}`).send(body);
    expect(r.status).toBe(400);
    expect(r.body.field).toBe(field);
    expect(JSON.stringify(row(id))).toBe(snapshot);
  });

  it('a credential inside apiConfig is refused (unknown key, credential query param, user:pass URL)', async () => {
    const app = appAs();
    const id = await createApi(app);
    for (const apiConfig of [
      { ...API_CONFIG, token: SECRET },
      { ...API_CONFIG, query: { api_key: SECRET } },
      { ...API_CONFIG, baseUrl: `https://user:${SECRET}@api.example.com` },
      { ...API_CONFIG, baseUrl: 'http://api.example.com' },
      { ...API_CONFIG, path: 'https://evil.example.net/x' },
    ]) {
      const r = await request(app).put(`${P}/${id}`).send({ apiConfig });
      expect(r.status, JSON.stringify(apiConfig)).toBe(400);
      expect(JSON.stringify(row(id))).not.toContain(SECRET);
    }
  });
});

describe('S4 — approved_filter is written only by approval', () => {
  const FILTER = { match: 'all', conditions: [{ field: 'status', op: 'equals', value: 'active' }] };

  function draftWithFilter(id: string, versionNo = 1) {
    const v = h.db.insert('integrationMappingVersion', { clientNumber: A, integrationId: id, version: versionNo, status: 'DRAFT' });
    const f = h.db.insert('integrationSuggestion', {
      clientNumber: A, integrationId: id, mappingVersionId: v.id, targetKind: 'filter', targetKey: 'filter',
      sourceField: 'status', transform: FILTER, status: 'PENDING',
    });
    return { versionId: v.id as string, filterId: f.id as string };
  }

  it('approving the filter row writes approved_filter in the same transaction; withdrawing clears it', async () => {
    const app = appAs();
    const id = await createApi(app);
    const { versionId, filterId } = draftWithFilter(id);
    expect(row(id).approvedFilter ?? null).toBeNull();
    const r = await request(app).post(`${P}/${id}/suggestions/approve`).send({ versionId, ids: [filterId] });
    expect(r.body.updated).toBe(1);
    expect(row(id).approvedFilter).toEqual(FILTER);
    await request(app).post(`${P}/${id}/suggestions/reject`).send({ versionId, ids: [filterId] });
    expect(row(id).approvedFilter?.match).toBeUndefined(); // SQL NULL (Prisma.DbNull)
  });

  it('a second filter in the same version is refused', async () => {
    const app = appAs();
    const id = await createApi(app);
    const { versionId, filterId } = draftWithFilter(id);
    const g = h.db.insert('integrationSuggestion', {
      clientNumber: A, integrationId: id, mappingVersionId: versionId, targetKind: 'filter', targetKey: 'filter',
      sourceField: 'name', transform: { match: 'all', conditions: [{ field: 'name', op: 'is_not_blank' }] }, status: 'PENDING',
    });
    const r = await request(app).post(`${P}/${id}/suggestions/approve`).send({ versionId, ids: [filterId, g.id] });
    expect(r.body.updated).toBe(1);
    expect(r.body.refused[0].reason).toContain('Another filter');
  });

  it('an invalid stored filter is refused at approval and approved_filter stays empty', async () => {
    const app = appAs();
    const id = await createApi(app);
    const { versionId, filterId } = draftWithFilter(id);
    h.db.tables.integrationSuggestion.find((s: any) => s.id === filterId).transform = { match: 'all', conditions: [{ field: 'status', op: 'drop_table' }] };
    const r = await request(app).post(`${P}/${id}/suggestions/approve`).send({ versionId, ids: [filterId] });
    expect(r.body.updated).toBe(0);
    expect(row(id).approvedFilter ?? null).toBeNull();
  });

  it('on an ACTIVE integration a newer draft\'s filter waits for that draft\'s turn-on', async () => {
    const app = appAs();
    const id = await createApi(app);
    const old = h.db.insert('integrationMappingVersion', { clientNumber: A, integrationId: id, version: 1, status: 'APPROVED' });
    Object.assign(row(id), { status: 'ACTIVE', approvedVersionId: old.id, activatedAt: new Date(), approvedFilter: null });
    const { versionId, filterId } = draftWithFilter(id, 2);
    const r = await request(app).post(`${P}/${id}/suggestions/approve`).send({ versionId, ids: [filterId] });
    expect(r.body.updated).toBe(1);
    expect(row(id).approvedFilter).toBeNull();
  });

  it('turn-on writes the version\'s approved filter', async () => {
    const app = appAs();
    const id = await createApi(app, { frequency: 'daily', runTime: '06:00' });
    plantSecret(id);
    const { versionId, filterId } = draftWithFilter(id);
    h.db.insert('integrationSuggestion', {
      clientNumber: A, integrationId: id, mappingVersionId: versionId, targetKind: 'context', targetKey: 'context:table',
      sourceField: 'name', transform: { mode: 'table', columns: ['name'] }, status: 'PENDING',
    });
    await request(app).post(`${P}/${id}/suggestions/approve`).send({ versionId, ids: 'all' });
    row(id).approvedFilter = null; // pretend another path cleared it: turn-on must restore it
    await request(app).get(`${P}/${id}/connection-check`);
    h.db.insert('integrationRun', {
      clientNumber: A, integrationId: id, mappingVersionId: versionId, dryRun: true, status: 'SUCCESS',
      connectionFingerprint: row(id).connectionFingerprint, startedAt: new Date(Date.now() + 1000),
    });
    const r = await request(app).post(`${P}/${id}/activate`).send({ versionId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(row(id).approvedFilter).toEqual(FILTER);
  });

  it('a version with ONLY a filter approved cannot be turned on (a filter writes nothing)', async () => {
    const app = appAs();
    const id = await createApi(app);
    const { versionId, filterId } = draftWithFilter(id);
    await request(app).post(`${P}/${id}/suggestions/approve`).send({ versionId, ids: [filterId] });
    const r = await request(app).post(`${P}/${id}/activate`).send({ versionId });
    expect(r.status).toBe(409);
    expect(r.body.reasons.join(' ')).toContain('Approve at least one field');
  });
});

describe('S5 — API document upload', () => {
  it('a multipart file over 5 MB is refused before extraction', async () => {
    const app = appAs();
    const id = await createApi(app);
    const r = await request(app).post(`${P}/${id}/api-document`).attach('file', Buffer.alloc(5 * 1024 * 1024 + 1, 0x61), 'api.txt');
    expect(r.status).toBe(413);
    expect(h.attach).not.toHaveBeenCalled();
  });

  it('a JSON base64 document over 5 MB is refused before it is decoded', async () => {
    const app = appAs();
    const id = await createApi(app);
    const base64 = Buffer.alloc(5 * 1024 * 1024 + 100, 0x61).toString('base64');
    const r = await request(app).post(`${P}/${id}/api-document`).send({ filename: 'api.txt', base64 });
    expect(r.status).toBe(413);
    expect(h.attach).not.toHaveBeenCalled();
  });

  it('a file within the cap is attached for THIS tenant; the text is not echoed back', async () => {
    const app = appAs();
    const id = await createApi(app);
    const r = await request(app).post(`${P}/${id}/api-document`).attach('file', Buffer.from('GET /customers returns data[]'), 'api.md');
    expect(r.status).toBe(201);
    expect(h.attach).toHaveBeenCalledTimes(1);
    expect(h.attach.mock.calls[0][0]).toBe(A);
    expect(h.attach.mock.calls[0][2]).toMatchObject({ filename: 'api.md' });
    expect(JSON.stringify(r.body)).not.toContain('returns data[]');
  });

  it('pasted text and base64 JSON are accepted; unknown keys and a gsheet integration are refused', async () => {
    const app = appAs();
    const id = await createApi(app);
    expect((await request(app).post(`${P}/${id}/api-document`).send({ text: 'GET /x', name: 'notes' })).status).toBe(201);
    expect((await request(app).post(`${P}/${id}/api-document`).send({ filename: 'a.json', base64: Buffer.from('{}').toString('base64') })).status).toBe(201);
    expect((await request(app).post(`${P}/${id}/api-document`).send({ text: 'x', apiDocText: 'y' })).status).toBe(400);
    const sheet = await request(app).post(`${P}/`).send({ name: 'Sheet', link: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0' });
    expect((await request(app).post(`${P}/${sheet.body.integration.id}/api-document`).send({ text: 'x' })).status).toBe(400);
    expect(h.attach).toHaveBeenCalledTimes(2);
  });
});

describe('S6 — connection-check: one record, page count, declared total', () => {
  it('answers the Connect view fields and records the pass', async () => {
    const app = appAs();
    const id = await createApi(app);
    const r = await request(app).get(`${P}/${id}/connection-check`);
    expect(r.body).toMatchObject({
      ok: true, sampleRecord: { id: 'C-1', name: 'Acme' }, pageRecords: 25, declaredTotal: 980, columns: ['id', 'name'], reason: null,
    });
    expect(r.body.integration.connectionOk).toBe(true);
  });

  it('a config edited while the test ran does not inherit the pass', async () => {
    const app = appAs();
    const id = await createApi(app);
    h.testSource = vi.fn(async () => {
      row(id).apiConfig = { ...row(id).apiConfig, path: '/other' };
      return OK_TEST;
    });
    const r = await request(app).get(`${P}/${id}/connection-check`);
    expect(r.status).toBe(400);
    expect(row(id).connectionTestedAt).toBeNull();
  });

  it('a credential stored while the test ran does not inherit the pass', async () => {
    const app = appAs();
    const id = await createApi(app);
    h.testSource = vi.fn(async () => {
      Object.assign(row(id), { secretEnc: encryptSecret('other'), secretSetAt: new Date(Date.now() + 5) });
      await new Promise((r) => setTimeout(r, 10));
      return OK_TEST;
    });
    const r = await request(app).get(`${P}/${id}/connection-check`);
    expect(r.status).toBe(400);
    expect(row(id).connectionTestedAt).toBeNull();
  });
});

describe('S7 — the api fingerprint covers api_config + secret_set_at', () => {
  it('editing apiConfig clears the test; filter words and connect instructions do not', async () => {
    const app = appAs();
    const id = await createApi(app);
    await request(app).get(`${P}/${id}/connection-check`);
    expect(row(id).connectionTestedAt).toBeInstanceOf(Date);
    await request(app).put(`${P}/${id}`).send({ filterInstructions: 'only active', connectInstructions: 'pages per customer' });
    expect(row(id).connectionTestedAt).toBeInstanceOf(Date);
    expect(row(id).filterInstructions).toBe('only active');
    // Same config, re-sent: normalised equal ⇒ still tested.
    await request(app).put(`${P}/${id}`).send({ apiConfig: { ...API_CONFIG, baseUrl: 'https://api.example.com/v1/' } });
    expect(row(id).connectionTestedAt).toBeInstanceOf(Date);
    await request(app).put(`${P}/${id}`).send({ apiConfig: { ...API_CONFIG, path: '/accounts' } });
    expect(row(id).connectionTestedAt).toBeNull();
  });

  it('a new credential changes the fingerprint, so the old test no longer counts', async () => {
    const app = appAs();
    const id = await createApi(app);
    plantSecret(id);
    await request(app).get(`${P}/${id}/connection-check`);
    expect(isConnectionOk(row(id))).toBe(true);
    // Same columns, only secret_set_at moves (as setSecret does, minus its own clearing).
    row(id).secretSetAt = new Date();
    expect(isConnectionOk(row(id))).toBe(false);
  });

  it('an ACTIVE api integration refuses a connection edit (pause first)', async () => {
    const app = appAs();
    const id = await createApi(app);
    Object.assign(row(id), { status: 'ACTIVE' });
    const r = await request(app).put(`${P}/${id}`).send({ apiConfig: { ...API_CONFIG, path: '/accounts' } });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('Pause this integration before changing its API connection');
  });

  it('a sheet link on an api integration is refused', async () => {
    const app = appAs();
    const id = await createApi(app);
    const r = await request(app).put(`${P}/${id}`).send({ link: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit' });
    expect(r.status).toBe(400);
    expect(r.body.field).toBe('link');
  });
});

describe('S8 — Context rows need no catalogue', () => {
  it('approves a valid Context row; refuses a key/layout mismatch', async () => {
    const app = appAs();
    const id = await createApi(app);
    const v = h.db.insert('integrationMappingVersion', { clientNumber: A, integrationId: id, version: 1, status: 'DRAFT' });
    const good = h.db.insert('integrationSuggestion', {
      clientNumber: A, integrationId: id, mappingVersionId: v.id, targetKind: 'context', targetKey: 'context:per_record',
      sourceField: 'name', transform: { mode: 'per_record', titleField: 'name', bodyFields: ['status'] }, status: 'PENDING', followed: 'REMARK',
    });
    const bad = h.db.insert('integrationSuggestion', {
      clientNumber: A, integrationId: id, mappingVersionId: v.id, targetKind: 'context', targetKey: 'context:table',
      sourceField: 'name', transform: { mode: 'per_record', titleField: 'name', bodyFields: ['status'] }, status: 'PENDING',
    });
    const r = await request(app).post(`${P}/${id}/suggestions/approve`).send({ versionId: v.id, ids: [good.id, bad.id] });
    expect(r.body.updated).toBe(1);
    expect(r.body.refused).toEqual([{ id: bad.id, reason: expect.stringContaining('does not match') }]);
    expect(h.db.tables.kpiDefinition).toHaveLength(0);
    const list = await request(app).get(`${P}/${id}/suggestions`);
    expect(list.body.suggestions.find((s: any) => s.id === good.id)).toMatchObject({ status: 'APPROVED', followed: 'REMARK' });
  });
});

describe('S9 — the AI document reading job', () => {
  it('202 then done with the reading; another tenant sees 404; a second click joins the job', async () => {
    let release!: () => void;
    h.readDoc = vi.fn(() => new Promise((res) => { release = () => res({ draft: { baseUrl: 'https://api.example.com' }, gaps: ['paging'], summary: 'S' }); }));
    const app = appAs();
    const id = await createApi(app);
    const s1 = await request(app).post(`${P}/${id}/api-document/read`);
    const s2 = await request(app).post(`${P}/${id}/api-document/read`);
    expect(s1.status).toBe(202);
    expect(s2.body.jobId).toBe(s1.body.jobId);
    expect(h.readDoc).toHaveBeenCalledTimes(1);
    expect(h.readDoc.mock.calls[0][0]).toBe(A);
    release();
    await new Promise((r) => setTimeout(r, 5));
    const st = await request(app).get(`${P}/${id}/api-document/read/status?jobId=${s1.body.jobId}`);
    expect(st.body.job).toMatchObject({ state: 'done', reading: { gaps: ['paging'] } });
    expect(st.body.job.cn).toBeUndefined();
    const other = await request(appAs(B)).get(`${P}/${id}/api-document/read/status?jobId=${s1.body.jobId}`);
    expect(other.status).toBe(404);
  });

  it('an unexpected failure is reported in plain words, never its internals', async () => {
    h.readDoc = vi.fn(async () => { throw new Error('ECONNRESET at 10.0.0.5:5432 password=hunter2'); });
    const app = appAs();
    const id = await createApi(app);
    const s = await request(app).post(`${P}/${id}/api-document/read`);
    await new Promise((r) => setTimeout(r, 5));
    const st = await request(app).get(`${P}/${id}/api-document/read/status?jobId=${s.body.jobId}`);
    expect(st.body.job.state).toBe('failed');
    expect(st.body.job.error).not.toContain('hunter2');
  });
});
