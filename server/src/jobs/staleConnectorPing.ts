/**
 * Proactive Brain → user ping when a connector goes stale.
 *
 * Per Basit 2026-05-23: Drive (and other Google APIs in Testing mode)
 * rotate refresh tokens every 7 days — connectors silently die with
 * `last_oauth_error` set. Brain should NOTICE this and ping the user
 * once per stale connector with a clear action ("reconnect at Settings
 * → Connectors").
 *
 * Dedup: at most one ping per (user, connector_type) per 24h. The
 * brainPromptQueue's dedupKey enforces this.
 *
 * Scope (this iteration): detection + nudge only. The actual OAuth
 * Production-mode verification is an ops task that lives outside code.
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('stale-connector-ping');

const STALE_HOURS_THRESHOLD = 24;

export async function runStaleConnectorPing(opts: { dryRun?: boolean } = {}): Promise<{
  scanned: number;
  pinged: number;
  skipped: number;
}> {
  const out = { scanned: 0, pinged: 0, skipped: 0 };
  try {
    // The user_connectors table is what tracks per-user connector state
    // post-GCP-simplification (per memory project_gcp_simplification.md).
    const stale = await prisma.$queryRawUnsafe<any[]>(`
      SELECT uc.user_id, uc.connector_type_id, uc.status, uc.last_sync_at,
             uc.metadata->>'lastRefreshError' AS last_oauth_error,
             u.client_number
      FROM user_connectors uc
      JOIN users u ON u.id = uc.user_id
      WHERE uc.status IN ('sync_stale', 'error')
        AND (
          uc.last_sync_at IS NULL OR
          uc.last_sync_at < NOW() - INTERVAL '${STALE_HOURS_THRESHOLD} hours'
        )
    `).catch(() => []);
    out.scanned = stale.length;
    if (out.scanned === 0) return out;

    const { enqueueBrainPrompt } = await import('../services/brainPrompts/brainPromptQueueService');
    for (const row of stale) {
      const connType = row.connector_type_id?.replace(/^ct_/, '').replace(/_personal$/, '').replace(/_/g, ' ') ?? 'a connector';
      const reason = row.last_oauth_error ? ` (${row.last_oauth_error})` : '';
      const ageHours = row.last_sync_at
        ? Math.floor((Date.now() - new Date(row.last_sync_at).getTime()) / (60 * 60 * 1000))
        : null;
      const ageStr = ageHours != null ? ` Last sync ${ageHours}h ago.` : '';
      const body = `⚠️ Brain: ${connType} hasn't synced.${ageStr}${reason} Open Settings → Connectors and reconnect to keep Brain seeing your latest data.`;
      if (opts.dryRun) {
        log.info('would ping', { userId: row.user_id, connType, ageHours });
        out.pinged += 1;
        continue;
      }
      const r = await enqueueBrainPrompt({
        userId: row.user_id,
        clientNumber: row.client_number,
        question: body,
        sideEffect: { kind: 'free_form_note' },
        criticality: 'routine',
        dedupKey: `stale_connector:${row.user_id}:${row.connector_type_id}`,
        metadata: { source: 'stale_connector_ping', connectorTypeId: row.connector_type_id, ageHours },
      });
      if (r.status === 'duplicate') {
        out.skipped += 1;
      } else {
        out.pinged += 1;
      }
    }
  } catch (e: any) {
    log.warn('sweep error', { error: e?.message });
  }
  if (out.pinged > 0 || out.scanned > 0) log.info('sweep', out);
  return out;
}

export function scheduleStaleConnectorPing(): void {
  const INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h
  const FIRST_TICK_MS = 10 * 60 * 1000; // 10 min after boot
  setTimeout(() => {
    runStaleConnectorPing().catch(() => undefined);
    setInterval(() => runStaleConnectorPing().catch(() => undefined), INTERVAL_MS);
  }, FIRST_TICK_MS);
  log.info('stale-connector ping scheduled', { firstTickMs: FIRST_TICK_MS, intervalMs: INTERVAL_MS });
}
