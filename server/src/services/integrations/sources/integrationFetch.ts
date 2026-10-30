/**
 * DEF-362 — Integrations Stage 1b: the REST fetch guard. THE only way an
 * integration reaches an outside API (spec INTEGRATIONS_DESIGN.md §2b
 * "REST fetch guard").
 *
 * Why every rule exists — the URL is assembled from two sources that are NOT
 * trustworthy: a connection an LLM drafted from an uploaded document, and the
 * outside system's own responses (redirects, next-page links). Each request
 * carries the tenant's decrypted credential. So:
 *   - https only — the credential never crosses the wire in clear;
 *   - the host is resolved ONCE and EVERY address is vetted: private, loopback,
 *     link-local (incl. cloud metadata 169.254.169.254), CGNAT, multicast,
 *     reserved and IPv6 unique-local are refused. One bad A record among good
 *     ones refuses the whole host (an attacker controls the record set);
 *   - the socket is PINNED to the vetted address through the agent's lookup,
 *     so a second DNS answer (rebinding) can never redirect the connection;
 *   - redirects are followed by hand (≤ 3), each hop re-validated: https,
 *     same origin, re-resolved and re-vetted;
 *   - next-page URLs go through assertSameOrigin (vm integrationSyncEngine
 *     assertSameOrigin: "a mapping may only read from the address you set up");
 *   - one deadline across all hops and a byte cap counted AFTER decompression
 *     (a gzip bomb is caught by what it expands to, not what it ships as);
 *   - the credential is attached only when the hop's origin is the configured
 *     origin, and never appears in an error message or the returned finalUrl.
 *
 * DEF-365: the vendored @tmc/ai-integration assertSafeOutboundUrl is composed
 * in as a FIRST check on every hop (loopback refused, as here) — it can only
 * refuse more (credentials in the URL, encoded metadata/link-local hosts); the
 * DNS vetting and socket pinning above remain the deciding guard. The
 * framework's applyOutboundNetworkPolicy is NOT called: it rewrites
 * process-wide http/https/dns defaults for every Nexeo subsystem.
 *
 * Model-free and tenant-free by construction: it fetches what it is told,
 * within the rules, and nothing else.
 */
import dns from 'dns';
import https from 'https';
import net from 'net';
import zlib from 'zlib';
import type { IncomingMessage } from 'http';
import type { LookupFunction } from 'net';
import createLogger from '../../../utils/logger';
import { assertSafeOutboundUrl } from '../../../vendor/ai-integration/net/outboundUrl';
import { getBehaviorValue } from '../../behaviorConfig';
import {
  FetchGuardError,
  type AuthAttachment,
  type GuardedFetchOptions,
  type GuardedResponse,
  type IntegrationFetchModule,
} from '../types';

const log = createLogger('integrations-fetch');

/** Spec §2b: ≤ 3 redirects. A caller may ask for fewer, never more. */
export const MAX_REDIRECTS = 3;

// ── Address vetting ───────────────────────────────────────────────────────

const FORBIDDEN = new net.BlockList();
// IPv4 — "this network", private, CGNAT, loopback, link-local (metadata),
// IETF protocol assignments, documentation, benchmarking, multicast, reserved
// (which includes the broadcast address).
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as Array<[string, number]>) FORBIDDEN.addSubnet(a, p, 'ipv4');
// IPv6 — unspecified/loopback/IPv4-compatible (::/96), unique-local (fc00::/7,
// covers fd00::/8), link-local, site-local, multicast, documentation. NAT64
// (64:ff9b::/96) and 6to4 (2002::/16) embed an IPv4 address that could be a
// private one; this host has no IPv6 route anyway (vm config/network.ts), so
// no legitimate API is reached through them — refuse the prefixes outright.
// IPv4-mapped (::ffff:a.b.c.d) is matched by BlockList against the v4 rules.
for (const [a, p] of [
  ['::', 96], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  ['2001:db8::', 32], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16],
] as Array<[string, number]>) FORBIDDEN.addSubnet(a, p, 'ipv6');

/** True when connecting to this address is refused. Exported for tests. */
export function isForbiddenAddress(address: string): boolean {
  const fam = net.isIP(address);
  if (fam === 4) return FORBIDDEN.check(address, 'ipv4');
  if (fam === 6) return FORBIDDEN.check(address.toLowerCase().split('%')[0], 'ipv6');
  return true; // not an IP at all: refuse, never guess
}

interface Vetted { address: string; family: 4 | 6 }

