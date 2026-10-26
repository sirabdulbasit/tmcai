/**
 * DEF-354 — Admin → Integrations API (spec INTEGRATIONS_DESIGN.md §2.6).
 *
 * Rules pinned here, each by a test that goes red when the route weakens it:
 *   R1 OWN LIMITER — the wizard polls proposal/run status; 40 polls inside one
 *      minute all answer 200 (the generic adminLimiter is 30/min and would 429
 *      the 31st). The ceiling is behaviorConfig integrations.route_limit_per_min.
 *   R2 TENANT AUTHORITY — a non-SuperAdmin's tenant is req.user.clientNumber; a
 *      clientNumber in body or query is ignored (DEF-179). A SuperAdmin may name
 *      one explicitly.
 *   R3 CLOSED WHITELIST — POST/PUT never pass status / approvedVersionId /
 *      activatedAt / connectionFingerprint to the store (vm §9 "permissions are
 *      never accepted from the client"). Unknown keys are a 400 and the store
 *      is not called at all, so nothing is half-written.
 *   R4 ERROR MAPPING — RunBusyError → 409, IntegrationNotFoundError → 404,
 *      IntegrationInputError → 400, ActivationRefusedError → 409 with reasons;
 *      an unexpected error → 500 with a generic message (no internals leaked).
 *   R5 ASYNC JOBS — propose/start and run/start answer 202 with a jobId; a run
 *      defaults to a DRY run unless dryRun:false is sent.
 *
 * Drives the REAL router over HTTP (supertest) with auth and every
 * integrations service mocked; the mocks record each call's arguments.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  RunBusyError,
  IntegrationNotFoundError,
  IntegrationInputError,
  ActivationRefusedError,
} from '../src/services/integrations/types';

const A = 'TMC-0001';
const B = 'OTHER-9';

vi.mock('../src/db/prisma', () => {
  const empty: any = new Proxy({}, { get: () => async () => null });
  const p: any = new Proxy({}, { get: () => empty });
  return { __esModule: true, default: p, prisma: p };
});

// requireAuth/requireAdmin as pass-throughs over the user the test app set;
// requireAdmin keeps its real refusal so the admin gate is still exercised.
vi.mock('../src/middleware/auth', () => ({
  __esModule: true,
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireAdmin: (req: any, res: any, next: any) => {
    if (!req.user?.isAdmin) { res.status(403).json({ error: 'Admin access required' }); return; }
    next();
  },
}));

const calls: Record<string, any[][]> = {};
function rec(name: string, impl: (...a: any[]) => any) {
  return vi.fn((...a: any[]) => { (calls[name] ??= []).push(a); return impl(...a); });
}
const integ = (cn: string, id = 'i1') => ({ id, clientNumber: cn, name: 'Sales', sourceConfig: { sheetId: 's', gid: '0', link: 'x' } });

const svc = vi.hoisted(() => ({} as Record<string, any>));

vi.mock('../src/services/integrations/sources/gsheetReader', () => ({
  __esModule: true,
  testGsheet: (...a: any[]) => svc.testGsheet(...a),
}));
vi.mock('../src/services/integrations/mapping/proposalJobs', () => ({
  __esModule: true,
  startProposalJob: (...a: any[]) => svc.startProposalJob(...a),
  getProposalJob: (...a: any[]) => svc.getProposalJob(...a),
}));
vi.mock('../src/services/integrations/store/integrationStore', () => ({
  __esModule: true,
  listIntegrations: (...a: any[]) => svc.listIntegrations(...a),
  getIntegration: (...a: any[]) => svc.getIntegration(...a),
  createIntegration: (...a: any[]) => svc.createIntegration(...a),
  updateIntegration: (...a: any[]) => svc.updateIntegration(...a),
  deleteIntegration: (...a: any[]) => svc.deleteIntegration(...a),
  recordConnectionTest: (...a: any[]) => svc.recordConnectionTest(...a),
}));
vi.mock('../src/services/integrations/store/mappingStore', () => ({
  __esModule: true,
  listSuggestions: (...a: any[]) => svc.listSuggestions(...a),
  approveSuggestions: (...a: any[]) => svc.approveSuggestions(...a),
  rejectSuggestions: (...a: any[]) => svc.rejectSuggestions(...a),
  listKpiDefinitions: (...a: any[]) => svc.listKpiDefinitions(...a),
  createKpiDefinition: (...a: any[]) => svc.createKpiDefinition(...a),
  activate: (...a: any[]) => svc.activate(...a),
  pause: (...a: any[]) => svc.pause(...a),
}));
vi.mock('../src/services/integrations/engine/runJobs', () => ({
  __esModule: true,
  startRun: (...a: any[]) => svc.startRun(...a),
  getRunStatus: (...a: any[]) => svc.getRunStatus(...a),
  listRuns: (...a: any[]) => svc.listRuns(...a),
  listRunChanges: (...a: any[]) => svc.listRunChanges(...a),
}));

import router, { ROUTE_LIMIT_PER_MIN } from '../src/routes/admin/integrationAdminRoutes';

let nextUserId = 100;
/** Each app gets its own user id so the shared limiter store never carries
 *  budget from one test into another. */
