/**
 * DEF-362 — Integrations Stage 1b: read a REST API as records.
 *
 * Spec INTEGRATIONS_DESIGN.md §2b (Connect, REST fetch guard). Ported from vm
 * integrationSyncService.fetchRecordsWithMeta (records path, paging, declared
 * total) and integrationSyncEngine (same-origin next pages), with every
 * request going through sources/integrationFetch.guardedFetch — the ONLY way
 * an integration reaches an outside system.
 *
 * Why each rule:
 *  - The secret is loaded here (secretStore, tenant-scoped) and handed to
 *    guardedFetch as an AuthAttachment (buildAuth). This module never puts it
 *    in a URL, a header it builds itself, a log line or an error message —
 *    guardedFetch attaches it, and only to the configured origin.
 *  - Records are FLATTENED to dotted string cells (flattenRecord), so the
 *    field inventory, planner, filter and context writer see exactly the shape
 *    a sheet gives them (ReadResult) and never learn a second record form.
 *  - Paging is bounded by min(pagination.maxPages, integrations.api_max_pages)
 *    and by integrations.max_rows and a cumulative byte budget: a runaway
 *    cursor on a box shared by every tenant stops and is reported TRUNCATED
 *    (the run is PARTIAL), never as a complete read.
 *  - The system's own declared total is compared with what arrived: "read 900
 *    of a declared 1,156" is truncated, not success (vm fetchRecordsWithMeta).
 *  - A next-page URL on another origin FAILS the read (vm assertSameOrigin);
 *    it is never followed with the secret attached.
 *  - testApi makes ONE request and shows exactly ONE record; a 200 with no
 *    records is NOT ok (spec §2b Connect, same rule as the sheet test §2.2).
 *
 * Deterministic and model-free: this runs on the execution path (spec §3
 * "no model on the execution path").
 */
import createLogger from '../../../utils/logger';
import { getBehaviorValue } from '../../behaviorConfig';
import { getSecret } from '../store/secretStore';
import { assertSameOrigin, buildAuth, fetchLimits, guardedFetch } from './integrationFetch';
import {
  API_METHODS,
  AUTH_SCHEMES,
  CredentialUnreadableError,
  FetchGuardError,
  type ApiConfig,
  type ApiReaderModule,
  type ApiSourceRef,
  type AuthAttachment,
  type FetchLimits,
  type Pagination,
  type ReadResult,
  type TestResult,
} from '../types';

const log = createLogger('integrations-api');

/** Nesting kept as dotted keys; anything deeper is one JSON cell (types.ts
 *  ApiReaderModule.flattenRecord, brief: "depth 3"). */
export const FLATTEN_MAX_DEPTH = 3;

/** A read that could not produce records, in words the admin can act on.
 *  The run engine records `message` as the run error; testApi as `reason`. */
export class ApiReadError extends Error {
  readonly code = 'API_READ';
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiReadError';
  }
}

// ── Config (the stored JSON is re-checked on every read) ──────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const posInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined;
const nonNegInt = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined;
const nonEmpty = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function readPagination(raw: unknown): Pagination | null {
  if (raw === undefined || raw === null) return { kind: 'none' };
  if (!isObj(raw)) return null;
  const maxPages = posInt(raw.maxPages);
  const mp = maxPages ? { maxPages } : {};
  switch (raw.kind) {
    case 'none': return { kind: 'none' };
    case 'page': {
      const pageParam = nonEmpty(raw.pageParam);
      if (!pageParam) return null;
      const pageSizeParam = nonEmpty(raw.pageSizeParam);
      const pageSize = posInt(raw.pageSize);
      const startPage = nonNegInt(raw.startPage);
      return {
        kind: 'page', pageParam,
        ...(pageSizeParam ? { pageSizeParam } : {}),
        ...(pageSize ? { pageSize } : {}),
        ...(startPage !== undefined ? { startPage } : {}),
        ...mp,
      };
    }
    case 'offset': {
      const offsetParam = nonEmpty(raw.offsetParam);
      const pageSize = posInt(raw.pageSize);
      if (!offsetParam || !pageSize) return null;
      const limitParam = nonEmpty(raw.limitParam);
      return { kind: 'offset', offsetParam, pageSize, ...(limitParam ? { limitParam } : {}), ...mp };
    }
    case 'next_url': {
      const nextUrlPath = nonEmpty(raw.nextUrlPath);
      if (!nextUrlPath) return null;
      return { kind: 'next_url', nextUrlPath, ...mp };
    }
    default: return null;
  }
}

