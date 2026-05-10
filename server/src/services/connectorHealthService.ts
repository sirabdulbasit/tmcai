/**
 * Connector Health Service — Layer 2 of the OAuth-stale-sync defense.
 *
 * Background context (memory: project_oauth_stale_sync_failure.md):
 * Google OAuth apps in Testing mode issue refresh tokens that expire
 * after 7 days. When a user's Gmail/Calendar/Drive token expires, the
 * poller fails silently — status stays "connected", last_error stays
 * empty, and the user only notices when My Attention goes empty for
 * days. This service catches that within minutes.
 *
 * Three responsibilities:
 *
 *   1. detectStaleConnectors() — sweep run from server.ts every 5 min.
 *      For each user_connector with status='connected', compare
 *      last_sync_at against an expected staleness threshold per
 *      connector type. If exceeded, flip status='sync_stale', stamp
 *      lastError, fire one Brain WhatsApp alert (deduped via
 *      brainContactsUser.dedupKey).
 *
 *   2. markTokenExpired() — call this from every OAuth refresh-failure
 *      catch block to set status='token_expired' on the
 *      user_connector. Centralised so all sources (gmail, gcal, drive,
 *      tasks, chat) get the same treatment when invalid_grant fires.
 *
 *   3. getConnectorHealthSnapshot() — read-only summary the Day Brief
 *      banner queries to know whether to show a "reconnect" warning.
 *      Returns the worst-case connector status + counts.
 *
 * Naming convention: status values are lowercase strings stored in
 * user_connectors.status. Existing values: 'pending', 'connected',
 * 'disconnected', 'error'. New values added by this layer:
 *   - 'sync_stale'      — last_sync_at past threshold, root cause TBD
 *   - 'token_expired'   — OAuth refresh returned invalid_grant
 * Both are recoverable: user re-pairs in /connectors and status
 * returns to 'connected' on first successful poll.
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('connector-health');

/**
 * How long is "too long" without a sync, per connector type.
 *
 * Numbers are 2-3× the expected polling cadence — generous enough that
 * a transient network blip doesn't fire the alert, tight enough that a
 * 7-day token expiry is caught within 30 min instead of 4 days.
 *
 * Drive defaults to a longer threshold because folder-watch polling
 * runs less frequently than mail/calendar.
 */
const STALE_THRESHOLD_MIN: Record<string, number> = {
  ct_gmail:                  30,
  ct_google_calendar:        60,
  ct_google_tasks:          120,
  ct_google_chat:            30,
  ct_google_drive_personal: 240,
  ct_whatsapp_personal:      15,
  ct_outlook:                30,
  ct_microsoft_calendar:     60,
};

/** Pretty label for the alert + banner — strips the ct_ prefix. */
function prettyLabel(connectorTypeId: string): string {
  const map: Record<string, string> = {
    ct_gmail: 'Gmail',
    ct_google_calendar: 'Google Calendar',
    ct_google_tasks: 'Google Tasks',
    ct_google_chat: 'Google Chat',
    ct_google_drive_personal: 'Google Drive',
    ct_whatsapp_personal: 'WhatsApp',
    ct_outlook: 'Outlook',
    ct_microsoft_calendar: 'Microsoft Calendar',
  };
  return map[connectorTypeId] ?? connectorTypeId.replace(/^ct_/, '').replace(/_/g, ' ');
}

export type StaleConnector = {
  userId: number;
  clientNumber: string;
  connectorId: string;
  connectorTypeId: string;
  label: string;
  staleMin: number;
  lastSyncAt: Date | null;
};

/**
 * 5-minute sweep — flips status on stale connectors and fires one
 * Brain ping per occurrence. Idempotent: re-running while a connector
 * is already sync_stale is cheap (no extra alert fires because
 * brainContactsUser dedups on dedupKey).
 */
export async function detectStaleConnectors(): Promise<{ scanned: number; flipped: number }> {
  let scanned = 0;
  let flipped = 0;
  const stale: StaleConnector[] = [];

  // Pull all currently-connected connectors. Disconnected/error ones
  // are already in a non-healthy state — the user knows about them.
  const rows = await prisma.userConnector.findMany({
    where: { status: 'connected' } as any,
    select: {
      id: true, userId: true, clientNumber: true,
      connectorTypeId: true, lastSyncAt: true, metadata: true,
    },
  }).catch(() => [] as any[]);

  scanned = rows.length;

  for (const r of rows) {
    const threshold = STALE_THRESHOLD_MIN[r.connectorTypeId];
    if (!threshold) continue;             // unknown connector type — skip silently
    if (!r.lastSyncAt) continue;          // never synced — different problem (handled by initial-pair UX)

    const ageMs = Date.now() - new Date(r.lastSyncAt).getTime();
    const ageMin = Math.round(ageMs / 60_000);
    if (ageMin <= threshold) continue;    // healthy

    // Stale — flip status + write metadata.
    const label = prettyLabel(r.connectorTypeId);
    const errorMsg = `No sync for ${ageMin} min (expected every ${threshold} min). Likely OAuth token expired or connector lost session — reconnect from /connectors.`;
    try {
      await prisma.userConnector.update({
        where: { id: r.id },
        data: {
          status: 'sync_stale',
          metadata: {
            ...((r.metadata as any) ?? {}),
            lastError: errorMsg,
            staleSince: new Date().toISOString(),
            staleMin: ageMin,
          } as any,
        },
      });
      flipped++;
      stale.push({
        userId: r.userId, clientNumber: r.clientNumber,
        connectorId: r.id, connectorTypeId: r.connectorTypeId,
        label, staleMin: ageMin, lastSyncAt: r.lastSyncAt,
      });
      log.warn('connector flipped to sync_stale', {
        userId: r.userId, connectorTypeId: r.connectorTypeId, ageMin,
      });
    } catch (err: any) {
      log.warn('failed to flip connector status', { id: r.id, error: err.message });
    }
  }

  // Fire alerts in a separate pass so a slow LLM call in one alert
  // doesn't delay flipping the rest of the rows.
  if (stale.length > 0) {
    void fireStaleAlerts(stale).catch((e) => log.warn('stale alerts failed', { error: e.message }));
  }

  return { scanned, flipped };
}

