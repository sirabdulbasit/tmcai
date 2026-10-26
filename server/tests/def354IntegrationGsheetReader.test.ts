/**
 * DEF-354 — Integrations Stage 1, sources/gsheetReader.ts.
 *
 * Rules pinned (spec INTEGRATIONS_DESIGN.md §2.2):
 *  - The only address fetched is docs.google.com/…/export?format=csv&gid=<gid>,
 *    rebuilt from the stored id + gid; the bearer token goes to that host only,
 *    never to a redirect target; redirects outside Google are refused.
 *  - Private sheets read with the tenant's DESIGNATED account only
 *    (system_config.google_drive_org_user_id, an active user of THIS tenant);
 *    no account ⇒ anonymous read — never "any connected user" (review fix).
 *  - The account is resolved with userId: null, so the admin's user scope
 *    cannot hide the designated token or substitute the admin's own.
 *    An unreadable designated account ⇒ CredentialUnreadableError — never a
 *    fallback to someone else's account.
 *  - An HTML answer / sign-in redirect / 401 / 403 = "not shared".
 *  - Caps from behaviorConfig: bytes (streamed, truncated), rows (truncated).
 *  - testGsheet: a 200 with 0 data rows is NOT ok.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
  behavior: {
    'integrations.sheet_max_bytes': 10 * 1024 * 1024,
    'integrations.sheet_timeout_ms': 60000,
    'integrations.max_rows': 50000,
  } as Record<string, number>,
  behaviorCtx: [] as any[],
  scribeUser: null as number | null,
  scribeCalls: [] as string[],
  auth: { client: { getAccessToken: async () => ({ token: 'tok-123' }) } } as any,
  authCalls: [] as number[],
  fallbackCalls: 0,
  inactive: new Set<number>(),
  scope: undefined as any,
  lookupScopes: [] as any[],
  authScopes: [] as any[],
}));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/services/behaviorConfig', () => ({
  getBehaviorValue: async (key: string, ctx: any) => { state.behaviorCtx.push(ctx); return state.behavior[key]; },
}));
vi.mock('../src/services/knowledge/folderScribeService', () => ({
  pickTenantScribeUser: async () => { state.fallbackCalls += 1; return 99; },
}));
vi.mock('../src/db/tenantContext', () => ({
  runInTenantScope: async (scope: any, fn: () => Promise<any>) => {
    const prev = state.scope; state.scope = scope;
    try { return await fn(); } finally { state.scope = prev; }
  },
  runWithoutTenant: async (fn: () => Promise<any>) => fn(),
  currentTenant: () => state.scope,
}));
vi.mock('../src/db/prisma', () => ({
  __esModule: true,
  default: {
    systemConfig: {
      findFirst: async ({ where }: any) => {
        state.scribeCalls.push(where.clientNumber);
        state.lookupScopes.push(state.scope);
        return where.key === 'google_drive_org_user_id' && state.scribeUser != null ? { value: String(state.scribeUser) } : null;
      },
    },
    user: {
      findFirst: async ({ where }: any) =>
        (where.clientNumber && where.isActive === true && !state.inactive.has(where.id) ? { id: where.id } : null),
    },
  },
}));
vi.mock('../src/services/integrationService', () => ({
  getAuthenticatedClient: async (userId: number) => { state.authCalls.push(userId); state.authScopes.push(state.scope); return state.auth; },
}));

import { readGsheet, testGsheet, readCapped, nameFromDisposition, GsheetReadError, gsheetSource }
  from '../src/services/integrations/sources/gsheetReader';
import { CredentialUnreadableError, type GsheetSourceConfig } from '../src/services/integrations/types';

const CN = 'TMC-0001';
const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ab';
const CFG: GsheetSourceConfig = { sheetId: ID, gid: '42', link: `https://docs.google.com/spreadsheets/d/${ID}/edit#gid=42` };
const EXPORT = `https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=42`;

type Call = { url: string; headers: Record<string, string>; redirect?: string };
let calls: Call[];
let responder: (url: string, call: Call) => Response;

const csv = (body: string, extra: Record<string, string> = {}) =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/csv', ...extra } });

beforeEach(() => {
  calls = [];
  state.scribeUser = null;
  state.scribeCalls = [];
  state.authCalls = [];
  state.fallbackCalls = 0;
  state.inactive = new Set();
  state.scope = undefined;
  state.lookupScopes = [];
  state.authScopes = [];
  state.behaviorCtx = [];
  state.behavior['integrations.sheet_max_bytes'] = 10 * 1024 * 1024;
  state.behavior['integrations.max_rows'] = 50000;
  state.auth = { client: { getAccessToken: async () => ({ token: 'tok-123' }) } };
  responder = () => csv('Month,Revenue\nJan 2026,100\nFeb 2026,200\n');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    const call: Call = { url: String(url), headers: { ...(init?.headers ?? {}) }, redirect: init?.redirect };
    calls.push(call);
    return responder(String(url), call);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('DEF-354 readGsheet — address and account', () => {
  it('fetches only the rebuilt export URL, anonymously when no account is designated', async () => {
    const r = await readGsheet(CN, CFG);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(EXPORT);
    expect(calls[0]!.redirect).toBe('manual');
    expect(calls[0]!.headers.Authorization).toBeUndefined();
    expect(state.scribeCalls).toEqual([CN]);
    expect(state.behaviorCtx.every((c) => c.clientNumber === CN)).toBe(true);
    expect(r.headers).toEqual(['Month', 'Revenue']);
    expect(r.records).toEqual([{ Month: 'Jan 2026', Revenue: '100' }, { Month: 'Feb 2026', Revenue: '200' }]);
    expect(r.rowCount).toBe(2);
    expect(r.truncated).toBe(false);
  });

  it('no designated account ⇒ anonymous; never falls back to another connected user', async () => {
    const r = await readGsheet(CN, CFG);
    expect(r.rowCount).toBe(2);
    expect(state.fallbackCalls).toBe(0);
    expect(state.authCalls).toEqual([]);
    expect(calls[0]!.headers.Authorization).toBeUndefined();
  });

  it('a designated but inactive user ⇒ anonymous; no other account is tried', async () => {
    state.scribeUser = 7;
    state.inactive.add(7);
    await readGsheet(CN, CFG);
    expect(state.fallbackCalls).toBe(0);
    expect(state.authCalls).toEqual([]);
    expect(calls[0]!.headers.Authorization).toBeUndefined();
  });

  it('resolves the account in this tenant with userId null, whoever is signed in', async () => {
    state.scribeUser = 7;
    state.scope = { clientNumber: CN, userId: 12, bypass: false }; // an admin's request scope
    await readGsheet(CN, CFG);
    expect(state.lookupScopes).toEqual([{ clientNumber: CN, userId: null, bypass: false }]);
    expect(state.authScopes).toEqual([{ clientNumber: CN, userId: null, bypass: false }]);
    expect(state.authCalls).toEqual([7]);
  });

  it('a designated account sends its bearer token to docs.google.com', async () => {
    state.scribeUser = 7;
    await readGsheet(CN, CFG);
    expect(state.authCalls).toEqual([7]);
    expect(calls[0]!.headers.Authorization).toBe('Bearer tok-123');
  });

  it('follows a redirect to googleusercontent WITHOUT the token, and refuses one outside Google', async () => {
    state.scribeUser = 7;
    responder = (url) => url === EXPORT
      ? new Response(null, { status: 307, headers: { location: 'https://doc-0s.googleusercontent.com/export/x' } })
      : csv('A\n1\n');
    const r = await readGsheet(CN, CFG);
    expect(r.rowCount).toBe(1);
    expect(calls[1]!.url).toBe('https://doc-0s.googleusercontent.com/export/x');
    expect(calls[1]!.headers.Authorization).toBeUndefined();

    calls = [];
    responder = () => new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } });
    await expect(readGsheet(CN, CFG)).rejects.toThrow(/outside Google/);
    expect(calls).toHaveLength(1);
  });

  it('an unreadable designated account is CredentialUnreadableError when Google refuses the anonymous read', async () => {
    state.scribeUser = 7;
    state.auth = { client: null, error: 'token decrypt failed' };
    responder = () => new Response('<!DOCTYPE html><html>sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    await expect(readGsheet(CN, CFG)).rejects.toBeInstanceOf(CredentialUnreadableError);
    expect(calls[0]!.headers.Authorization).toBeUndefined();
  });

  it('an unreadable account still reads a PUBLIC sheet anonymously', async () => {
    state.scribeUser = 7;
    state.auth = { client: { getAccessToken: async () => { throw new Error('invalid_grant'); } } };
    const r = await readGsheet(CN, CFG);
    expect(r.rowCount).toBe(2);
  });

  it('a refused token read retries once anonymously (stale token on a public sheet)', async () => {
    state.scribeUser = 7;
    responder = (_u, call) => call.headers.Authorization ? new Response('', { status: 401 }) : csv('A\n1\n');
    const r = await readGsheet(CN, CFG);
    expect(r.rowCount).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers.Authorization).toBeUndefined();
  });
});

describe('DEF-354 readGsheet — not shared / errors', () => {
  it.each([
    ['HTML content-type', () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })],
    ['HTML body sent as csv', () => csv('<!doctype html><html><body>Sign in</body></html>')],
    ['403', () => new Response('', { status: 403 })],
    ['sign-in redirect', () => new Response(null, { status: 302, headers: { location: 'https://accounts.google.com/ServiceLogin' } })],
  ])('%s ⇒ "not shared" GsheetReadError', async (_n, make) => {
    responder = make as any;
    const err = await readGsheet(CN, CFG).catch((e) => e);
    expect(err).toBeInstanceOf(GsheetReadError);
    expect(err.message).toMatch(/not shared/);
  });

  it('404 ⇒ not found, 500 ⇒ status named, network error ⇒ could not be reached', async () => {
    responder = () => new Response('', { status: 404 });
    await expect(readGsheet(CN, CFG)).rejects.toThrow(/not found/);
    responder = () => new Response('', { status: 500 });
    await expect(readGsheet(CN, CFG)).rejects.toThrow(/answered 500/);
    responder = () => { throw new TypeError('ECONNRESET'); };
    await expect(readGsheet(CN, CFG)).rejects.toThrow(/could not be reached/);
  });

  it('a tampered stored config never reaches fetch', async () => {
    await expect(readGsheet(CN, { ...CFG, gid: '1&x=y' })).rejects.toThrow(/gid/);
    expect(calls).toHaveLength(0);
  });
});

describe('DEF-354 readGsheet — caps', () => {
  it('the byte cap stops the stream and marks the read truncated', async () => {
    state.behavior['integrations.sheet_max_bytes'] = 20;
    responder = () => csv('A,B\n1,2\n3,4\n5,6\n7,8\n9,10\n');
    const r = await readGsheet(CN, CFG);
    expect(r.truncated).toBe(true);
    expect(r.truncatedReason).toMatch(/larger than/);
    // 20 bytes = "A,B\n1,2\n3,4\n5,6\n7,8\n" minus the possibly-partial last row.
    expect(r.rowCount).toBeLessThan(5);
  });

  it('the row cap marks the read truncated', async () => {
    state.behavior['integrations.max_rows'] = 1;
    const r = await readGsheet(CN, CFG);
    expect(r.rowCount).toBe(1);
    expect(r.truncated).toBe(true);
  });

  it('readCapped never returns more than max bytes', async () => {
    const res = new Response('x'.repeat(1000));
    const { bytes, truncated } = await readCapped(res, 100);
    expect(bytes.length).toBe(100);
    expect(truncated).toBe(true);
    const small = await readCapped(new Response('abc'), 100);
    expect(small).toMatchObject({ truncated: false });
    expect(small.bytes.toString()).toBe('abc');
  });
});

describe('DEF-354 testGsheet', () => {
  it('ok only with at least one data row, with columns and a sample row', async () => {
    const t = await testGsheet(CN, CFG);
    expect(t).toEqual({ ok: true, rows: 2, columns: ['Month', 'Revenue'], sampleRow: { Month: 'Jan 2026', Revenue: '100' } });
  });

  it('a 200 with a header but 0 data rows is NOT ok', async () => {
    responder = () => csv('Month,Revenue\n');
    const t = await testGsheet(CN, CFG);
    expect(t.ok).toBe(false);
    expect(t.rows).toBe(0);
    expect(t.columns).toEqual(['Month', 'Revenue']);
    expect(t.reason).toMatch(/no data rows/);
  });

  it('an empty 200 is NOT ok', async () => {
    responder = () => csv('');
    const t = await testGsheet(CN, CFG);
    expect(t.ok).toBe(false);
    expect(t.reason).toMatch(/empty/);
  });

  it('a failed read becomes ok:false with the reason, never a throw', async () => {
    responder = () => new Response('', { status: 403 });
    const t = await testGsheet(CN, CFG);
    expect(t.ok).toBe(false);
    expect(t.reason).toMatch(/not shared/);
  });

  it('gsheetSource delegates to the config of the integration ref', async () => {
    const t = await gsheetSource.test(CN, { id: 'i1', sourceKind: 'gsheet', sourceConfig: CFG });
    expect(t.ok).toBe(true);
    expect(calls[0]!.url).toBe(EXPORT);
  });
});

describe('DEF-354 labels', () => {
  it('nameFromDisposition reads both filename forms', () => {
    expect(nameFromDisposition(`attachment; filename*=UTF-8''Sales%202026%20-%20Monthly.csv`)).toBe('Sales 2026 - Monthly.csv');
    expect(nameFromDisposition('attachment; filename="Plain.csv"')).toBe('Plain.csv');
    expect(nameFromDisposition(null)).toBeNull();
  });

  it('sourceLabel combines the file name and the tab label', async () => {
    responder = () => csv('A\n1\n', { 'content-disposition': 'attachment; filename="Sales 2026.csv"' });
    expect((await readGsheet(CN, { ...CFG, tabLabel: 'Monthly' })).sourceLabel).toBe('Sales 2026 › Monthly');
    responder = () => csv('A\n1\n');
    expect((await readGsheet(CN, CFG)).sourceLabel).toBe('Google Sheet (tab 42)');
  });
});
