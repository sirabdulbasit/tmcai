/**
 * DEF-362 — Integrations Stage 1b, fixes from the four-angle review (contract
 * and e2e lenses): the client calls the routes the server actually has.
 *
 * The 208 def362 tests passed while every Stage 1b client call 404'd, because
 * nothing checked the client's (method, path) pairs against the router. Here
 * client/src/services/integrationsApi.js runs for real against a recording
 * axios stand-in, and every call it makes is matched against the route table
 * parsed from integrationAdminRoutes.ts. Pinned:
 *  C1. Every exported call hits a registered (method, path).
 *  C2. The upload is sent as multipart (the shared client's JSON default would
 *      turn the FormData into JSON and the File into {}).
 *  C3. readApiDocument starts the job, polls /read/status until done, then
 *      re-fetches the integration; a failed job throws its error.
 *  C4. setIntegrationSecret uses PUT and reads `verified` (the server sends no
 *      `test`).
 *  C5. Basics saves first before attaching (an unsaved switch to API would be
 *      refused as "reads a Google Sheet"); Review lists each "Not used" field
 *      once.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const net = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; url: string; body?: unknown; config?: any }>,
  reply: null as null | ((method: string, url: string, body?: unknown) => unknown),
}));

vi.mock('../../client/src/services/api.js', () => {
  const call = (method: string) => async (url: string, a?: unknown, b?: unknown) => {
    const body = method === 'get' || method === 'delete' ? undefined : a;
    const config = method === 'get' || method === 'delete' ? a : b;
    net.calls.push({ method, url, body, config });
    return { data: net.reply ? net.reply(method, url, body) : {} };
  };
  return { default: { get: call('get'), post: call('post'), put: call('put'), delete: call('delete') } };
});

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain JS client module.
import * as client from '../../client/src/services/integrationsApi.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain JS client module.
import { reviewNotices, notUsedFromSpec } from '../../client/src/pages/admin/integrations/integrationLogic.js';

const ROUTES_SRC = fs.readFileSync(path.join(__dirname, '../src/routes/admin/integrationAdminRoutes.ts'), 'utf8');
const CLIENT_DIR = path.join(__dirname, '../../client/src/pages/admin/integrations');

/** [method, regex] for every router.<method>('<path>') in the route file. */
const ROUTES: Array<[string, RegExp]> = [...ROUTES_SRC.matchAll(/router\.(get|post|put|delete)\(\s*'([^']+)'/g)]
  .map(([, m, p]) => [m, new RegExp(`^/v1/admin/integrations${p === '/' ? '' : p.replace(/:[A-Za-z]+/g, '[^/]+')}$`)]);

const routed = (method: string, url: string) => ROUTES.some(([m, re]) => m === method && re.test(url));

beforeEach(() => { net.calls = []; net.reply = null; });

describe('C1 — every client call hits a registered route', () => {
  it('the route table was parsed', () => {
    expect(ROUTES.length).toBeGreaterThan(20);
    expect(routed('post', '/v1/admin/integrations/i1/api-document')).toBe(true);
    expect(routed('post', '/v1/admin/integrations/i1/api-doc')).toBe(false);
  });

  it('API document, AI reading, secret, connection, mapping, runs and turn-on calls all route', async () => {
    net.reply = (m, url) => {
      if (url.endsWith('/read/status') || url.endsWith('/propose/status')) return { job: { state: 'done', reading: { summary: 's' }, result: {} } };
      if (url.endsWith('/run/status')) return { run: { status: 'SUCCESS' } };
      if (url.endsWith('/read') || url.endsWith('/propose/start')) return { jobId: 'j1' };
      if (url.endsWith('/run/start')) return { runId: 'r1' };
      return { integration: { id: 'i1' } };
    };
    const file = new File(['GET /v1/items'], 'api.txt', { type: 'text/plain' });
    await client.uploadApiDocument('i1', file);
    await client.attachApiDocumentText('i1', 'GET /v1/items', 'notes');
    await client.readApiDocument('i1');
    await client.setIntegrationSecret('i1', 'sk_live_x');
    await client.checkConnection('i1');
    await client.listIntegrations();
    await client.getIntegration('i1');
    await client.updateIntegration('i1', { name: 'x' });
    await client.proposeAndWait('i1', 'p');
    await client.listSuggestions('i1');
    await client.approveSuggestions('i1', 'v1', 'all');
    await client.rejectSuggestions('i1', 'v1', ['s1']);
    await client.runAndWait('i1', { dryRun: true, versionId: 'v1' });
    await client.listRuns('i1');
    await client.listRunChanges('i1', 'r1');
    await client.activateIntegration('i1', 'v1');
    await client.pauseIntegration('i1');
    await client.deleteIntegration('i1');
    const unrouted = net.calls.filter((c) => !routed(c.method, c.url)).map((c) => `${c.method.toUpperCase()} ${c.url}`);
    expect(unrouted).toEqual([]);
  });
});

describe('C2 — the upload stays multipart', () => {
  it('overrides the shared JSON Content-Type for the FormData post', async () => {
    await client.uploadApiDocument('i1', new File(['x'], 'api.pdf', { type: 'application/pdf' }));
    const c = net.calls[0];
    expect(c.body).toBeInstanceOf(FormData);
    expect(c.config?.headers?.['Content-Type']).toBe('multipart/form-data');
  });
});

describe('C3 — the AI reading is a job: start, poll, re-fetch', () => {
  it('polls until done and returns the re-fetched integration', async () => {
    let polls = 0;
    net.reply = (m, url) => {
      if (m === 'post') return { jobId: 'j7' };
      if (url.endsWith('/read/status')) { polls += 1; return { job: { state: polls < 2 ? 'running' : 'done', reading: { summary: 'S' } } }; }
      return { integration: { id: 'i1', apiDocReading: { summary: 'S' } } };
    };
    vi.useFakeTimers();
    const p = client.readApiDocument('i1');
    await vi.runAllTimersAsync();
    const res = await p;
    vi.useRealTimers();
    expect(net.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'post /v1/admin/integrations/i1/api-document/read',
      'get /v1/admin/integrations/i1/api-document/read/status',
      'get /v1/admin/integrations/i1/api-document/read/status',
      'get /v1/admin/integrations/i1',
    ]);
    expect(net.calls[1].config).toEqual({ params: { jobId: 'j7' } });
    expect(res.integration.apiDocReading.summary).toBe('S');
    expect(res.reading.summary).toBe('S');
  });

  it('a failed job throws the server\'s words', async () => {
    net.reply = (m) => (m === 'post' ? { jobId: 'j8' } : { job: { state: 'failed', error: 'The document has no endpoints.' } });
    await expect(client.readApiDocument('i1')).rejects.toThrow('The document has no endpoints.');
  });
});

