// DEF-370 — Suzi desktop routes: Nexeo web asks the Suzi gateway (loopback admin API) to mint a
// per-user API key / list / disconnect computers for the SIGNED-IN person only.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../src/db/prisma', () => {
  const empty: any = new Proxy({}, { get: () => async () => null });
  const p: any = new Proxy({}, { get: () => empty });
  return { __esModule: true, default: p, prisma: p };
});
// requireAuth as a pass-through over the user the test app set
vi.mock('../src/middleware/auth', () => ({
  __esModule: true,
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));
import router from '../src/routes/suziRoutes';

const SECRET = 'test-suzi-admin-secret-0123456789-abcdefghij';
const DEVICE = '6f1c2a8e-5b1d-4e2a-9c3f-0a1b2c3d4e5f';
const K = 'suzi_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
let dir = '';
let calls: { url: string; init: any }[] = [];
let responder: (url: string, init: any) => Response | Promise<Response>;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let nextUserId = 100; // fresh id per app so the per-user rate limiter never carries budget across tests
function appAs(user: Record<string, unknown> = {}) {
  const id = (user.id as number) ?? nextUserId++;
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.user = { id, clientNumber: 'TMC-0001', name: 'Ayesha Khan', email: 'ayesha@example.com', userType: 'BS', isAdmin: false, isSuperAdmin: false, ...user };
    next();
  });
  app.use('/api/v1/suzi', router);
  return app;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'suzi-'));
  writeFileSync(join(dir, 'secret'), `${SECRET}\n`);
  process.env.SUZI_GATEWAY_ADMIN_SECRET_FILE = join(dir, 'secret');
  process.env.SUZI_GATEWAY_ADMIN_URL = 'http://127.0.0.1:4012';
  calls = [];
  responder = () => json({});
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
    calls.push({ url: String(url), init });
    return responder(String(url), init);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.SUZI_GATEWAY_ADMIN_SECRET_FILE;
  delete process.env.SUZI_GATEWAY_ADMIN_URL;
  delete process.env.SUZI_GATEWAY_TIMEOUT_MS;
});