function appAs(user: Partial<{ id: number; clientNumber: string; isAdmin: boolean; isSuperAdmin: boolean }> = {}) {
  const id = user.id ?? nextUserId++;
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id, clientNumber: A, userType: 'AD', isAdmin: true, isSuperAdmin: false, ...user };
    next();
  });
  app.use('/api/v1/admin/integrations', router);
  return app;
}
const P = '/api/v1/admin/integrations';

beforeEach(() => {
  for (const k of Object.keys(calls)) delete calls[k];
  svc.testGsheet = rec('testGsheet', async () => ({ ok: true, rows: 3, columns: ['a'], sampleRow: { a: '1' } }));
  svc.startProposalJob = rec('startProposalJob', async () => ({ jobId: 'job-1' }));
  svc.getProposalJob = rec('getProposalJob', (_cn: string, id: string, jobId: string) => ({
    jobId, integrationId: id, state: 'running', startedAt: new Date().toISOString(), finishedAt: null, result: null, error: null,
  }));
  svc.listIntegrations = rec('listIntegrations', async (cn: string) => [integ(cn)]);
  svc.getIntegration = rec('getIntegration', async (cn: string, id: string) => integ(cn, id));
  svc.createIntegration = rec('createIntegration', async (cn: string) => integ(cn));
  svc.updateIntegration = rec('updateIntegration', async (cn: string, id: string) => integ(cn, id));
  svc.deleteIntegration = rec('deleteIntegration', async () => undefined);
  svc.recordConnectionTest = rec('recordConnectionTest', async (cn: string, id: string) => integ(cn, id));
  svc.listSuggestions = rec('listSuggestions', async () => ({ version: null, suggestions: [] }));
  svc.approveSuggestions = rec('approveSuggestions', async () => ({ updated: 1, createdKpis: [], refused: [] }));
  svc.rejectSuggestions = rec('rejectSuggestions', async () => ({ updated: 1, createdKpis: [], refused: [] }));
  svc.listKpiDefinitions = rec('listKpiDefinitions', async () => []);
  svc.createKpiDefinition = rec('createKpiDefinition', async () => ({ id: 'k1', kpiKey: 'revenue' }));
  svc.activate = rec('activate', async (cn: string, id: string) => integ(cn, id));
  svc.pause = rec('pause', async (cn: string, id: string) => integ(cn, id));
  svc.startRun = rec('startRun', async () => ({ runId: 'run-1' }));
  svc.getRunStatus = rec('getRunStatus', async (_cn: string, id: string, runId: string) => ({ runId, integrationId: id, status: 'RUNNING' }));
  svc.listRuns = rec('listRuns', async () => []);
  svc.listRunChanges = rec('listRunChanges', async () => []);
});