/** Resolve once, vet EVERY address, return the one the socket is pinned to. */
async function resolveVetted(hostname: string, deadline: number): Promise<Vetted> {
  const host = hostname.replace(/^\[|\]$/g, '');
  let addrs: Array<{ address: string; family: number }>;
  if (net.isIP(host)) {
    addrs = [{ address: host, family: net.isIP(host) }];
  } else {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new FetchGuardError('timeout', `The API at ${host} did not answer in time.`);
    let timer: NodeJS.Timeout | undefined;
    try {
      addrs = await Promise.race([
        dns.promises.lookup(host, { all: true, verbatim: true }),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new FetchGuardError('timeout', `Looking up ${host} took too long.`)), remaining);
        }),
      ]);
    } catch (err) {
      if (err instanceof FetchGuardError) throw err;
      throw new FetchGuardError('dns', `The address ${host} could not be found.`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  if (!addrs.length) throw new FetchGuardError('dns', `The address ${host} could not be found.`);
  for (const a of addrs) {
    if (isForbiddenAddress(a.address)) {
      log.warn('integration fetch refused: forbidden address', { host, address: a.address });
      throw new FetchGuardError('address',
        `${host} points to a private or internal network address. An integration may only reach a public API.`);
    }
  }
  const first = addrs[0];
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

/** An agent whose lookup always answers the vetted address — the socket can
 *  connect nowhere else, whatever DNS says a millisecond later. */
function pinnedAgent(v: Vetted): https.Agent {
  const lookup: LookupFunction = (_hostname, options, cb) => {
    // Node 20 asks with {all:true} when autoSelectFamily is on; answer both forms.
    const cbAny = cb as unknown as (...args: unknown[]) => void;
    if (options && (options as { all?: boolean }).all) cbAny(null, [{ address: v.address, family: v.family }]);
    else cbAny(null, v.address, v.family);
  };
  return new https.Agent({ keepAlive: false, lookup });
}

// ── Origin rules (vm assertSameOrigin) ────────────────────────────────────

function normaliseOrigin(origin: string): string {
  let u: URL;
  try { u = new URL(origin); } catch {
    throw new FetchGuardError('origin', 'This integration has no valid web address.');
  }
  if (u.protocol !== 'https:') {
    throw new FetchGuardError('scheme', 'The API address must start with https:// — the credential is never sent unencrypted.');
  }
  return u.origin;
}

/** For messages: never the query string (an API_KEY may ride there). */
const describe = (u: URL): string => `${u.origin}${u.pathname}`;

export const assertSameOrigin: IntegrationFetchModule['assertSameOrigin'] = (candidate, origin, base) => {
  const want = normaliseOrigin(origin);
  let u: URL;
  try {
    u = candidate instanceof URL ? new URL(candidate.toString()) : new URL(String(candidate), base);
  } catch {
    throw new FetchGuardError('origin', 'The API gave an address that is not a valid web address.');
  }
  if (u.protocol !== 'https:') {
    throw new FetchGuardError('scheme', `Refusing ${u.protocol.replace(':', '')}:// — only https is allowed.`);
  }
  if (u.origin !== want) {
    throw new FetchGuardError('origin',
      `Refusing to call ${u.origin} — this integration is configured for ${want}. `
      + 'An integration may only read from the address you set up.');
  }
  return u;
};

export const buildAuth: IntegrationFetchModule['buildAuth'] = (cfg, secret) => {
  const out: AuthAttachment = { headers: {}, query: [] };
  if (!secret || cfg.authScheme === 'NONE') return out;
  switch (cfg.authScheme) {
    case 'BEARER':
      out.headers.authorization = `Bearer ${secret}`;
      break;
    case 'BASIC':
      out.headers.authorization = `Basic ${Buffer.from(secret, 'utf8').toString('base64')}`;
      break;
    case 'API_KEY':
      if (cfg.authQueryParam) out.query.push({ name: cfg.authQueryParam, value: secret });
      else out.headers[(cfg.authHeaderName || 'X-API-Key').toLowerCase()] = secret;
      break;
  }
  return out;
};

export const fetchLimits: IntegrationFetchModule['fetchLimits'] = async (cn) => {
  const ctx = { clientNumber: cn };
  const [maxBytes, timeoutMs, maxPages] = await Promise.all([
    getBehaviorValue('integrations.api_max_bytes', ctx),
    getBehaviorValue('integrations.api_timeout_ms', ctx),
    getBehaviorValue('integrations.api_max_pages', ctx),
  ]);
  return { maxBytes, timeoutMs, maxPages };
};

// ── One hop ───────────────────────────────────────────────────────────────

interface HopResult { res: IncomingMessage; req: ReturnType<typeof https.request> }

function sendHop(
  u: URL, v: Vetted, method: string, headers: Record<string, string>, body: string | undefined, deadline: number,
): Promise<HopResult> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) { reject(new FetchGuardError('timeout', `The API at ${u.origin} did not answer in time.`)); return; }
    const host = u.hostname.replace(/^\[|\]$/g, '');
    let req: ReturnType<typeof https.request>;
    try {
      req = https.request({
        protocol: 'https:',
        hostname: host,
        port: u.port ? Number(u.port) : 443,
        path: `${u.pathname}${u.search}`,
        method,
        headers,
        agent: pinnedAgent(v),
        // SNI + certificate check against the NAME, while the socket goes to the pinned IP.
        ...(net.isIP(host) ? {} : { servername: host }),
      });
    } catch {
      reject(new FetchGuardError('network', 'The request could not be built (check the header and parameter names).'));
      return;
    }
    const timer = setTimeout(() => {
      req.destroy(new FetchGuardError('timeout', `The API at ${u.origin} did not answer in time.`));
    }, remaining);
    req.on('response', (res) => { clearTimeout(timer); resolve({ res, req }); });
    req.on('error', (err) => {
      clearTimeout(timer);
      if (err instanceof FetchGuardError) reject(err);
      else reject(new FetchGuardError('network', `Could not reach ${u.origin}: ${(err as NodeJS.ErrnoException).code || 'connection failed'}.`));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Read the body, decompressing, refusing past maxBytes (counted decoded). */
function readCapped(res: IncomingMessage, req: HopResult['req'], maxBytes: number, deadline: number, where: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(res.headers['content-length'] ?? NaN);
    const enc = String(res.headers['content-encoding'] ?? '').toLowerCase().trim();
    if (Number.isFinite(declared) && declared > maxBytes && (!enc || enc === 'identity')) {
      req.destroy();
      reject(new FetchGuardError('size', `The answer from ${where} is larger than the ${maxBytes} byte limit.`));
      return;
    }
    let stream: NodeJS.ReadableStream = res;
    if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
    else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
    else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());

    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const fail = (e: FetchGuardError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      reject(e);
    };
    const timer = setTimeout(() => fail(new FetchGuardError('timeout', `The API at ${where} did not finish answering in time.`)),
      Math.max(0, deadline - Date.now()));
    stream.on('data', (c: Buffer) => {
      total += c.length;
      if (total > maxBytes) { fail(new FetchGuardError('size', `The answer from ${where} is larger than the ${maxBytes} byte limit.`)); return; }
      chunks.push(c);
    });
    stream.on('end', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    stream.on('error', () => fail(new FetchGuardError('network', `The answer from ${where} could not be read.`)));
  });
}

const lowerHeaders = (h: IncomingMessage['headers']): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
  return out;
};

