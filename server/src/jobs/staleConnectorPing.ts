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
 * DEF-244 — `connector-selfheal-absent`: this job's own header used to say
 * "detection + nudge only", and that is what the owner lived for nine days
 * (S24/S25: "why are you not sync? how it can be?" answered with "go to
 * Settings … and reconnect them" — ~14 nags, zero repair attempts). Rung 1
 * of Self-Healing without rung 2. Now, BEFORE any Google-family nag, the
 * job ATTEMPTS the recovery itself via `getAuthenticatedClient` — the same
 * refresh the pollers use, which durably records its own outcome:
 *
 *   - the grant is ALIVE (refresh succeeded / token already valid): the
 *     staleness is transient, state was healed by the probe, and the owner
 *     is NOT nagged this sweep. If the connector is still stale next sweep,
 *     it re-enters and is pinged then — a heal that did not stick is not
 *     silently retried forever.
 *   - the grant is DEAD (invalid_grant / no refresh token): re-consent
 *     genuinely needs the human, and the ping now carries the RECEIPT of
 *     the attempt — the owner is asked to reconnect because Brain tried
 *     and could not, never as a standing instruction it did not test.
 *
 * The probe is Google-family wiring (gmail / google_* / gtasks share one
 * OAuth grant via getAuthenticatedClient); other providers keep the
 * detection-only behaviour until they have a probe. A probe that THROWS
 * unexpectedly never suppresses the alert — fail toward telling him.
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';
import { ownerFacingCause } from '../services/connectors/providerErrorText';

const log = createLogger('stale-connector-ping');

const STALE_HOURS_THRESHOLD = 24;

/** Google-family connectors share one OAuth grant refreshable by
 *  `getAuthenticatedClient` — wiring fact, not a capability judgement. */
function hasGoogleProbe(connectorTypeId: string | null | undefined): boolean {
  return /gmail|google|gtasks/i.test(connectorTypeId ?? '');
}

type HealOutcome = 'grant_alive' | 'grant_dead' | 'probe_error';

/** Attempt the recovery the nag would otherwise delegate to the owner.
 *  Returns the outcome plus the provider's reason when the grant is dead. */
async function attemptHeal(userId: number): Promise<{ outcome: HealOutcome; error?: string }> {
  try {
    const { getAuthenticatedClient } = await import('../services/integrationService');
    const r = await getAuthenticatedClient(userId);
    if (r.client) return { outcome: 'grant_alive' };
    return { outcome: 'grant_dead', error: r.error };
  } catch (e: any) {
    return { outcome: 'probe_error', error: e?.message };
  }
}

export async function runStaleConnectorPing(opts: { dryRun?: boolean } = {}): Promise<{
  scanned: number;
  pinged: number;
  skipped: number;
  /** DEF-244 — rows whose grant the heal attempt found ALIVE: state healed,
   *  nag suppressed this sweep. */
  healed: number;
}> {
  const out = { scanned: 0, pinged: 0, skipped: 0, healed: 0 };
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
    // DEF-244 — one heal attempt per USER per sweep (the Google family shares
    // one grant; refreshing it five times for five sibling connectors would
    // be noise in the token endpoint's logs and no extra healing).
    const healByUser = new Map<number, { outcome: HealOutcome; error?: string }>();
    for (const row of stale) {
      const connType = row.connector_type_id?.replace(/^ct_/, '').replace(/_personal$/, '').replace(/_/g, ' ') ?? 'a connector';

      // DEF-244 — attempt the repair BEFORE composing any nag.
      let heal: { outcome: HealOutcome; error?: string } | null = null;
      if (!opts.dryRun && hasGoogleProbe(row.connector_type_id)) {
        heal = healByUser.get(row.user_id) ?? (await attemptHeal(row.user_id));
        healByUser.set(row.user_id, heal);
        if (heal.outcome === 'grant_alive') {
          // The probe refreshed (or found valid) the grant and
          // `getAuthenticatedClient` already stamped the healed state. The
          // staleness was transient — no nag this sweep. Still stale next
          // sweep → the row re-enters and is pinged with its receipt.
          log.info('connector grant alive after heal attempt — nag suppressed this sweep', {
            userId: row.user_id, connectorTypeId: row.connector_type_id,
          });
          out.healed += 1;
          continue;
        }
      }
      // DEF-229 — the owner used to get the provider's own token here:
      // ` (invalid_grant)`. `B08-bad-news` quoted it back verbatim. He is told
      // what happened in his terms, and when the code cannot be translated he
      // is told NOTHING extra — a code he cannot act on is worse than silence,
      // and the sentence below already says what to do.
      const cause = ownerFacingCause(row.last_oauth_error);
      const reason = cause ? ` ${cause[0].toUpperCase()}${cause.slice(1)}.` : '';
      const ageHours = row.last_sync_at
        ? Math.floor((Date.now() - new Date(row.last_sync_at).getTime()) / (60 * 60 * 1000))
        : null;
      const ageStr = ageHours != null ? ` Last sync ${ageHours}h ago.` : '';
      // DEF-244 — when Brain TRIED and the grant is dead, the ask carries the
      // receipt of the attempt: he is asked because self-repair was attempted
      // and failed, not as an untested standing instruction.
      const attempted = heal?.outcome === 'grant_dead'
        ? ' I tried to refresh its access myself just now and could not — reconnecting needs you.'
        : '';
      const body = `⚠️ Brain: ${connType} hasn't synced.${ageStr}${reason}${attempted} Open Settings → Connectors and reconnect to keep Brain seeing your latest data.`;
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
        metadata: {
          source: 'stale_connector_ping', connectorTypeId: row.connector_type_id, ageHours,
          // DEF-244 — the durable receipt of the self-repair attempt (or that
          // none was possible for this provider).
          healAttempt: heal ? { outcome: heal.outcome, error: heal.error?.slice(0, 200) } : { outcome: 'no_probe' },
        },
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