/**
 * The stored api_config as an ApiConfig, or null when it is not one a reader
 * can use (no https base URL, unknown scheme/method, broken paging). The store
 * validates on write; this re-check exists because the JSON column outlives
 * the code that wrote it, and a reader must never guess at a half-config.
 */
export function readApiConfig(raw: unknown): ApiConfig | null {
  if (!isObj(raw)) return null;
  const baseUrl = nonEmpty(raw.baseUrl);
  if (!baseUrl) return null;
  try {
    if (new URL(baseUrl).protocol !== 'https:') return null;
  } catch { return null; }
  const method = raw.method ?? 'GET';
  if (!(API_METHODS as readonly unknown[]).includes(method)) return null;
  const authScheme = raw.authScheme ?? 'NONE';
  if (!(AUTH_SCHEMES as readonly unknown[]).includes(authScheme)) return null;
  const pagination = readPagination(raw.pagination);
  if (!pagination) return null;
  const query: Record<string, string> = {};
  if (raw.query !== undefined && raw.query !== null) {
    if (!isObj(raw.query)) return null;
    for (const [k, v] of Object.entries(raw.query)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') query[k] = String(v);
    }
  }
  return {
    baseUrl,
    method: method as ApiConfig['method'],
    path: typeof raw.path === 'string' ? raw.path.trim() : '',
    query,
    body: isObj(raw.body) ? raw.body : null,
    authScheme: authScheme as ApiConfig['authScheme'],
    authHeaderName: nonEmpty(raw.authHeaderName),
    authQueryParam: nonEmpty(raw.authQueryParam),
    recordsPath: typeof raw.recordsPath === 'string' ? raw.recordsPath.trim() : '',
    idField: nonEmpty(raw.idField),
    pagination,
    declaredTotalPath: nonEmpty(raw.declaredTotalPath),
  };
}

// ── Pure helpers ──────────────────────────────────────────────────────────

/** Dotted lookup ('data.items', 'meta.0.total'); '' = the value itself. */
export function lookupPath(value: unknown, path: string | null | undefined): unknown {
  const p = (path ?? '').trim();
  if (!p) return value;
  let cur: unknown = value;
  for (const seg of p.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined;
      cur = cur[Number(seg)];
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

const scalarText = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return JSON.stringify(v);
};
const isScalar = (v: unknown): boolean => v === null || v === undefined || typeof v !== 'object';

export const flattenRecord: ApiReaderModule['flattenRecord'] = (rec) => {
  const out: Record<string, string> = {};
  // A bare scalar in the records array is still one record with one field.
  if (!isObj(rec)) {
    out.value = Array.isArray(rec) ? JSON.stringify(rec) : scalarText(rec);
    return out;
  }
  const walk = (obj: Record<string, unknown>, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (Array.isArray(v)) {
        // Scalars joined (readable in a sample and a Context page); anything
        // nested stays JSON — never silently dropped.
        out[key] = v.every(isScalar) ? v.map(scalarText).filter((s) => s !== '').join(', ') : JSON.stringify(v);
      } else if (isObj(v)) {
        if (depth < FLATTEN_MAX_DEPTH) walk(v, key, depth + 1);
        else out[key] = JSON.stringify(v);
      } else {
        out[key] = scalarText(v);
      }
    }
  };
  walk(rec, '', 1);
  return out;
};

