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
 * The SINGLE blessed predicate for "is this connector healthy right now".
 * Every consumer that needs to decide "should the broken banner show
 * this row" / "should we skip this row in some heath UI" / etc MUST go
 * through this helper, not read `metadata.lastRefreshError` directly.
 *
 * Rationale (memory: feedback_connector_status_is_truth.md):
 * status is the single source of truth. metadata.lastRefreshError /
 * staleSince / etc are historical breadcrumbs. A row CAN legitimately
 * be status='connected' with stale lastRefreshError from a past
 * incident — that just means the row recovered. Reading the metadata
 * as if it were current state is the bug pattern that bit us 2026-05-12
 * (Drive showed broken in the banner for 24+ hours after being healthy).
 */
const HEALTHY_STATUSES = new Set(['connected', 'pending']);
export function isConnectorHealthy(row: { status: string }): boolean {
  return HEALTHY_STATUSES.has(row.status);
}

/**
 * The SINGLE blessed mutation for "this connector is now healthy".
 * Sets status='connected', clears errorMessage, AND strips all
 * stale-error metadata in one transaction. Use this instead of raw
 * `prisma.userConnector.update({ data: { status: 'connected' } })`
 * anywhere that needs to flip a row to healthy. Anywhere that uses
 * the raw update pattern is liable to reintroduce the 2026-05-12 bug.
 *
 * If you have ONLY the userId+connectorTypeId (not the row id), use
 * markConnectorConnectedByType().
 */
const STALE_ERROR_META_KEYS = [
  'lastError',
  'staleSince',
  'staleMin',
  'lastRefreshError',
  'lastRefreshErrorAt',
  'tokenExpiredAt',
] as const;

export async function markConnectorConnected(
  connectorId: string,
  recoveredVia: string = 'unknown',
): Promise<void> {
  const existing = await prisma.userConnector.findUnique({
    where: { id: connectorId },
    select: { metadata: true },
  }).catch(() => null);
  if (!existing) return;
  const m: Record<string, unknown> = { ...((existing.metadata as Record<string, unknown> | null) ?? {}) };
  for (const k of STALE_ERROR_META_KEYS) delete m[k];
  m.recoveredAt = new Date().toISOString();
  m.recoveredVia = recoveredVia;
  await prisma.userConnector.update({
    where: { id: connectorId },
    data: {
      status: 'connected',
      errorMessage: null,
      metadata: m as any,
    },
  }).catch((e: any) => {
    log.warn('markConnectorConnected failed', { connectorId, error: e.message });
  });
}

export async function markConnectorConnectedByType(
  userId: number,
  connectorTypeId: string,
  recoveredVia: string = 'unknown',
): Promise<void> {
  const row = await prisma.userConnector.findFirst({
    where: { userId, connectorTypeId },
    select: { id: true },
  }).catch(() => null);
  if (row) await markConnectorConnected(row.id, recoveredVia);
}

/**
 * Belt-and-suspenders invariant sweep. Finds rows where status is
 * healthy but stale-error metadata still exists, and strips the
 * metadata. Catches drift from any code path (manual SQL, third-party
 * tools, a future buggy caller) that flips status to connected
 * without using markConnectorConnected().
 *
 * Runs every 5 min from server.ts alongside detectStaleConnectors.
 */
export async function sweepStaleErrorMetadata(): Promise<{ scanned: number; cleaned: number }> {
  let scanned = 0;
  let cleaned = 0;
  // Pull only connected rows — they're the candidates for drift.
  // Filter in-memory because the metadata-has-stale-keys check is
  // awkward to express in Prisma's where clause.
  const rows = await prisma.userConnector.findMany({
    where: { status: 'connected' } as any,
    select: { id: true, metadata: true },
  }).catch(() => [] as any[]);
  scanned = rows.length;
  for (const r of rows) {
    const m = (r.metadata as Record<string, unknown> | null) ?? {};
    const hasStale = STALE_ERROR_META_KEYS.some((k) => k in m && m[k] != null);
    if (!hasStale) continue;
    const next: Record<string, unknown> = { ...m };
    for (const k of STALE_ERROR_META_KEYS) delete next[k];
    next.recoveredAt = new Date().toISOString();
    next.recoveredVia = 'invariant_sweep';
    await prisma.userConnector.update({
      where: { id: r.id }, data: { metadata: next as any },
    }).catch(() => { /* best-effort */ });
    cleaned++;
  }
  if (cleaned > 0) log.info('stale-metadata sweep cleaned', { scanned, cleaned });
  return { scanned, cleaned };
}

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
    if (isConnectorHealthy(r)) {
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