/**
 * Send a Brain WhatsApp ping per stale connector. Deduped via
 * brainContactsUser.dedupKey so a connector that's stale across
 * multiple sweep ticks only alerts once until it recovers.
 *
 * Uses urgency='high' so it bypasses quiet hours only at emergency
 * level (not 'high' level) — the user explicitly asked Brain not to
 * be a postman; we ping once with substance and stop. Respects the
 * outboundEnabled opt-in: if the user hasn't opted in, the suppress
 * path silently records the alert but doesn't send.
 */
async function fireStaleAlerts(stale: StaleConnector[]): Promise<void> {
  const { brainContactsUser } = await import('./notifications/brainOutboundService');
  for (const s of stale) {
    const ageHr = Math.floor(s.staleMin / 60);
    const ageStr = ageHr >= 24
      ? `${Math.floor(ageHr / 24)} days`
      : ageHr >= 1 ? `${ageHr}h` : `${s.staleMin}m`;
    const body = `⚠️ ${s.label} not syncing — last update ${ageStr} ago.\n\nYour Day Brief is missing items from this source. Open Connectors → ${s.label} → Reconnect.`;
    await brainContactsUser({
      userId: s.userId,
      kind: 'connector_stale',
      summary: `${s.label} sync stale (${ageStr})`,
      body,
      urgency: 'high',
      dedupKey: `connector_stale:${s.connectorId}`,
      // 4h re-alert window — if still stale 4h later, ping again.
      // Most token-expiry stalls are fixed within minutes of the
      // user seeing the alert; if it's been 4h, the alert was
      // missed and the user needs reminding.
      dedupWindowMs: 4 * 60 * 60 * 1000,
      metadata: { connectorTypeId: s.connectorTypeId, staleMin: s.staleMin } as any,
    }).catch((e: any) => log.warn('alert send failed', { userId: s.userId, error: e.message }));
  }
}

/**
 * Call this from every OAuth-refresh failure catch block. Centralises
 * the status-flip + lastError write so all token-expiry paths look
 * the same in the DB.
 */
export async function markTokenExpired(args: {
  userId: number;
  connectorTypeId: string;
  errorMessage: string;
}): Promise<void> {
  try {
    const c = await prisma.userConnector.findFirst({
      where: { userId: args.userId, connectorTypeId: args.connectorTypeId },
      select: { id: true, metadata: true, status: true },
    });
    if (!c) return;
    if (c.status === 'token_expired') return; // already flagged

    await prisma.userConnector.update({
      where: { id: c.id },
      data: {
        status: 'token_expired',
        metadata: {
          ...((c.metadata as any) ?? {}),
          lastError: `Token expired: ${args.errorMessage}`,
          tokenExpiredAt: new Date().toISOString(),
        } as any,
      },
    });
    log.warn('connector marked token_expired', {
      userId: args.userId, connectorTypeId: args.connectorTypeId,
    });

    // Fire the same alert as stale — user's action is the same:
    // reconnect.
    void fireStaleAlerts([{
      userId: args.userId, clientNumber: '',
      connectorId: c.id, connectorTypeId: args.connectorTypeId,
      label: prettyLabel(args.connectorTypeId),
      staleMin: 0, lastSyncAt: null,
    }]).catch(() => {});
  } catch (err: any) {
    log.warn('markTokenExpired failed', { error: err.message });
  }
}

/**
 * Read-only health snapshot for the Day Brief banner. Returns the
 * list of unhealthy connectors for one user so the UI can render a
 * clickable "Reconnect Gmail" warning when needed.
 */
export interface ConnectorHealth {
  connectorId: string;
  connectorTypeId: string;
  label: string;
  status: string;
  lastSyncAt: string | null;
  lastError: string | null;
  staleMin: number | null;
}

export async function getConnectorHealthSnapshot(userId: number): Promise<{
  healthy: number;
  unhealthy: ConnectorHealth[];
}> {
  const rows = await prisma.userConnector.findMany({
    where: { userId } as any,
    select: {
      id: true, connectorTypeId: true, status: true,
      lastSyncAt: true, metadata: true,
    },
  }).catch(() => [] as any[]);

  const unhealthy: ConnectorHealth[] = [];
  let healthy = 0;
  for (const r of rows) {
    const isHealthy = r.status === 'connected' || r.status === 'pending';
    if (isHealthy) {
      healthy++;
      continue;
    }
    const meta = (r.metadata as any) ?? {};
    unhealthy.push({
      connectorId: r.id,
      connectorTypeId: r.connectorTypeId,
      label: prettyLabel(r.connectorTypeId),
      status: r.status,
      lastSyncAt: r.lastSyncAt ? new Date(r.lastSyncAt).toISOString() : null,
      lastError: meta.lastError ?? null,
      staleMin: typeof meta.staleMin === 'number' ? meta.staleMin : null,
    });
  }
  return { healthy, unhealthy };
}