/** A number the system declared (number or numeric string), else null. */
function declaredNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return Math.floor(v);
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return parseInt(v, 10);
  return null;
}

/** Where arrays live in a body — said to the admin when recordsPath misses. */
function arrayPaths(body: unknown, prefix = '', depth = 0, out: string[] = []): string[] {
  if (out.length >= 5 || depth > 3) return out;
  if (Array.isArray(body)) { out.push(prefix || '(the whole answer)'); return out; }
  if (isObj(body)) {
    for (const [k, v] of Object.entries(body)) arrayPaths(v, prefix ? `${prefix}.${k}` : k, depth + 1, out);
  }
  return out;
}

/** The endpoint URL: path joined to baseUrl, or a full same-origin URL. */
export function endpointUrl(cfg: ApiConfig): URL {
  const base = new URL(cfg.baseUrl);
  const path = cfg.path.trim();
  let u: URL;
  if (/^https?:\/\//i.test(path)) {
    u = assertSameOrigin(path, base.origin);
  } else {
    u = new URL(base.toString());
    if (path) {
      const [p, q] = path.split('?', 2);
      u.pathname = `${base.pathname.replace(/\/+$/, '')}/${p.replace(/^\/+/, '')}`;
      if (q) for (const [k, v] of new URLSearchParams(q)) u.searchParams.set(k, v);
    }
    u = assertSameOrigin(u, base.origin);
  }
  for (const [k, v] of Object.entries(cfg.query ?? {})) u.searchParams.set(k, v);
  return u;
}

/** For labels and messages: never the query string (an API_KEY may ride there). */
const describeUrl = (u: URL): string => `${u.host}${u.pathname}`;

// ── One page ──────────────────────────────────────────────────────────────

interface PageResult {
  records: unknown[];
  body: unknown;
  bytes: number;
  finalUrl: string;
}

function statusMessage(status: number, where: string): string {
  if (status === 401 || status === 403) {
    return `The API at ${where} refused the request (${status}) — the credential is missing, wrong or lacks permission.`;
  }
  if (status === 404) return `The API at ${where} answered 404 — the endpoint path was not found. Check the path.`;
  if (status === 429) return `The API at ${where} answered 429 — too many requests. Try again later.`;
  if (status >= 500) return `The API at ${where} had an internal error (${status}). Try again later.`;
  return `The API at ${where} answered ${status}.`;
}

/** Strip the secret (and anything credential-shaped) from text the outside
 *  system sent back before it can reach an admin's screen or a log. */
function scrub(text: string, secret: string | null, cfg?: Pick<ApiConfig, 'authQueryParam'>): string {
  let t = text;
  if (secret) {
    // DEF-362 review: an API that echoes the request URL echoes the secret in
    // its WIRE form, not the raw one — searchParams.set form-encodes it
    // ('+' ⇒ %2B, '/' ⇒ %2F, '=' ⇒ %3D), and BASIC rides base64-encoded. Every
    // form the reader itself put on the wire is removed, longest first.
    const forms = new Set<string>([
      secret,
      encodeURIComponent(secret),
      new URLSearchParams({ k: secret }).toString().slice(2),
      Buffer.from(secret, 'utf8').toString('base64'),
    ]);
    for (const f of [...forms].filter((x) => x.length >= 4).sort((a, b) => b.length - a.length)) {
      t = t.split(f).join('[redacted]');
    }
  }
  // Whatever value the credential parameter carries — echoed in a form not
  // listed above (double-encoded, lower-case hex) — goes too.
  const qp = cfg?.authQueryParam?.trim();
  if (qp) {
    const esc = qp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    t = t.replace(new RegExp(`([?&;"'\\s]${esc}=)[^&\\s"'#<>]+`, 'g'), '$1[redacted]');
  }
  return t.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]');
}