describe('R1 — own limiter: the wizard can poll', () => {
  it('the ceiling is the behaviorConfig default (240), not the generic admin 30/min', () => {
    expect(ROUTE_LIMIT_PER_MIN).toBe(240);
  });

  it('40 run-status and 40 propose-status polls within a minute all answer 200', async () => {
    const app = appAs();
    for (let i = 0; i < 40; i++) {
      const r = await request(app).get(`${P}/i1/run/status?jobId=run-1`);
      expect(r.status, `run poll ${i + 1}`).toBe(200);
    }
    const app2 = appAs();
    for (let i = 0; i < 40; i++) {
      const r = await request(app2).get(`${P}/i1/propose/status?jobId=job-1`);
      expect(r.status, `propose poll ${i + 1}`).toBe(200);
    }
  });

  it('a non-admin is refused by the admin gate', async () => {
    const r = await request(appAs({ isAdmin: false })).get(`${P}/`);
    expect(r.status).toBe(403);
    expect(calls.listIntegrations).toBeUndefined();
  });
});

describe('R2 — tenant authority comes from the requester', () => {
  it('a plain admin naming another tenant in the body still acts on their own tenant', async () => {
    const r = await request(appAs()).post(`${P}/`).send({ name: 'Sales', clientNumber: B });
    expect(r.status).toBe(201);
    expect(calls.createIntegration[0][0]).toBe(A);
  });

  it('a plain admin naming another tenant in the query still acts on their own tenant', async () => {
    await request(appAs()).get(`${P}/?clientNumber=${B}`);
    await request(appAs()).get(`${P}/i1/run/status?jobId=run-1&clientNumber=${B}`);
    expect(calls.listIntegrations[0][0]).toBe(A);
    expect(calls.getRunStatus[0][0]).toBe(A);
  });

  it('every service call carries the tenant as its FIRST argument', async () => {
    const app = appAs();
    await request(app).get(`${P}/i1/connection-check`);
    await request(app).post(`${P}/i1/run/start`).send({});
    await request(app).post(`${P}/i1/activate`).send({ versionId: 'v1' });
    for (const name of ['getIntegration', 'testGsheet', 'recordConnectionTest', 'startRun', 'activate']) {
      expect(calls[name]?.[0]?.[0], name).toBe(A);
    }
  });

  it('a SuperAdmin may name another tenant explicitly', async () => {
    await request(appAs({ isSuperAdmin: true })).get(`${P}/?clientNumber=${B}`);
    expect(calls.listIntegrations[0][0]).toBe(B);
  });

  it('a SuperAdmin with a malformed clientNumber is refused, not guessed', async () => {
    const r = await request(appAs({ isSuperAdmin: true })).get(`${P}/?clientNumber=${encodeURIComponent("x' OR 1=1")}`);
    expect(r.status).toBe(400);
    expect(calls.listIntegrations).toBeUndefined();
  });
});

describe('R3 — closed whitelist on POST/PUT', () => {
  for (const key of ['status', 'approvedVersionId', 'activatedAt', 'connectionFingerprint', 'createdBy', 'sheetId']) {
    it(`PUT with "${key}" is a 400 and the store is never called`, async () => {
      const r = await request(appAs()).put(`${P}/i1`).send({ name: 'ok', [key]: 'ACTIVE' });
      expect(r.status).toBe(400);
      expect(r.body.error).toContain(key);
      expect(calls.updateIntegration).toBeUndefined();
    });
  }

  it('POST with status is a 400 too — a new integration is never born ACTIVE', async () => {
    const r = await request(appAs()).post(`${P}/`).send({ name: 'x', status: 'ACTIVE' });
    expect(r.status).toBe(400);
    expect(calls.createIntegration).toBeUndefined();
  });

  it('a whitelisted PUT reaches the store with exactly the sent keys', async () => {
    const r = await request(appAs()).put(`${P}/i1`).send({ name: 'New', link: 'https://docs.google.com/x', clientNumber: B });
    expect(r.status).toBe(200);
    const [cn, id, patch] = calls.updateIntegration[0];
    expect(cn).toBe(A);
    expect(id).toBe('i1');
    expect(patch).toEqual({ name: 'New', link: 'https://docs.google.com/x' });
  });

  it('POST /kpi-definitions cannot set the owner or the active flag', async () => {
    const r = await request(appAs()).post(`${P}/kpi-definitions`).send({ kpiKey: 'rev', label: 'Rev', sourceIntegrationId: 'i9' });
    expect(r.status).toBe(400);
    expect(calls.createKpiDefinition).toBeUndefined();
  });
});

