/**
 * Guard for every server-side fetch of an administrator- or AI-supplied URL.
 *
 * Blocks non-http(s) schemes, cloud-metadata hosts, link-local addresses
 * (including the encoded forms that a hostname regex misses), and credentials
 * in the userinfo component. Loopback is allowed by default — the BI tool bridge
 * is bound on 127.0.0.1:3000 by design.
 *
 * Callers MUST pass `redirect: 'error'` (or `'manual'`) to fetch so a 302
 * cannot bounce the request (and any attached secret) onto a blocked host.
 */

export const SAFE_FETCH_REDIRECT: RequestRedirect = 'error';

const METADATA_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.goog',
  '169.254.169.254',
]);

const ipv4FromHost = (host: string): number | null => {
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) return null;
    return n >>> 0;
  }
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const n = parseInt(host, 16);
    if (!Number.isFinite(n) || n < 0 || n > 0xffffffff) return null;
    return n >>> 0;
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const oct = m.slice(1).map(Number);
  if (oct.some((o) => o > 255)) return null;
  return (((oct[0] ?? 0) << 24) | ((oct[1] ?? 0) << 16) | ((oct[2] ?? 0) << 8) | (oct[3] ?? 0)) >>> 0;
};

const isLinkLocalIpv4 = (ip: number): boolean => (ip >>> 16) === 0xa9fe; // 169.254.0.0/16

export const assertSafeOutboundUrl = (
  raw: string,
  opts?: { allowLoopback?: boolean },
): URL => {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) throw new Error('URL is required.');

  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw new Error('Invalid URL.');
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed.');
  }
  if (u.username || u.password) {
    throw new Error('URLs must not include credentials.');
  }

  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (METADATA_HOSTS.has(host)) {
    throw new Error('That address is not allowed.');
  }

  const allowLoopback = opts?.allowLoopback !== false;
  if (!allowLoopback && (host === 'localhost' || host === '::1' || host === '0.0.0.0')) {
    throw new Error('That address is not allowed.');
  }

  const ipv4 = ipv4FromHost(host);
  if (ipv4 != null) {
    if (isLinkLocalIpv4(ipv4)) {
      throw new Error('That address is not allowed.');
    }
    const isLoopback = (ipv4 >>> 24) === 127 || ipv4 === 0;
    if (isLoopback && !allowLoopback) {
      throw new Error('That address is not allowed.');
    }
  }

  // IPv6 link-local (fe80::/10) and IPv6 metadata (fd00 variants we don't try
  // to enumerate) — block the well-known link-local prefix.
  if (host.includes(':') && host.toLowerCase().startsWith('fe80:')) {
    throw new Error('That address is not allowed.');
  }

  return u;
};