/** Test hook (DEF-362 review): the error-snippet scrub, as fetchPage applies it. */
export const __scrubForTests = scrub;

async function fetchPage(
  url: URL, cfg: ApiConfig, auth: AuthAttachment, secret: string | null, limits: FetchLimits,
): Promise<PageResult> {
  const origin = new URL(cfg.baseUrl).origin;
  const body = cfg.method === 'POST' ? JSON.stringify(cfg.body ?? {}) : undefined;
  const res = await guardedFetch(url, {
    origin,
    method: cfg.method,
    auth,
    maxBytes: limits.maxBytes,
    timeoutMs: limits.timeoutMs,
    ...(body !== undefined ? { body, headers: { 'content-type': 'application/json' } } : {}),
  });
  const where = describeUrl(url);
  if (res.status < 200 || res.status >= 300) {
    const snippet = scrub(res.body.toString('utf8', 0, Math.min(res.body.length, 300)), secret, cfg)
      .replace(/\s+/g, ' ').trim();
    throw new ApiReadError(`${statusMessage(res.status, where)}${snippet ? ` It said: "${snippet.slice(0, 200)}"` : ''}`, res.status);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(res.body.toString('utf8'));
  } catch {
    const ct = res.headers['content-type'] ?? 'unknown type';
    throw new ApiReadError(`The API at ${where} did not answer with JSON (it sent ${ct}). Check the endpoint path.`, res.status);
  }
  const at = lookupPath(parsed, cfg.recordsPath);
  if (!Array.isArray(at)) {
    const found = arrayPaths(parsed);
    const label = cfg.recordsPath ? `"${cfg.recordsPath}"` : 'the top of the answer';
    throw new ApiReadError(
      `No list of records was found at ${label} in the answer from ${where}.`
      + (found.length ? ` Lists were found at: ${found.join(', ')} — set the records path to one of them.` : ''),
      res.status,
    );
  }
  return { records: at, body: parsed, bytes: res.body.length, finalUrl: res.finalUrl };
}

// ── Secret ────────────────────────────────────────────────────────────────

/** The stored secret, or null for NONE. A scheme that needs one and has none
 *  is refused HERE — a request is never sent without the credential the
 *  config says it needs (it would only teach the admin a misleading 401). */
async function loadSecret(cn: string, integ: ApiSourceRef): Promise<string | null> {
  if (integ.apiConfig.authScheme === 'NONE') return null;
  const secret = await getSecret(cn, integ.id);
  if (!secret) {
    throw new CredentialUnreadableError(`This API uses ${integ.apiConfig.authScheme} sign-in but no credential has been entered. Enter it in the Connect step.`);
  }
  return secret;
}

// ── test / read ───────────────────────────────────────────────────────────

/** First-page URL for the configured paging (the test and the read agree). */
function firstPageUrl(cfg: ApiConfig): URL {
  const u = endpointUrl(cfg);
  const p = cfg.pagination;
  if (p.kind === 'page') {
    u.searchParams.set(p.pageParam, String(p.startPage ?? 1));
    if (p.pageSizeParam && p.pageSize) u.searchParams.set(p.pageSizeParam, String(p.pageSize));
  } else if (p.kind === 'offset') {
    u.searchParams.set(p.offsetParam, '0');
    if (p.limitParam) u.searchParams.set(p.limitParam, String(p.pageSize));
  }
  return u;
}

const adminReason = (err: unknown): string => {
  if (err instanceof ApiReadError || err instanceof FetchGuardError || err instanceof CredentialUnreadableError) return err.message;
  return 'The API could not be read (unexpected error). Try again in a few minutes.';
};

/**
 * ONE real request with a CANDIDATE secret — what secretStore.setSecret's
 * testFirst calls, so a credential is proven before it replaces a working one.
 * Never throws for a bad connection.
 */