describe('POST /api/v1/suzi/api-key', () => {
  it("mints the signed-in person's own key: user id, clientNumber and name come from req.user, never the body", async () => {
    responder = () => json({ api_key: K, key_prefix: 'suzi_AAAAAAA', expires_at: '2026-11-30T00:00:00.000Z', device_id: DEVICE, server_url: 'https://tai.tmcltd.com/suzi' });
    const r = await request(appAs({ id: 17 }))
      .post('/api/v1/suzi/api-key')
      .send({ user_id: '999', tenant_id: 'OTHER-TENANT', clientNumber: 'OTHER', user_name: 'Mallory', validityDays: 90 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      apiKey: K,
      keyPrefix: 'suzi_AAAAAAA',
      expiresAt: '2026-11-30T00:00:00.000Z',
      validityDays: 90,
      serverUrl: 'https://tai.tmcltd.com/suzi',
      connectLink: `suzi://connect?server=https%3A%2F%2Ftai.tmcltd.com%2Fsuzi&key=${K}`,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:4012/admin/api-keys');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body)).toEqual({ user_id: '17', tenant_id: 'TMC-0001', user_name: 'Ayesha Khan', validity_days: 90, created_by: 'nexeo-web' });
  });

  it('validity defaults to 30 days; only 7, 30, 90 or never are accepted', async () => {
    responder = () => json({ api_key: K, key_prefix: 'suzi_AAAAAAA', expires_at: '2026-11-30T00:00:00.000Z', device_id: DEVICE, server_url: 'https://tai.tmcltd.com/suzi' });
    await request(appAs()).post('/api/v1/suzi/api-key');
    expect(JSON.parse(calls[0].init.body).validity_days).toBe(30);
    for (const bad of [1, 365, 'forever', -7, 'Never']) {
      expect((await request(appAs()).post('/api/v1/suzi/api-key').send({ validityDays: bad })).status).toBe(400);
    }
    expect(calls).toHaveLength(1);
  });

  it('"never" mints a key with no expiry (DEF-373)', async () => {
    responder = () => json({ api_key: K, key_prefix: 'suzi_AAAAAAA', expires_at: null, device_id: DEVICE, server_url: 'https://tai.tmcltd.com/suzi' });
    const r = await request(appAs()).post('/api/v1/suzi/api-key').send({ validityDays: 'never' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ apiKey: K, expiresAt: null, validityDays: 'never' });
    expect(JSON.parse(calls[0].init.body).validity_days).toBe('never');
  });

  it('a dated key the gateway returns without an expiry is refused, not shown as never-expiring', async () => {
    responder = () => json({ api_key: K, key_prefix: 'suzi_AAAAAAA', expires_at: null, device_id: DEVICE, server_url: 'https://tai.tmcltd.com/suzi' });
    expect((await request(appAs()).post('/api/v1/suzi/api-key').send({ validityDays: 30 })).status).toBe(502);
  });

  it('two people get two different keys, each minted for its own user', async () => {
    let n = 0;
    responder = (_u, init) => json({ api_key: `suzi_${String(++n).repeat(43)}`, key_prefix: 'x', expires_at: '2026-11-30T00:00:00.000Z', device_id: DEVICE, server_url: 'https://tai.tmcltd.com/suzi', _for: JSON.parse(init.body).user_id });
    const a = await request(appAs({ id: 501, name: 'Ayesha' })).post('/api/v1/suzi/api-key');
    const b = await request(appAs({ id: 502, name: 'Bilal' })).post('/api/v1/suzi/api-key');
    expect(a.body.apiKey).not.toBe(b.body.apiKey);
    expect(calls.map((c) => JSON.parse(c.init.body).user_id)).toEqual(['501', '502']);
    expect(calls.map((c) => JSON.parse(c.init.body).user_name)).toEqual(['Ayesha', 'Bilal']);
  });

  it('sends the secret only in the Authorization header, never follows redirects, and never echoes it', async () => {
    responder = () => json({ api_key: K, key_prefix: 'suzi_AAAAAAA', expires_at: '2026-11-30T00:00:00.000Z', device_id: DEVICE, server_url: 'https://tai.tmcltd.com/suzi' });
    const r = await request(appAs()).post('/api/v1/suzi/api-key');
    expect(calls[0].init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(r.body.apiKey).toBe(K); // the user's key is shown to them, once
    expect(calls[0].init.redirect).toBe('manual');
    expect(calls[0].init.signal).toBeDefined();
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    expect(calls[0].init.body).not.toContain(SECRET);
  });

  it('falls back to the email when the account has no name', async () => {
    responder = () => json({ api_key: K, key_prefix: 'suzi_AAAAAAA', expires_at: '2026-11-30T00:00:00.000Z', device_id: DEVICE, server_url: 'https://tai.tmcltd.com/suzi' });
    responder = () => json({ api_key: K, key_prefix: 'x', expires_at: '2026-11-30T00:00:00.000Z', device_id: DEVICE, server_url: 'https://tai.tmcltd.com/suzi' });
    await request(appAs({ name: '' })).post('/api/v1/suzi/api-key');
    expect(JSON.parse(calls[0].init.body).user_name).toBe('ayesha@example.com');
  });

  it('refuses agent tokens (403) without calling the gateway', async () => {
    const r = await request(appAs({ isAgent: true, name: undefined })).post('/api/v1/suzi/api-key');
    expect(r.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('refuses a request with no tenant (401) without calling the gateway', async () => {
    const r = await request(appAs({ clientNumber: '' })).post('/api/v1/suzi/api-key');
    expect(r.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('missing or too-short secret file → 503 "not set up", and no call goes out', async () => {
    rmSync(join(dir, 'secret'));
    const a = await request(appAs()).post('/api/v1/suzi/api-key');
    expect(a.status).toBe(503);
    expect(a.body.error).toMatch(/not set up/);
    writeFileSync(join(dir, 'secret'), 'short');
    expect((await request(appAs()).post('/api/v1/suzi/api-key')).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('gateway down, timing out or erroring → 502 with a generic message (no URL, no secret)', async () => {
    responder = () => { throw new TypeError('fetch failed: ECONNREFUSED 127.0.0.1:4012'); };
    const down = await request(appAs()).post('/api/v1/suzi/api-key');
    expect(down.status).toBe(502);
    expect(down.body.error).toBe('Suzi server could not be reached');
    responder = () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; };
    expect((await request(appAs()).post('/api/v1/suzi/api-key')).body.error).toBe('Suzi server did not answer in time');
    responder = () => json({ error: { code: 'internal', message: 'db down' } }, 500);
    const err = await request(appAs()).post('/api/v1/suzi/api-key');
    expect(err.status).toBe(502);
    expect(JSON.stringify(err.body)).not.toMatch(/4012|db down|Bearer/);
    responder = () => json({ unexpected: true });
    expect((await request(appAs()).post('/api/v1/suzi/api-key')).status).toBe(502);
    // a key without a usable server URL is not handed out
    responder = () => json({ api_key: K, expires_at: '2026-11-30T00:00:00.000Z', server_url: 'javascript:alert(1)' });
    expect((await request(appAs()).post('/api/v1/suzi/api-key')).status).toBe(502);
  });

  it('gateway without its own secret (503) → 503 "not set up"', async () => {
    responder = () => json({ error: { code: 'not_configured' } }, 503);
    expect((await request(appAs()).post('/api/v1/suzi/api-key')).status).toBe(503);
  });

  it('is rate limited per user (10 a minute)', async () => {
    responder = () => json({ api_key: K, key_prefix: 'suzi_AAAAAAA', expires_at: '2026-11-30T00:00:00.000Z', device_id: DEVICE, server_url: 'https://tai.tmcltd.com/suzi' });
    const app = appAs({ id: 4242 });
    for (let i = 0; i < 10; i++) expect((await request(app).post('/api/v1/suzi/api-key')).status).toBe(200);
    expect((await request(app).post('/api/v1/suzi/api-key')).status).toBe(429);
    expect(calls).toHaveLength(10);
  });
});

describe('GET /api/v1/suzi/devices', () => {
  it("lists the caller's computers (query params are ignored) and maps the gateway's fields", async () => {
    responder = () => json({ devices: [{ id: DEVICE, name: 'Suzi desktop', os: 'unknown', connected_at: '2026-10-30T20:00:00.000Z', last_seen_at: null, online: true, expires_at: '2026-11-30T00:00:00.000Z', key_prefix: 'suzi_AAAAAAA', kind: 'api_key' }] });
    const r = await request(appAs({ id: 17 })).get('/api/v1/suzi/devices?user_id=999&tenant_id=OTHER');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ devices: [{ id: DEVICE, name: 'Suzi desktop', os: 'unknown', connectedAt: '2026-10-30T20:00:00.000Z', lastSeenAt: null, online: true, expiresAt: '2026-11-30T00:00:00.000Z', keyPrefix: 'suzi_AAAAAAA' }] });
    expect(calls[0].url).toBe('http://127.0.0.1:4012/admin/devices?user_id=17&tenant_id=TMC-0001');
    expect(calls[0].init.method).toBe('GET');
  });
});

describe('DELETE /api/v1/suzi/devices/:id', () => {
  it('disconnects one of the caller\'s computers, naming the caller as owner', async () => {
    responder = () => json({ ok: true, closed: 1 });
    const r = await request(appAs({ id: 17 })).delete(`/api/v1/suzi/devices/${DEVICE}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(calls[0].url).toBe('http://127.0.0.1:4012/admin/revoke');
    expect(JSON.parse(calls[0].init.body)).toEqual({ device_id: DEVICE, user_id: '17', tenant_id: 'TMC-0001' });
  });

  it("someone else's computer (gateway 404) → 404", async () => {
    responder = () => json({ error: { code: 'not_found' } }, 404);
    const r = await request(appAs()).delete(`/api/v1/suzi/devices/${DEVICE}`);
    expect(r.status).toBe(404);
  });

  it('rejects a malformed id without calling the gateway', async () => {
    const r = await request(appAs()).delete('/api/v1/suzi/devices/not-a-uuid');
    expect(r.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});
