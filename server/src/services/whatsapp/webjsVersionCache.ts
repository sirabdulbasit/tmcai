import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface WebjsVersionPin {
  version: string;
  sourceUrl: string;
  sha256: string;
  expiresAt: string;
}

export interface PreparedWebjsVersionCache extends WebjsVersionPin {
  cachePath: string;
  webVersionCache: { type: 'local'; path: string; strict: true };
}

const DEFAULT_PIN: WebjsVersionPin = {
  version: '2.3000.1043346688-alpha',
  sourceUrl: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/d71af1f1094ace8354e0a0f0f5e9c32b67988f96/html/2.3000.1043346688-alpha.html',
  sha256: '80a55358cdd081b3e58eb4bf62434b9f8bd9802f569e10c53e48823cd8528fcf',
  expiresAt: '2026-09-17T07:27:10.198Z',
};
const VERSION_RE = /^\d+(?:\.\d+){2,3}(?:-[a-z0-9.-]+)?$/i;
const SHA256_RE = /^[a-f0-9]{64}$/i;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
const preparationFlights = new Map<string, Promise<PreparedWebjsVersionCache>>();

export function resolveWebjsVersionPin(env: NodeJS.ProcessEnv = process.env): WebjsVersionPin {
  const supplied = [
    env.WHATSAPP_WEBJS_WEB_VERSION,
    env.WHATSAPP_WEBJS_WEB_CACHE_URL,
    env.WHATSAPP_WEBJS_WEB_CACHE_SHA256,
    env.WHATSAPP_WEBJS_WEB_CACHE_EXPIRES_AT,
  ];
  const suppliedCount = supplied.filter((value) => Boolean(value?.trim())).length;
  if (suppliedCount !== 0 && suppliedCount !== supplied.length) {
    throw new Error('WhatsApp Web cache rotation requires version, URL, SHA-256, and expiry together');
  }
  const pin = suppliedCount === supplied.length
    ? {
      version: supplied[0]!.trim(),
      sourceUrl: supplied[1]!.trim(),
      sha256: supplied[2]!.trim().toLowerCase(),
      expiresAt: supplied[3]!.trim(),
    }
    : DEFAULT_PIN;
  if (!VERSION_RE.test(pin.version) || pin.version.length > 80) {
    throw new Error('Invalid WhatsApp Web cache version');
  }
  if (!SHA256_RE.test(pin.sha256)) throw new Error('Invalid WhatsApp Web cache SHA-256');
  if (!Number.isFinite(Date.parse(pin.expiresAt))) {
    throw new Error('Invalid WhatsApp Web cache expiry');
  }
  let source: URL;
  try { source = new URL(pin.sourceUrl); }
  catch { throw new Error('Invalid WhatsApp Web cache URL'); }
  if (source.protocol !== 'https:' || source.username || source.password) {
    throw new Error('WhatsApp Web cache URL must be credential-free HTTPS');
  }
  return pin;
}

function digest(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function verifiedFile(filePath: string, expectedSha256: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_HTML_BYTES) return false;
    return digest(fs.readFileSync(filePath)) === expectedSha256;
  } catch {
    return false;
  }
}

async function downloadVerifiedHtml(
  pin: WebjsVersionPin,
  fetchImpl: typeof fetch,
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timer.unref();
  try {
    const response = await fetchImpl(pin.sourceUrl, {
      signal: controller.signal,
      redirect: 'error',
      headers: { accept: 'text/html' },
    });
    if (!response.ok) throw new Error(`archive returned HTTP ${response.status}`);
    const declaredSize = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredSize) && declaredSize > MAX_HTML_BYTES) {
      throw new Error('archive artifact exceeds size limit');
    }
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length <= 0 || content.length > MAX_HTML_BYTES) {
      throw new Error('archive artifact has invalid size');
    }
    if (digest(content) !== pin.sha256) {
      throw new Error('archive artifact failed SHA-256 verification');
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

async function prepare(
  sessionPath: string,
  pin: WebjsVersionPin,
  fetchImpl: typeof fetch,
): Promise<PreparedWebjsVersionCache> {
  if (Date.parse(pin.expiresAt) <= Date.now()) {
    throw new Error('pinned WhatsApp Web cache artifact has expired');
  }
  const cachePath = path.resolve(sessionPath, '.webjs-version-cache');
  const cacheFile = path.join(cachePath, `${pin.version}.html`);
  if (!verifiedFile(cacheFile, pin.sha256)) {
    const content = await downloadVerifiedHtml(pin, fetchImpl);
    fs.mkdirSync(cachePath, { recursive: true, mode: 0o700 });
    fs.chmodSync(cachePath, 0o700);
    const temporary = path.join(cachePath, `.${pin.version}.${process.pid}.${Date.now()}.tmp`);
    try {
      fs.writeFileSync(temporary, content, { mode: 0o600 });
      fs.renameSync(temporary, cacheFile);
      fs.chmodSync(cacheFile, 0o600);
    } finally {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* best effort */ }
    }
  }
  if (!verifiedFile(cacheFile, pin.sha256)) {
    throw new Error('verified WhatsApp Web cache artifact is unavailable');
  }
  return {
    ...pin,
    cachePath,
    webVersionCache: { type: 'local', path: cachePath, strict: true },
  };
}

export function prepareVerifiedWebjsVersionCache(options: {
  sessionPath: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}): Promise<PreparedWebjsVersionCache> {
  const pin = resolveWebjsVersionPin(options.env);
  const cachePath = path.resolve(options.sessionPath, '.webjs-version-cache');
  const key = `${cachePath}:${pin.version}:${pin.sha256}:${pin.expiresAt}:${pin.sourceUrl}`;
  const current = preparationFlights.get(key);
  if (current) return current;
  const flight = prepare(options.sessionPath, pin, options.fetchImpl ?? fetch)
    .finally(() => preparationFlights.delete(key));
  preparationFlights.set(key, flight);
  return flight;
}