export async function testApiWith(cn: string, cfg: ApiConfig, secret: string | null): Promise<TestResult> {
  try {
    if (cfg.authScheme !== 'NONE' && !secret) {
      return { ok: false, rows: 0, columns: [], sampleRow: null, reason: `This API uses ${cfg.authScheme} sign-in — enter the credential first.` };
    }
    const limits = await fetchLimits(cn);
    const url = firstPageUrl(cfg);
    const page = await fetchPage(url, cfg, buildAuth(cfg, secret), secret, limits);
    const declaredTotal = cfg.declaredTotalPath ? declaredNumber(lookupPath(page.body, cfg.declaredTotalPath)) : null;
    if (page.records.length === 0) {
      return {
        ok: false, rows: 0, columns: [], sampleRow: null, pageRecords: 0, declaredTotal,
        reason: `The API answered, but the list at ${cfg.recordsPath ? `"${cfg.recordsPath}"` : 'the top of the answer'} is empty — `
          + 'there is nothing to map. Check the endpoint, its parameters, or the records path.',
      };
    }
    // Exactly ONE record is shown (spec §2b Connect).
    const sampleRow = flattenRecord(page.records[0]);
    return {
      ok: true,
      rows: page.records.length,
      columns: Object.keys(sampleRow),
      sampleRow,
      pageRecords: page.records.length,
      declaredTotal,
    } satisfies TestResult;
  } catch (err) {
    const reason = adminReason(err);
    log.warn('api test failed', { clientNumber: cn, host: safeHost(cfg.baseUrl), reason });
    return { ok: false, rows: 0, columns: [], sampleRow: null, reason };
  }
}

const safeHost = (u: string): string => { try { return new URL(u).host; } catch { return '?'; } };

export const testApi: ApiReaderModule['testApi'] = async (cn, integ) => {
  let secret: string | null;
  try {
    secret = await loadSecret(cn, integ);
  } catch (err) {
    return { ok: false, rows: 0, columns: [], sampleRow: null, reason: adminReason(err) };
  }
  return testApiWith(cn, integ.apiConfig, secret);
};

/** Stable text of a page, to notice an API that ignores the page parameter. */
const pageSignature = (records: unknown[]): string => {
  try { return JSON.stringify(records); } catch { return String(records.length); }
};

