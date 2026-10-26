/**
 * DEF-362 — Integrations Stage 1b: the REST fetch guard (spec §2b "REST fetch
 * guard"; vm integrationSyncEngine assertSameOrigin).
 *
 * The URL comes from an LLM-drafted connection and from the outside system's
 * own responses, and every request carries the tenant's credential. Pinned:
 *  1. https only — http is refused before DNS is even asked.
 *  2. Every resolved address is vetted: a private, loopback, link-local
 *     (metadata), CGNAT or IPv6 unique-local address is refused, and ONE bad
 *     record among good ones refuses the host.
 *  3. The socket is pinned to the vetted address (the agent's lookup answers
 *     only that address; SNI keeps the name) — no DNS rebinding.
 *  4. Redirects: same-origin only, ≤ 3, each hop re-resolved and re-vetted.
 *  5. Next-page URLs on another origin are refused.
 *  6. The byte cap is enforced on the declared length, the streamed length and
 *     the DECOMPRESSED length (gzip bomb).
 *  7. The credential rides only to the configured origin and is stripped from
 *     the returned finalUrl.
 * DNS and https are mocked: no network is touched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import dns from 'dns';
import https from 'https';
import zlib from 'zlib';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/services/behaviorConfig', () => ({
  getBehaviorValue: async (key: string) => ({
    'integrations.api_max_bytes': 20 * 1024 * 1024,
    'integrations.api_timeout_ms': 60000,
    'integrations.api_max_pages': 50,
  } as Record<string, number>)[key],
}));

import {
  assertSameOrigin, buildAuth, fetchLimits, guardedFetch, isForbiddenAddress,
} from '../src/services/integrations/sources/integrationFetch';
import { FetchGuardError } from '../src/services/integrations/types';

const ORIGIN = 'https://api.example.com';
const PUBLIC_IP = '93.184.216.34';
const LIMITS = { maxBytes: 1024 * 1024, timeoutMs: 5000 };

interface Reply { status: number; headers?: Record<string, string>; body?: Buffer | string; chunks?: Buffer[] }
interface Sent { options: any; body: string }

let replies: Reply[];
let sent: Sent[];
let lookupSpy: ReturnType<typeof vi.spyOn>;
let requestSpy: ReturnType<typeof vi.spyOn>;

function fakeRequest(options: any) {
  const req: any = new EventEmitter();
  const s: Sent = { options, body: '' };
  sent.push(s);
  req.write = (b: string) => { s.body += b; };
  req.destroy = vi.fn();
  req.end = () => {
    const r = replies.shift();
    if (!r) { setImmediate(() => req.emit('error', Object.assign(new Error('no reply'), { code: 'ECONNREFUSED' }))); return; }
    const res: any = new PassThrough();
    res.statusCode = r.status;
    res.headers = r.headers ?? {};
    setImmediate(() => {
      req.emit('response', res);
      const chunks = r.chunks ?? [Buffer.from(r.body ?? '')];
      for (const c of chunks) res.write(c);
      res.end();
    });
  };
  return req;
}

const lookupAnswers = (...addrs: string[]) =>
  lookupSpy.mockResolvedValue(addrs.map((address) => ({ address, family: address.includes(':') ? 6 : 4 })) as any);

beforeEach(() => {
  replies = [];
  sent = [];
  lookupSpy = vi.spyOn(dns.promises, 'lookup');
  lookupAnswers(PUBLIC_IP);
  requestSpy = vi.spyOn(https, 'request').mockImplementation(fakeRequest as any);
});
afterEach(() => { vi.restoreAllMocks(); });

async function guardKind(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) {
    expect(e).toBeInstanceOf(FetchGuardError);
    return (e as FetchGuardError).kind;
  }
  throw new Error('expected a FetchGuardError');
}

describe('DEF-362 fetch guard — scheme and addresses', () => {
  it('refuses http:// before resolving anything', async () => {
    expect(await guardKind(guardedFetch('http://api.example.com/x', { origin: 'http://api.example.com', ...LIMITS }))).toBe('scheme');
    expect(await guardKind(guardedFetch('http://api.example.com/x', { origin: ORIGIN, ...LIMITS }))).toBe('scheme');
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('refuses a host that resolves to a private address', async () => {
    for (const ip of ['10.1.2.3', '172.20.0.1', '192.168.1.1', '127.0.0.1', '100.64.0.9', '169.254.169.254', '0.0.0.0']) {
      lookupAnswers(ip);
      expect(await guardKind(guardedFetch(`${ORIGIN}/v1/items`, { origin: ORIGIN, ...LIMITS })), ip).toBe('address');
    }
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('refuses mixed A records: one private address among public ones refuses the host', async () => {
    lookupAnswers(PUBLIC_IP, '93.184.216.35', '127.0.0.1');
    expect(await guardKind(guardedFetch(`${ORIGIN}/v1/items`, { origin: ORIGIN, ...LIMITS }))).toBe('address');
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('refuses IP-literal URLs for metadata / loopback without asking DNS', async () => {
    expect(await guardKind(guardedFetch('https://169.254.169.254/latest/meta-data', { origin: 'https://169.254.169.254', ...LIMITS }))).toBe('address');
    expect(await guardKind(guardedFetch('https://[::1]/x', { origin: 'https://[::1]', ...LIMITS }))).toBe('address');
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('classifies the IPv4 and IPv6 ranges', () => {
    for (const a of ['127.0.0.1', '10.0.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.127.0.1', '0.1.2.3',
      '224.0.0.1', '255.255.255.255', '::1', '::', 'fd00::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1',
      '::ffff:10.0.0.1', 'not-an-ip']) {
      expect(isForbiddenAddress(a), a).toBe(true);
    }
    for (const a of [PUBLIC_IP, '8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111']) {
      expect(isForbiddenAddress(a), a).toBe(false);
    }
  });

  it('a DNS failure is a guard error, not a crash', async () => {
    lookupSpy.mockRejectedValue(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }));
    expect(await guardKind(guardedFetch(`${ORIGIN}/x`, { origin: ORIGIN, ...LIMITS }))).toBe('dns');
  });
});

describe('DEF-362 fetch guard — pinning and the credential', () => {
  it('pins the socket to the vetted address and keeps the name for TLS', async () => {
    replies.push({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"items":[]}' });
    const r = await guardedFetch(`${ORIGIN}/v1/items?x=1`, { origin: ORIGIN, ...LIMITS });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('{"items":[]}');
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    const o = sent[0].options;
    expect(o.hostname).toBe('api.example.com');
    expect(o.servername).toBe('api.example.com');
    expect(o.path).toBe('/v1/items?x=1');
    // A later DNS answer (rebinding) cannot move the socket: the agent's lookup
    // answers only the vetted address, whatever name it is asked about.
    lookupAnswers('127.0.0.1');
    const lk = o.agent.options.lookup;
    const single = await new Promise<any[]>((res) => lk('api.example.com', {}, (...a: any[]) => res(a)));
    expect(single).toEqual([null, PUBLIC_IP, 4]);
    const all = await new Promise<any[]>((res) => lk('api.example.com', { all: true }, (...a: any[]) => res(a)));
    expect(all).toEqual([null, [{ address: PUBLIC_IP, family: 4 }]]);
  });

  it('attaches the credential (header and query) to the configured origin and strips it from finalUrl', async () => {
    replies.push({ status: 200, body: '[]' });
    const auth = { headers: { Authorization: 'Bearer S3CRET' }, query: [{ name: 'api_key', value: 'Q-S3CRET' }] };
    const r = await guardedFetch(`${ORIGIN}/v1/items`, { origin: `${ORIGIN}/base/`, auth, ...LIMITS });
    expect(sent[0].options.headers.authorization).toBe('Bearer S3CRET');
    expect(sent[0].options.path).toContain('api_key=Q-S3CRET');
    expect(r.finalUrl).toBe(`${ORIGIN}/v1/items`);
    expect(r.finalUrl).not.toContain('S3CRET');
  });

  it('config headers cannot override Host', async () => {
    replies.push({ status: 200, body: '[]' });
    await guardedFetch(`${ORIGIN}/v1/items`, { origin: ORIGIN, headers: { Host: 'internal.local', 'X-Tenant': 'a' }, ...LIMITS });
    expect(sent[0].options.headers.host).toBeUndefined();
    expect(sent[0].options.headers['x-tenant']).toBe('a');
  });

  it('buildAuth places each scheme correctly and attaches nothing without a secret', () => {
    expect(buildAuth({ authScheme: 'BEARER' }, 'tok')).toEqual({ headers: { authorization: 'Bearer tok' }, query: [] });
    expect(buildAuth({ authScheme: 'BASIC' }, 'u:p')).toEqual({ headers: { authorization: `Basic ${Buffer.from('u:p').toString('base64')}` }, query: [] });
    expect(buildAuth({ authScheme: 'API_KEY' }, 'k')).toEqual({ headers: { 'x-api-key': 'k' }, query: [] });
    expect(buildAuth({ authScheme: 'API_KEY', authHeaderName: 'X-Token' }, 'k')).toEqual({ headers: { 'x-token': 'k' }, query: [] });
    expect(buildAuth({ authScheme: 'API_KEY', authHeaderName: 'X-Token', authQueryParam: 'key' }, 'k'))
      .toEqual({ headers: {}, query: [{ name: 'key', value: 'k' }] });
    expect(buildAuth({ authScheme: 'NONE' }, 'k')).toEqual({ headers: {}, query: [] });
    expect(buildAuth({ authScheme: 'BEARER' }, null)).toEqual({ headers: {}, query: [] });
  });

  it('fetchLimits reads the three behavior keys', async () => {
    expect(await fetchLimits('TMC-0001')).toEqual({ maxBytes: 20 * 1024 * 1024, timeoutMs: 60000, maxPages: 50 });
  });
});

describe('DEF-362 fetch guard — redirects and next pages', () => {
  it('refuses a cross-origin redirect and never sends the credential there', async () => {
    replies.push({ status: 302, headers: { location: 'https://collector.evil.example/steal' } });
    const auth = { headers: { authorization: 'Bearer S3CRET' }, query: [] };
    expect(await guardKind(guardedFetch(`${ORIGIN}/v1/items`, { origin: ORIGIN, auth, ...LIMITS }))).toBe('redirect');
    expect(sent).toHaveLength(1);
    expect(sent[0].options.hostname).toBe('api.example.com');
  });

  it('refuses a redirect that downgrades to http on the same host', async () => {
    replies.push({ status: 301, headers: { location: 'http://api.example.com/v1/items' } });
    expect(await guardKind(guardedFetch(`${ORIGIN}/v1/items`, { origin: ORIGIN, ...LIMITS }))).toBe('redirect');
    expect(sent).toHaveLength(1);
  });

  it('follows a same-origin redirect, re-resolving and re-vetting the host', async () => {
    replies.push({ status: 302, headers: { location: '/v2/items' } }, { status: 200, body: '[1]' });
    const r = await guardedFetch(`${ORIGIN}/v1/items`, { origin: ORIGIN, ...LIMITS });
    expect(r.status).toBe(200);
    expect(r.redirects).toBe(1);
    expect(r.finalUrl).toBe(`${ORIGIN}/v2/items`);
    expect(lookupSpy).toHaveBeenCalledTimes(2);
    expect(sent[1].options.path).toBe('/v2/items');
  });

  it('a same-origin redirect whose host now resolves privately is refused (re-vetted per hop)', async () => {
    replies.push({ status: 302, headers: { location: '/v2/items' } });
    lookupSpy
      .mockResolvedValueOnce([{ address: PUBLIC_IP, family: 4 }] as any)
      .mockResolvedValueOnce([{ address: '10.0.0.7', family: 4 }] as any);
    expect(await guardKind(guardedFetch(`${ORIGIN}/v1/items`, { origin: ORIGIN, ...LIMITS }))).toBe('address');
    expect(sent).toHaveLength(1);
  });

  it('stops after 3 redirects, even when asked for more', async () => {
    for (let i = 0; i < 5; i++) replies.push({ status: 302, headers: { location: `/hop${i}` } });
    expect(await guardKind(guardedFetch(`${ORIGIN}/start`, { origin: ORIGIN, maxRedirects: 10, ...LIMITS }))).toBe('redirect');
    expect(sent).toHaveLength(4);
  });

  it('refuses a cross-origin next-page URL (assertSameOrigin and guardedFetch alike)', async () => {
    expect(() => assertSameOrigin('https://cdn.other.example/page2', ORIGIN)).toThrow(FetchGuardError);
    expect(() => assertSameOrigin('https://api.example.com.evil.example/page2', ORIGIN)).toThrow(FetchGuardError);
    expect(() => assertSameOrigin('https://api.example.com:8443/page2', ORIGIN)).toThrow(FetchGuardError);
    expect(assertSameOrigin('/v1/items?page=2', ORIGIN, `${ORIGIN}/v1/items`).toString()).toBe(`${ORIGIN}/v1/items?page=2`);
    expect(await guardKind(guardedFetch('https://cdn.other.example/page2', { origin: ORIGIN, ...LIMITS }))).toBe('origin');
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(requestSpy).not.toHaveBeenCalled();
  });
});

describe('DEF-362 fetch guard — byte cap', () => {
  it('refuses a declared Content-Length over the cap', async () => {
    replies.push({ status: 200, headers: { 'content-length': String(LIMITS.maxBytes + 1) }, body: 'x' });
    expect(await guardKind(guardedFetch(`${ORIGIN}/big`, { origin: ORIGIN, ...LIMITS }))).toBe('size');
  });

  it('refuses a streamed body that grows past the cap (no Content-Length)', async () => {
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    replies.push({ status: 200, chunks: Array.from({ length: 20 }, () => chunk) });
    expect(await guardKind(guardedFetch(`${ORIGIN}/big`, { origin: ORIGIN, ...LIMITS }))).toBe('size');
  });

  it('counts the DECOMPRESSED size (gzip bomb)', async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(4 * 1024 * 1024, 0));
    expect(bomb.length).toBeLessThan(LIMITS.maxBytes);
    replies.push({ status: 200, headers: { 'content-encoding': 'gzip', 'content-length': String(bomb.length) }, body: bomb });
    expect(await guardKind(guardedFetch(`${ORIGIN}/bomb`, { origin: ORIGIN, ...LIMITS }))).toBe('size');
  });

  it('decompresses a normal gzip answer under the cap', async () => {
    const body = zlib.gzipSync(Buffer.from('{"ok":true}'));
    replies.push({ status: 200, headers: { 'content-encoding': 'gzip' }, body });
    const r = await guardedFetch(`${ORIGIN}/ok`, { origin: ORIGIN, ...LIMITS });
    expect(JSON.parse(r.body.toString())).toEqual({ ok: true });
  });

  it('returns non-2xx statuses rather than throwing', async () => {
    replies.push({ status: 401, body: '{"error":"unauthorized"}' });
    const r = await guardedFetch(`${ORIGIN}/x`, { origin: ORIGIN, ...LIMITS });
    expect(r.status).toBe(401);
  });
});