describe('C4 — the secret is a PUT and `verified` is read', () => {
  it('maps verified from the server answer', async () => {
    net.reply = () => ({ stored: true, verified: true, reason: null, integration: { id: 'i1' } });
    const res = await client.setIntegrationSecret('i1', 'sk_live_x');
    expect(net.calls[0].method).toBe('put');
    expect(res).toMatchObject({ stored: true, verified: true });
    const connect = fs.readFileSync(path.join(CLIENT_DIR, 'StepConnect.jsx'), 'utf8');
    expect(connect).not.toMatch(/res\.test/);
    expect(connect).toMatch(/res\.verified/);
  });
});

describe('C5 — Basics and Review wiring', () => {
  it('attach() saves first, like read()', () => {
    const basics = fs.readFileSync(path.join(CLIENT_DIR, 'StepBasics.jsx'), 'utf8');
    const attach = basics.slice(basics.indexOf('async function attach()'), basics.indexOf('async function read()'));
    expect(attach).toMatch(/if \(saveFirst\) await saveFirst\(\);[\s\S]*uploadApiDocument/);
  });

  it('a "Not used" field is listed once: its notice is dropped when spec.notUsed carries it', () => {
    const spec = { notices: ['Not used: "region" — the same everywhere', 'Dropped kpi:x'], notUsed: [{ field: 'region', reason: 'the same everywhere' }] };
    expect(reviewNotices(spec)).toEqual(['Dropped kpi:x']);
    expect(notUsedFromSpec(spec)).toHaveLength(1);
    expect(reviewNotices({ notices: ['Not used: "a" — b'] })).toEqual(['Not used: "a" — b']); // older spec: kept
    const review = fs.readFileSync(path.join(CLIENT_DIR, 'StepReview.jsx'), 'utf8');
    expect(review).toMatch(/const notices = reviewNotices\(spec\)/);
  });
});