export const readApi: ApiReaderModule['readApi'] = async (cn, integ) => {
  const cfg = integ.apiConfig;
  const secret = await loadSecret(cn, integ);
  const auth = buildAuth(cfg, secret);
  const [limits, maxRows] = await Promise.all([
    fetchLimits(cn),
    getBehaviorValue('integrations.max_rows', { clientNumber: cn }),
  ]);
  const p = cfg.pagination;
  // A per-integration ceiling may only LOWER the behaviour cap (types.ts Pagination).
  const maxPages = p.kind === 'none' ? 1 : Math.min(p.maxPages ?? limits.maxPages, limits.maxPages);
  const origin = new URL(cfg.baseUrl).origin;

  const raw: unknown[] = [];
  const anomalies: string[] = [];
  let truncatedReason: string | null = null;
  let declaredTotal: number | null = null;
  let pagesRead = 0;
  let bytesRead = 0;
  let url: URL | null = firstPageUrl(cfg);
  let lastSig: string | null = null;
  let finished = false; // the source said "no more" (empty / short page / no next link)
  const seenUrls = new Set<string>();

  while (url && pagesRead < maxPages) {
    // Checked before asking for ANOTHER page, so a short last page that tips
    // the budget is still a complete read. Every page held at once is memory
    // every tenant on this box shares.
    if (pagesRead > 0 && bytesRead >= limits.maxBytes) {
      truncatedReason = `The answers added up to more than ${Math.round(limits.maxBytes / (1024 * 1024))} MB; reading stopped after page ${pagesRead}.`;
      break;
    }
    seenUrls.add(url.toString());
    const page = await fetchPage(url, cfg, auth, secret, limits);
    pagesRead++;
    bytesRead += page.bytes;
    if (pagesRead === 1 && cfg.declaredTotalPath) {
      declaredTotal = declaredNumber(lookupPath(page.body, cfg.declaredTotalPath));
      if (declaredTotal === null) anomalies.push(`The total at "${cfg.declaredTotalPath}" was not a number, so completeness could not be checked.`);
    }
    if (page.records.length === 0) { finished = true; break; }

    const sig = pageSignature(page.records);
    if (pagesRead > 1 && sig === lastSig) {
      // Same page twice: the API ignores the paging parameter. Keeping the
      // repeat would double every count; stopping is the only honest move.
      anomalies.push(`Page ${pagesRead} was identical to page ${pagesRead - 1} — the API seems to ignore the paging parameter; reading stopped.`);
      finished = true;
      break;
    }
    lastSig = sig;
    raw.push(...page.records);

    if (raw.length > maxRows) {
      raw.length = maxRows;
      truncatedReason = `Only the first ${maxRows} records were read (the row limit).`;
      break;
    }

    // The next page.
    if (p.kind === 'none') { finished = true; break; }
    if (p.kind === 'page') {
      if (p.pageSize && page.records.length < p.pageSize) { finished = true; break; }
      const next: URL = new URL(url.toString());
      next.searchParams.set(p.pageParam, String((p.startPage ?? 1) + pagesRead));
      url = next;
    } else if (p.kind === 'offset') {
      if (page.records.length < p.pageSize) { finished = true; break; }
      const next: URL = new URL(url.toString());
      next.searchParams.set(p.offsetParam, String(pagesRead * p.pageSize));
      url = next;
    } else {
      const link = lookupPath(page.body, p.nextUrlPath);
      if (typeof link !== 'string' || !link.trim()) { finished = true; break; }
      // Cross-origin ⇒ FetchGuardError('origin') ⇒ the read FAILS. The admin's
      // secret is never sent to an address the API chose.
      const next = assertSameOrigin(link.trim(), origin, page.finalUrl || url.toString());
      if (seenUrls.has(next.toString())) {
        anomalies.push('The API pointed back to a page already read — reading stopped.');
        finished = true;
        break;
      }
      url = next;
    }
  }
  if (!finished && !truncatedReason && pagesRead >= maxPages && p.kind !== 'none') {
    truncatedReason = `Reading stopped after ${maxPages} pages (the page limit); there may be more records.`;
  }
  if (declaredTotal !== null) {
    if (raw.length < declaredTotal) {
      const msg = `Read ${raw.length} of a declared ${declaredTotal} records.`;
      truncatedReason = truncatedReason ? `${truncatedReason} ${msg}` : msg;
    } else if (raw.length > declaredTotal) {
      anomalies.push(`Read ${raw.length} records but the API declared ${declaredTotal}.`);
    }
  }

  // Flatten, then give every record every header ('' never undefined) so blank
  // detection is uniform with a sheet (ReadResult.records).
  const flat = raw.map((r) => flattenRecord(r));
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const r of flat) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); headers.push(k); }
  const records = flat.map((r) => {
    const full: Record<string, string> = {};
    for (const h of headers) full[h] = r[h] ?? '';
    return full;
  });

  const ep = endpointUrl(cfg);
  log.info('api read', {
    clientNumber: cn, integrationId: integ.id, host: ep.host, pages: pagesRead,
    records: records.length, bytes: bytesRead, truncated: !!truncatedReason, declaredTotal,
  });
  return {
    records,
    headers,
    rowCount: records.length,
    truncated: !!truncatedReason,
    ...(truncatedReason ? { truncatedReason } : {}),
    anomalies,
    sourceLabel: describeUrl(ep),
    declaredTotal,
    pagesRead,
  } satisfies ReadResult;
};

export const apiReader: ApiReaderModule = { testApi, readApi, flattenRecord };