describe('R4 — error mapping', () => {
  it('RunBusyError on run/start → 409 with its message', async () => {
    svc.startRun = vi.fn(async () => { throw new RunBusyError('i1'); });
    const r = await request(appAs()).post(`${P}/i1/run/start`).send({ dryRun: true });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already has a run in progress/);
  });

  it('IntegrationNotFoundError → 404; a missing integration on GET /:id → 404', async () => {
    svc.updateIntegration = vi.fn(async () => { throw new IntegrationNotFoundError('zz'); });
    expect((await request(appAs()).put(`${P}/zz`).send({ name: 'x' })).status).toBe(404);
    svc.getIntegration = vi.fn(async () => null);
    expect((await request(appAs()).get(`${P}/zz`)).status).toBe(404);
  });

  it('IntegrationInputError → 400 with the field', async () => {
    svc.createIntegration = vi.fn(async () => { throw new IntegrationInputError('Not a Google Sheet link', 'link'); });
    const r = await request(appAs()).post(`${P}/`).send({ link: 'https://evil.example' });
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'Not a Google Sheet link', field: 'link' });
  });

  it('ActivationRefusedError → 409 with the reasons verbatim', async () => {
    svc.activate = vi.fn(async () => { throw new ActivationRefusedError(['no successful dry run']); });
    const r = await request(appAs()).post(`${P}/i1/activate`).send({ versionId: 'v1' });
    expect(r.status).toBe(409);
    expect(r.body.reasons).toEqual(['no successful dry run']);
  });

  it('an unexpected error → 500 with a generic message, no internals', async () => {
    svc.listIntegrations = vi.fn(async () => { throw new Error('relation "integration_syncs" does not exist'); });
    const r = await request(appAs()).get(`${P}/`);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('integration_syncs');
  });

  it('connection-check: an unreadable credential is recorded as a FAILED test, not a 500', async () => {
    svc.testGsheet = vi.fn(async () => { const e: any = new Error('No Google account designated'); e.code = 'CREDENTIAL_UNREADABLE'; throw e; });
    const r = await request(appAs()).get(`${P}/i1/connection-check`);
    expect(r.status).toBe(200);
    expect(r.body.result).toMatchObject({ ok: false, reason: 'No Google account designated' });
    expect(calls.recordConnectionTest[0][2].ok).toBe(false);
  });
});

describe('R5 — async jobs', () => {
  it('propose/start → 202 {jobId}', async () => {
    const r = await request(appAs()).post(`${P}/i1/propose/start`).send({ prompt: '  revenue by month ' });
    expect(r.status).toBe(202);
    expect(r.body.jobId).toBe('job-1');
    expect(calls.startProposalJob[0][2]).toMatchObject({ prompt: 'revenue by month' });
  });

  it('run/start → 202 {jobId: runId}; manual; dry by default', async () => {
    const r = await request(appAs({ id: 7 })).post(`${P}/i1/run/start`).send({});
    expect(r.status).toBe(202);
    expect(r.body.jobId).toBe('run-1');
    expect(calls.startRun[0][2]).toMatchObject({ dryRun: true, trigger: 'manual', triggeredBy: 'user:7' });
  });

  it('a live run must be asked for explicitly', async () => {
    await request(appAs()).post(`${P}/i1/run/start`).send({ dryRun: false });
    expect(calls.startRun[0][2].dryRun).toBe(false);
  });

  it('an unknown proposal job → 404', async () => {
    svc.getProposalJob = vi.fn(() => null);
    expect((await request(appAs()).get(`${P}/i1/propose/status?jobId=nope`)).status).toBe(404);
  });

  it('/kpi-definitions is not captured as an integration id', async () => {
    const r = await request(appAs()).get(`${P}/kpi-definitions`);
    expect(r.status).toBe(200);
    expect(calls.listKpiDefinitions).toHaveLength(1);
    expect(calls.getIntegration).toBeUndefined();
  });
});
