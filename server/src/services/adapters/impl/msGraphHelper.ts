/**
 * Microsoft Graph helper — shared OAuth-token refresh + connected-user
 * lookup used by every MS adapter (outlook / outlook_calendar /
 * ms_teams / onedrive_personal / ms_todo). Each adapter calls this
 * instead of duplicating the refresh logic 4× across files.
 *
 * Token storage: per-user UserConnector.config (envelope-encrypted).
 * Refresh: standard `grant_type=refresh_token` against
 * `https://login.microsoftonline.com/common/oauth2/v2.0/token`.
 *
 * Conservative: token refresh failure returns the (possibly expired)
 * access token rather than throwing — caller decides how to handle.
 */
import prisma from '../../../db/prisma';
import createLogger from '../../../utils/logger';
import {
  decryptConnectorConfig,
  encryptConnectorConfig,
} from '../../connectorService';

const log = createLogger('ms-graph-helper');

/** Find every user in this tenant who has the given Microsoft connector wired. */
export async function listConnectedUsers(
  tenantId: string,
  slug: 'outlook' | 'outlook_calendar' | 'ms_teams' | 'onedrive_personal' | 'ms_todo',
): Promise<Array<{ userId: number }>> {
  const ct = await prisma.connectorType.findUnique({ where: { slug } });
  if (!ct) return [];
  return prisma.userConnector.findMany({
    where: { clientNumber: tenantId, connectorTypeId: ct.id, status: 'connected' },
    select: { userId: true },
  });
}

/** Returns a fresh access token, refreshing if expired. Persists the
 *  refreshed token+expiry back to user_connectors.config. Returns null
 *  if refresh fails or the user isn't connected. */
export async function ensureFreshGraphToken(
  userId: number,
  slug: 'outlook' | 'outlook_calendar' | 'ms_teams' | 'onedrive_personal' | 'ms_todo',
): Promise<string | null> {
  const ct = await prisma.connectorType.findUnique({ where: { slug } });
  if (!ct) return null;
  const uc = await prisma.userConnector.findUnique({
    where: { userId_connectorTypeId: { userId, connectorTypeId: ct.id } },
  });
  if (!uc || uc.status !== 'connected' || !uc.config) return null;

  const cfg = await decryptConnectorConfig(uc.config as Record<string, unknown>);
  const accessToken = cfg.accessToken as string | undefined;
  const refreshToken = cfg.refreshToken as string | undefined;
  const expiryIso = cfg.tokenExpiry as string | undefined;
  const clientId = cfg.clientId as string | undefined;
  const clientSecret = cfg.clientSecret as string | undefined;

  // Treat as expired if there's no expiry or it's within a 60s buffer.
  const isExpired = !expiryIso || Date.now() > Date.parse(expiryIso) - 60_000;
  if (!isExpired && accessToken) return accessToken;
  if (!refreshToken || !clientId || !clientSecret) return accessToken ?? null;

  try {
    const r = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (!r.ok) {
      log.warn('graph token refresh failed', { userId, slug, status: r.status });
      return accessToken ?? null;
    }
    const j: any = await r.json();
    if (!j.access_token) return accessToken ?? null;
    const newExpiry = j.expires_in
      ? new Date(Date.now() + Number(j.expires_in) * 1000).toISOString()
      : '';
    const updated = {
      ...cfg,
      accessToken: j.access_token,
      refreshToken: j.refresh_token || refreshToken,
      tokenExpiry: newExpiry,
    };
    const enc = await encryptConnectorConfig(updated);
    await prisma.userConnector.update({
      where: { userId_connectorTypeId: { userId, connectorTypeId: ct.id } },
      data: { config: enc as any },
    });
    return j.access_token;
  } catch (err: any) {
    log.warn('graph token refresh threw', { userId, slug, error: err.message });
    return accessToken ?? null;
  }
}

/** Fetch JSON from Graph with the user's token. Returns parsed body or null. */
export async function graphGet<T = any>(
  userId: number,
  slug: 'outlook' | 'outlook_calendar' | 'ms_teams' | 'onedrive_personal' | 'ms_todo',
  url: string,
): Promise<T | null> {
  const token = await ensureFreshGraphToken(userId, slug);
  if (!token) return null;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    log.warn('graph GET failed', { userId, slug, status: r.status, url: url.slice(0, 80) });
    return null;
  }
  return r.json() as Promise<T>;
}

/** POST JSON to Graph (for create/update operations). Returns parsed body or null. */
export async function graphPost<T = any>(
  userId: number,
  slug: 'outlook' | 'outlook_calendar' | 'ms_teams' | 'onedrive_personal' | 'ms_todo',
  url: string,
  body: any,
): Promise<T | null> {
  const token = await ensureFreshGraphToken(userId, slug);
  if (!token) return null;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    log.warn('graph POST failed', { userId, slug, status: r.status, url: url.slice(0, 80) });
    return null;
  }
  return r.json() as Promise<T>;
}