// ── The guard ─────────────────────────────────────────────────────────────

/** The framework's URL rule, in this guard's error type (never echoes the query). */
export function assertFrameworkSafe(u: URL): void {
  try {
    assertSafeOutboundUrl(u.toString(), { allowLoopback: false });
  } catch {
    throw new FetchGuardError('address', `Refusing to call ${describe(u)} — that address is not allowed.`);
  }
}

export const guardedFetch: IntegrationFetchModule['guardedFetch'] = async (url, opts: GuardedFetchOptions) => {
  const origin = normaliseOrigin(opts.origin);
  const deadline = Date.now() + Math.max(1, opts.timeoutMs);
  const maxRedirects = Math.max(0, Math.min(opts.maxRedirects ?? MAX_REDIRECTS, MAX_REDIRECTS));
  const authQueryNames = new Set((opts.auth?.query ?? []).map((q) => q.name));

  let current = assertSameOrigin(url, origin);
  let method: string = opts.method ?? 'GET';
  let body = opts.body;
  let redirects = 0;

  for (;;) {
    // Re-validated every hop: the redirect target is the outside system's choice.
    current = assertSameOrigin(current, origin);
    assertFrameworkSafe(current);
    const vetted = await resolveVetted(current.hostname, deadline);

    const target = new URL(current.toString());
    const headers: Record<string, string> = {
      accept: 'application/json',
      'accept-encoding': 'gzip, deflate, br',
      'user-agent': 'Nexeo-Integrations/1',
    };
    for (const [k, v] of Object.entries(opts.headers ?? {})) {
      const key = k.toLowerCase();
      if (key === 'host' || key === 'content-length') continue; // never let config steer routing/framing
      headers[key] = v;
    }
    // The credential rides ONLY to the configured origin (spec §2b).
    if (opts.auth && target.origin === origin) {
      for (const [k, v] of Object.entries(opts.auth.headers)) headers[k.toLowerCase()] = v;
      for (const q of opts.auth.query) target.searchParams.set(q.name, q.value);
    }
    if (body !== undefined) {
      headers['content-length'] = String(Buffer.byteLength(body));
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    }

    const { res, req } = await sendHop(target, vetted, method, headers, body, deadline);
    const status = res.statusCode ?? 0;

    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      req.destroy();
      if (redirects >= maxRedirects) {
        throw new FetchGuardError('redirect', `The API at ${describe(current)} redirected more than ${maxRedirects} times.`);
      }
      // Throws on a cross-origin or non-https hop, before anything is sent there.
      let next: URL;
      try {
        next = assertSameOrigin(String(res.headers.location), origin, current.toString());
      } catch (err) {
        const msg = err instanceof FetchGuardError ? err.message : 'invalid redirect';
        throw new FetchGuardError('redirect', `The API redirected away from the address you set up. ${msg}`);
      }
      redirects++;
      if (status === 303 || ((status === 301 || status === 302) && method !== 'GET')) {
        method = 'GET';
        body = undefined;
      }
      current = next;
      continue;
    }

    const buf = await readCapped(res, req, opts.maxBytes, deadline, describe(current));
    const finalUrl = new URL(target.toString());
    for (const name of authQueryNames) finalUrl.searchParams.delete(name);
    return {
      status,
      headers: lowerHeaders(res.headers),
      body: buf,
      finalUrl: finalUrl.toString(),
      redirects,
    } satisfies GuardedResponse;
  }
};
