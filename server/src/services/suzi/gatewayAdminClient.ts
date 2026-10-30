/**
 * Suzi desktop — Nexeo's side of the connection-key flow (DEF-370).
 *
 * Suzi is the voice assistant on a user's own computer. Its server half, the
 * gateway (/var/www/jarvis-gateway, PM2 `jarvis-gateway`), owns the devices.
 * Nexeo only asks it, on behalf of the signed-in person, to mint a single-use
 * connection key, list that person's computers, or disconnect one. The calls
 * go to the gateway's admin API on loopback; the browser never sees the
 * gateway or its secret.
 *
 * The admin secret is a FILE the gateway owns, read per call so rotating it
 * needs no Nexeo restart. A missing secret, an unreachable gateway or a
 * gateway error is a typed failure the route turns into a visible message —
 * never a fake success (AGENTS.md §2.6).
 */
import { promises as fs } from 'fs';
import { env } from '../../config/env';
import createLogger from '../../utils/logger';

const log = createLogger('suzi');

export class SuziNotConfiguredError extends Error {}
export class SuziGatewayError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Who the request is for. Always built from req.user on the server, never from the request body. */
export interface SuziOwner { userId: number; clientNumber: string; displayName: string }

export interface SuziDevice {
  id: string;
  name: string;
  os: string;
  connectedAt: string;
  lastSeenAt: string | null;
  online: boolean;
}

async function readSecret(): Promise<string> {
  let secret = '';
  try {
    secret = (await fs.readFile(env.suziGatewayAdminSecretFile, 'utf8')).trim();
  } catch {
    /* treated as not configured below */
  }
  if (secret.length < 32) throw new SuziNotConfiguredError('Suzi desktop is not set up on this server');
  return secret;
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
  const secret = await readSecret();
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${env.suziGatewayAdminUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // The secret must never follow a redirect to another host.
      redirect: 'manual',
      signal: AbortSignal.timeout(env.suziGatewayTimeoutMs),
    });
  } catch (err) {
    const timedOut = (err as { name?: string })?.name === 'TimeoutError';
    log.warn('suzi gateway unreachable', { path, timedOut, ms: Date.now() - started });
    throw new SuziGatewayError(timedOut ? 'Suzi server did not answer in time' : 'Suzi server could not be reached', 502);
  }
  const data: any = await res.json().catch(() => null);
  if (res.status === 404) throw new SuziGatewayError('No such connected computer', 404);
  if (res.status === 503) throw new SuziNotConfiguredError('Suzi desktop is not set up on this server');
  if (!res.ok) {
    // The gateway's own code only — never its URL, never the secret.
    log.warn('suzi gateway error', { path, status: res.status, code: data?.error?.code, ms: Date.now() - started });
    throw new SuziGatewayError('Suzi server returned an error', 502);
  }
  return data;
}

/** The key and the server URL the desktop app needs — Nexeo web shows both, plus a one-line link. */
export async function createConnectKey(owner: SuziOwner): Promise<{ key: string; expiresAt: string; serverUrl: string; connectLink: string }> {
  const data = await call('POST', '/admin/connect-keys', {
    user_id: String(owner.userId),
    tenant_id: owner.clientNumber,
    user_name: owner.displayName,
    created_by: 'nexeo-web',
  });
  if (typeof data?.key !== 'string' || typeof data?.expires_at !== 'string' || !/^https?:\/\/[^\s]+$/.test(String(data?.server_url ?? ''))) {
    throw new SuziGatewayError('Suzi server returned an unexpected answer', 502);
  }
  const serverUrl = String(data.server_url).replace(/\/+$/, '');
  log.info('suzi connection key issued', { userId: owner.userId, clientNumber: owner.clientNumber });
  return {
    key: data.key,
    expiresAt: data.expires_at,
    serverUrl,
    // Pasted as one line into the Suzi app's Connect field (CN-001).
    connectLink: `suzi://connect?server=${encodeURIComponent(serverUrl)}&key=${encodeURIComponent(data.key)}`,
  };
}

export async function listDevices(owner: SuziOwner): Promise<SuziDevice[]> {
  const q = new URLSearchParams({ user_id: String(owner.userId), tenant_id: owner.clientNumber });
  const data = await call('GET', `/admin/devices?${q}`);
  const rows: any[] = Array.isArray(data?.devices) ? data.devices : [];
  return rows.map((d) => ({
    id: String(d.id),
    name: String(d.name ?? ''),
    os: String(d.os ?? ''),
    connectedAt: String(d.connected_at ?? ''),
    lastSeenAt: d.last_seen_at ? String(d.last_seen_at) : null,
    online: !!d.online,
  }));
}

/** Disconnects only a computer that belongs to this owner; the gateway enforces it too. */
export async function disconnectDevice(owner: SuziOwner, deviceId: string): Promise<void> {
  await call('POST', '/admin/revoke', { device_id: deviceId, user_id: String(owner.userId), tenant_id: owner.clientNumber });
  log.info('suzi device disconnected', { userId: owner.userId, clientNumber: owner.clientNumber, deviceId });
}
