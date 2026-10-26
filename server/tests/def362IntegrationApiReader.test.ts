/**
 * DEF-362 — Integrations Stage 1b, sources/apiReader.ts + sources/index.ts
 * (spec §2b Connect / REST fetch guard; vm fetchRecordsWithMeta).
 *
 * guardedFetch is replaced by a scripted server (the guard itself is pinned in
 * def362IntegrationFetchGuard); buildAuth and assertSameOrigin are the REAL
 * ones, so what this file pins is what the reader hands the guard. Pinned:
 *  1. Each auth scheme: BEARER / BASIC / API_KEY header / API_KEY query ride as
 *     the guard's `auth` attachment — never in a URL or header the reader
 *     builds itself; NONE sends nothing; a scheme with no stored secret is
 *     refused before any request.
 *  2. recordsPath dotted lookup ('' = the body is the array); a miss names
 *     where lists ARE.
 *  3. Paging: page / offset / next_url, each stopping on an empty or short
 *     page; bounded by min(pagination.maxPages, api_max_pages) ⇒ truncated;
 *     a cross-origin next page FAILS the read; a repeated page stops.
 *  4. Declared total: fewer than declared ⇒ truncated with "read N of M".
 *  5. testApi: ONE request, exactly ONE flattened sample record, pageRecords +
 *     declaredTotal; 200 with 0 records ⇒ not ok; never throws.
 *  6. flattenRecord: dotted keys to depth 3, scalar arrays joined, nested
 *     arrays as JSON, null ⇒ ''.
 *  7. The router: gsheet rows still go to the sheet reader unchanged; api rows
 *     to the API reader; a half-set-up source is an input error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
const caps = vi.hoisted(() => ({ maxPages: 50, maxRows: 50000, maxBytes: 20 * 1024 * 1024 }));
vi.mock('../src/services/behaviorConfig', () => ({
  getBehaviorValue: async (key: string) => ({
    'integrations.max_rows': caps.maxRows,
    'integrations.doc_max_bytes': 5 * 1024 * 1024,
  } as Record<string, number>)[key],
}));
const net = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; opts: any }>,
  handler: null as null | ((u: URL, opts: any) => { status?: number; body: unknown; headers?: Record<string, string> }),
}));
vi.mock('../src/services/integrations/sources/integrationFetch', async () => {
  const real = await vi.importActual<any>('../src/services/integrations/sources/integrationFetch');
  return {
    ...real,
    fetchLimits: async () => ({ maxBytes: caps.maxBytes, timeoutMs: 60000, maxPages: caps.maxPages }),
    guardedFetch: async (url: string | URL, opts: any) => {
      const u = new URL(String(url));
      net.calls.push({ url: u.toString(), opts });
      const r = net.handler!(u, opts);
      const body = Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
      return { status: r.status ?? 200, headers: r.headers ?? { 'content-type': 'application/json' }, body, finalUrl: u.toString(), redirects: 0 };
    },
  };
});
const secrets = vi.hoisted(() => ({ value: null as string | null, calls: [] as any[] }));
vi.mock('../src/services/integrations/store/secretStore', () => ({
  getSecret: async (cn: string, id: string) => { secrets.calls.push([cn, id]); return secrets.value; },
}));
const sheet = vi.hoisted(() => ({ reads: [] as any[], tests: [] as any[] }));
vi.mock('../src/services/integrations/sources/gsheetReader', () => ({
  readGsheet: async (cn: string, cfg: any) => { sheet.reads.push([cn, cfg]); return { records: [], headers: [], rowCount: 0, truncated: false, anomalies: [], sourceLabel: 'S' }; },
  testGsheet: async (cn: string, cfg: any) => { sheet.tests.push([cn, cfg]); return { ok: true, rows: 1, columns: ['a'], sampleRow: { a: '1' } }; },
}));

import {
  ApiReadError, flattenRecord, readApi, readApiConfig, testApi, testApiWith,
} from '../src/services/integrations/sources/apiReader';
import { readSource, sourceProblem, testSource } from '../src/services/integrations/sources';
import { FetchGuardError, IntegrationInputError, type ApiConfig, type ApiSourceRef } from '../src/services/integrations/types';

const CN = 'TENANT_A';
const SECRET = 'S3cr3t-Value-For-Tests-Only-123';

function cfg(over: Partial<ApiConfig> = {}): ApiConfig {
  return {
    baseUrl: 'https://api.acme.test/v1', method: 'GET', path: '/customers', query: { status: 'all' },
    authScheme: 'NONE', recordsPath: 'data', idField: 'id', pagination: { kind: 'none' }, ...over,
  };
}
const ref = (c: ApiConfig): ApiSourceRef => ({ id: 'i1', sourceKind: 'api', apiConfig: c });
const recs = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: from + i, name: `C${from + i}` }));

beforeEach(() => {
  caps.maxPages = 50;
  caps.maxRows = 50000;
  caps.maxBytes = 20 * 1024 * 1024;
  net.calls = [];
  net.handler = () => ({ body: { data: recs(1, 2) } });
  secrets.value = null;
  secrets.calls = [];
  sheet.reads = [];
  sheet.tests = [];
});

// ── 1. auth ───────────────────────────────────────────────────────────────

describe('DEF-362 apiReader — each auth scheme rides as the guard\'s attachment', () => {
  const sentClean = () => {
    // The reader never puts the secret into the URL or headers it builds itself.
    for (const c of net.calls) {
      expect(c.url).not.toContain(SECRET);
      expect(JSON.stringify(c.opts.headers ?? {})).not.toContain(SECRET);
    }
  };

  it('BEARER ⇒ authorization: Bearer <secret>', async () => {
    secrets.value = SECRET;
    await readApi(CN, ref(cfg({ authScheme: 'BEARER' })));
    expect(net.calls[0].opts.auth).toEqual({ headers: { authorization: `Bearer ${SECRET}` }, query: [] });
    expect(secrets.calls[0]).toEqual([CN, 'i1']);
    sentClean();
  });

  it('BASIC ⇒ authorization: Basic base64(user:pass)', async () => {
    secrets.value = 'user:pa55';
    await readApi(CN, ref(cfg({ authScheme: 'BASIC' })));
    expect(net.calls[0].opts.auth.headers.authorization).toBe(`Basic ${Buffer.from('user:pa55').toString('base64')}`);
  });

  it('API_KEY in a header (named, and the X-API-Key default)', async () => {
    secrets.value = SECRET;
    await readApi(CN, ref(cfg({ authScheme: 'API_KEY', authHeaderName: 'X-ESS-Key' })));
    expect(net.calls[0].opts.auth).toEqual({ headers: { 'x-ess-key': SECRET }, query: [] });
    await readApi(CN, ref(cfg({ authScheme: 'API_KEY' })));
    expect(net.calls[1].opts.auth).toEqual({ headers: { 'x-api-key': SECRET }, query: [] });
    sentClean();
  });

  it('API_KEY in the query ⇒ a query attachment, not part of the URL the reader built', async () => {
    secrets.value = SECRET;
    await readApi(CN, ref(cfg({ authScheme: 'API_KEY', authQueryParam: 'key' })));
    expect(net.calls[0].opts.auth).toEqual({ headers: {}, query: [{ name: 'key', value: SECRET }] });
    expect(new URL(net.calls[0].url).searchParams.has('key')).toBe(false);
    sentClean();
  });

  it('NONE sends no credential and never loads one', async () => {
    secrets.value = SECRET;
    await readApi(CN, ref(cfg()));
    expect(net.calls[0].opts.auth).toEqual({ headers: {}, query: [] });
    expect(secrets.calls).toHaveLength(0);
  });

  it('a scheme that needs a secret and has none is refused BEFORE any request', async () => {
    await expect(readApi(CN, ref(cfg({ authScheme: 'BEARER' })))).rejects.toThrow(/no credential has been entered/);
    const t = await testApi(CN, ref(cfg({ authScheme: 'BEARER' })));
    expect(t.ok).toBe(false);
    expect(t.reason).toMatch(/no credential/);
    expect(net.calls).toHaveLength(0);
  });

  it('the request goes to the configured origin with the fixed query, path joined to the base', async () => {
    await readApi(CN, ref(cfg()));
    const u = new URL(net.calls[0].url);
    expect(u.origin).toBe('https://api.acme.test');
    expect(u.pathname).toBe('/v1/customers');
    expect(u.searchParams.get('status')).toBe('all');
    expect(net.calls[0].opts.origin).toBe('https://api.acme.test');
  });

  it('a non-2xx answer fails the read with the status, and the secret echoed back is scrubbed', async () => {
    secrets.value = SECRET;
    net.handler = () => ({ status: 401, body: `invalid token ${SECRET}` });
    const err = await readApi(CN, ref(cfg({ authScheme: 'BEARER' }))).catch((e) => e);
    expect(err).toBeInstanceOf(ApiReadError);
    expect(err.message).toMatch(/401/);
    expect(err.message).not.toContain(SECRET);
  });
});

// ── 2. recordsPath ────────────────────────────────────────────────────────

describe('DEF-362 apiReader — recordsPath', () => {
  it('follows a dotted path', async () => {
    net.handler = () => ({ body: { result: { items: recs(1, 3) } } });
    const r = await readApi(CN, ref(cfg({ recordsPath: 'result.items' })));
    expect(r.rowCount).toBe(3);
    expect(r.records[0]).toEqual({ id: '1', name: 'C1' });
  });

  it("'' = the body itself is the array", async () => {
    net.handler = () => ({ body: recs(1, 2) });
    const r = await readApi(CN, ref(cfg({ recordsPath: '' })));
    expect(r.rowCount).toBe(2);
  });

  it('a path that is not a list fails and names where lists are', async () => {
    net.handler = () => ({ body: { meta: { total: 2 }, results: recs(1, 2) } });
    await expect(readApi(CN, ref(cfg({ recordsPath: 'data' })))).rejects.toThrow(/Lists were found at: results/);
  });

  it('a non-JSON answer fails plainly', async () => {
    net.handler = () => ({ body: '<html>login</html>', headers: { 'content-type': 'text/html' } });
    await expect(readApi(CN, ref(cfg()))).rejects.toThrow(/did not answer with JSON/);
  });

  it('every record gets every header ("" never undefined)', async () => {
    net.handler = () => ({ body: { data: [{ id: 1, a: 'x' }, { id: 2, b: 'y' }] } });
    const r = await readApi(CN, ref(cfg()));
    expect(r.headers).toEqual(['id', 'a', 'b']);
    expect(r.records[1]).toEqual({ id: '2', a: '', b: 'y' });
  });
});

// ── 3. paging ─────────────────────────────────────────────────────────────

describe('DEF-362 apiReader — paging', () => {
  it('page: page=1,2,3 with the page size, stops on a short page', async () => {
    net.handler = (u) => {
      const p = Number(u.searchParams.get('page'));
      return { body: { data: p < 3 ? recs((p - 1) * 2 + 1, 2) : recs(5, 1) } };
    };
    const r = await readApi(CN, ref(cfg({ pagination: { kind: 'page', pageParam: 'page', pageSizeParam: 'per_page', pageSize: 2 } })));
    expect(net.calls.map((c) => new URL(c.url).searchParams.get('page'))).toEqual(['1', '2', '3']);
    expect(new URL(net.calls[0].url).searchParams.get('per_page')).toBe('2');
    expect(r.rowCount).toBe(5);
    expect(r.pagesRead).toBe(3);
    expect(r.truncated).toBe(false);
  });

  it('page with no page size: stops on an empty page; startPage 0 respected', async () => {
    net.handler = (u) => ({ body: { data: Number(u.searchParams.get('p')) < 2 ? recs(Number(u.searchParams.get('p')) * 10, 2) : [] } });
    const r = await readApi(CN, ref(cfg({ pagination: { kind: 'page', pageParam: 'p', startPage: 0 } })));
    expect(net.calls.map((c) => new URL(c.url).searchParams.get('p'))).toEqual(['0', '1', '2']);
    expect(r.rowCount).toBe(4);
    expect(r.truncated).toBe(false);
  });

  it('offset: offset=0,size,2·size with the limit, stops on a short page', async () => {
    net.handler = (u) => {
      const off = Number(u.searchParams.get('offset'));
      return { body: { data: off < 6 ? recs(off + 1, 3) : recs(off + 1, 1) } };
    };
    const r = await readApi(CN, ref(cfg({ pagination: { kind: 'offset', offsetParam: 'offset', limitParam: 'limit', pageSize: 3 } })));
    expect(net.calls.map((c) => new URL(c.url).searchParams.get('offset'))).toEqual(['0', '3', '6']);
    expect(new URL(net.calls[0].url).searchParams.get('limit')).toBe('3');
    expect(r.rowCount).toBe(7);
    expect(r.truncated).toBe(false);
  });

  it('next_url: follows the same-origin link until there is none', async () => {
    net.handler = (u) => {
      const c = u.searchParams.get('cursor');
      if (!c) return { body: { data: recs(1, 2), links: { next: '/v1/customers?cursor=b' } } };
      if (c === 'b') return { body: { data: recs(3, 2), links: { next: 'https://api.acme.test/v1/customers?cursor=c' } } };
      return { body: { data: recs(5, 1), links: { next: null } } };
    };
    const r = await readApi(CN, ref(cfg({ pagination: { kind: 'next_url', nextUrlPath: 'links.next' } })));
    expect(net.calls).toHaveLength(3);
    expect(r.rowCount).toBe(5);
    expect(r.truncated).toBe(false);
  });

  it('next_url on ANOTHER origin fails the read — never followed with the secret', async () => {
    secrets.value = SECRET;
    net.handler = () => ({ body: { data: recs(1, 2), links: { next: 'https://evil.test/steal' } } });
    const err = await readApi(CN, ref(cfg({ authScheme: 'BEARER', pagination: { kind: 'next_url', nextUrlPath: 'links.next' } }))).catch((e) => e);
    expect(err).toBeInstanceOf(FetchGuardError);
    expect(err.kind).toBe('origin');
    expect(net.calls).toHaveLength(1);
  });

  it('max pages: the behaviour cap stops the read and marks it truncated', async () => {
    caps.maxPages = 3;
    net.handler = (u) => ({ body: { data: recs(Number(u.searchParams.get('page')) * 10, 2) } });
    const r = await readApi(CN, ref(cfg({ pagination: { kind: 'page', pageParam: 'page', pageSize: 2 } })));
    expect(net.calls).toHaveLength(3);
    expect(r.truncated).toBe(true);
    expect(r.truncatedReason).toMatch(/after 3 pages/);
  });

  it('a per-integration maxPages may LOWER the cap but never raise it', async () => {
    caps.maxPages = 3;
    net.handler = (u) => ({ body: { data: recs(Number(u.searchParams.get('page')) * 10, 2) } });
    await readApi(CN, ref(cfg({ pagination: { kind: 'page', pageParam: 'page', maxPages: 2 } })));
    expect(net.calls).toHaveLength(2);
    net.calls = [];
    await readApi(CN, ref(cfg({ pagination: { kind: 'page', pageParam: 'page', maxPages: 99 } })));
    expect(net.calls).toHaveLength(3);
  });

  it('an API that ignores the page parameter is stopped, not double-counted', async () => {
    net.handler = () => ({ body: { data: recs(1, 2) } });
    const r = await readApi(CN, ref(cfg({ pagination: { kind: 'page', pageParam: 'page' } })));
    expect(net.calls).toHaveLength(2);
    expect(r.rowCount).toBe(2);
    expect(r.anomalies.join(' ')).toMatch(/identical/);
  });

  it('the row cap truncates', async () => {
    caps.maxRows = 3;
    net.handler = (u) => ({ body: { data: recs(Number(u.searchParams.get('page')) * 10, 2) } });
    const r = await readApi(CN, ref(cfg({ pagination: { kind: 'page', pageParam: 'page', pageSize: 2 } })));
    expect(r.rowCount).toBe(3);
    expect(r.truncated).toBe(true);
  });
});

// ── 4. declared total ─────────────────────────────────────────────────────

describe('DEF-362 apiReader — declared total', () => {
  it('fewer records than declared ⇒ truncated "read N of M"', async () => {
    net.handler = () => ({ body: { data: recs(1, 2), meta: { total: 5 } } });
    const r = await readApi(CN, ref(cfg({ declaredTotalPath: 'meta.total' })));
    expect(r.declaredTotal).toBe(5);
    expect(r.truncated).toBe(true);
    expect(r.truncatedReason).toMatch(/Read 2 of a declared 5/);
  });

  it('as many as declared ⇒ complete; a numeric string total is accepted', async () => {
    net.handler = () => ({ body: { data: recs(1, 2), meta: { total: '2' } } });
    const r = await readApi(CN, ref(cfg({ declaredTotalPath: 'meta.total' })));
    expect(r.declaredTotal).toBe(2);
    expect(r.truncated).toBe(false);
  });
});

// ── 5. testApi ────────────────────────────────────────────────────────────

describe('DEF-362 testApi', () => {
  it('ONE request, exactly ONE flattened record, pageRecords and declaredTotal', async () => {
    net.handler = () => ({ body: { data: [{ id: 1, owner: { name: 'Ali', city: 'Lahore' } }, { id: 2 }, { id: 3 }], meta: { total: 40 } } });
    const t = await testApi(CN, ref(cfg({ declaredTotalPath: 'meta.total', pagination: { kind: 'page', pageParam: 'page', pageSize: 3 } })));
    expect(net.calls).toHaveLength(1);
    expect(t.ok).toBe(true);
    expect(t.sampleRow).toEqual({ id: '1', 'owner.name': 'Ali', 'owner.city': 'Lahore' });
    expect(t.pageRecords).toBe(3);
    expect(t.rows).toBe(3);
    expect(t.declaredTotal).toBe(40);
    expect(t.columns).toEqual(['id', 'owner.name', 'owner.city']);
  });

  it('a 200 with 0 records is NOT ok', async () => {
    net.handler = () => ({ body: { data: [] } });
    const t = await testApi(CN, ref(cfg()));
    expect(t.ok).toBe(false);
    expect(t.sampleRow).toBeNull();
    expect(t.pageRecords).toBe(0);
    expect(t.reason).toMatch(/empty/);
  });

  it('never throws: a refused fetch is ok:false with the guard\'s reason', async () => {
    net.handler = () => { throw new FetchGuardError('address', 'api.acme.test points to a private address.'); };
    const t = await testApi(CN, ref(cfg()));
    expect(t).toMatchObject({ ok: false, reason: 'api.acme.test points to a private address.' });
  });

  it('testApiWith tests a CANDIDATE secret (secretStore.testFirst) without loading the stored one', async () => {
    secrets.value = 'old-stored';
    const t = await testApiWith(CN, cfg({ authScheme: 'BEARER' }), 'candidate-123');
    expect(t.ok).toBe(true);
    expect(net.calls[0].opts.auth.headers.authorization).toBe('Bearer candidate-123');
    expect(secrets.calls).toHaveLength(0);
  });
});

// ── 6. flattenRecord / config ─────────────────────────────────────────────

describe('DEF-362 flattenRecord', () => {
  it('dotted keys to depth 3, deeper as JSON; scalar arrays joined, nested arrays JSON; null ⇒ ""', () => {
    expect(flattenRecord({
      a: 1, b: null, c: true, d: { e: { f: { g: 1 } }, h: 'x' }, tags: ['a', 'b'], lines: [{ q: 1 }],
    })).toEqual({
      a: '1', b: '', c: 'true', 'd.e.f': '{"g":1}', 'd.h': 'x', tags: 'a, b', lines: '[{"q":1}]',
    });
  });

  it('a bare scalar record is one field "value"', () => {
    expect(flattenRecord('x')).toEqual({ value: 'x' });
  });
});

describe('DEF-362 readApiConfig', () => {
  it('refuses http, unknown schemes and broken paging; keeps a valid config', () => {
    expect(readApiConfig({ ...cfg(), baseUrl: 'http://api.acme.test' })).toBeNull();
    expect(readApiConfig({ ...cfg(), authScheme: 'OAUTH2' })).toBeNull();
    expect(readApiConfig({ ...cfg(), pagination: { kind: 'offset', offsetParam: 'o' } })).toBeNull();
    expect(readApiConfig(cfg())).toMatchObject({ baseUrl: 'https://api.acme.test/v1', recordsPath: 'data' });
  });
});

// ── 7. router ─────────────────────────────────────────────────────────────

describe('DEF-362 sources router', () => {
  const sheetRow = { id: 'g1', sourceKind: 'gsheet', sourceConfig: { sheetId: 'abc', gid: '0', link: 'l' } };

  it('gsheet rows go to the sheet reader unchanged (also when sourceKind is absent)', async () => {
    await readSource(CN, sheetRow);
    await testSource(CN, { id: 'g1', sourceConfig: sheetRow.sourceConfig });
    expect(sheet.reads[0]).toEqual([CN, { sheetId: 'abc', gid: '0', link: 'l' }]);
    expect(sheet.tests[0]).toEqual([CN, { sheetId: 'abc', gid: '0', link: 'l' }]);
    expect(net.calls).toHaveLength(0);
  });

  it('api rows go to the API reader', async () => {
    const r = await readSource(CN, { id: 'i1', sourceKind: 'api', sourceConfig: {}, apiConfig: cfg() });
    expect(r.rowCount).toBe(2);
    const t = await testSource(CN, { id: 'i1', sourceKind: 'api', sourceConfig: {}, apiConfig: cfg() });
    expect(t.ok).toBe(true);
    expect(sheet.reads).toHaveLength(0);
  });

  it('a half-set-up source is an input error naming the field', async () => {
    expect(sourceProblem({ id: 'x', sourceKind: 'gsheet', sourceConfig: {} })?.field).toBe('link');
    expect(sourceProblem({ id: 'x', sourceKind: 'api', sourceConfig: {}, apiConfig: null })?.field).toBe('apiConfig');
    await expect(readSource(CN, { id: 'x', sourceKind: 'api', sourceConfig: {}, apiConfig: { baseUrl: 'http://x' } }))
      .rejects.toBeInstanceOf(IntegrationInputError);
  });
});
