/**
 * Tenant WhatsApp connection resilience layer.
 *
 * Two responsibilities:
 *
 *   1. **Heartbeat** — every 5 minutes, walk every tenant whose DB row
 *      says `whatsapp_config.status='connected'` and probe the live
 *      provider. If `testConnection()` reports the in-memory client
 *      is missing (typical after a SIGKILL'd previous process) we
 *      auto-trigger `provider.initialize()` to re-load LocalAuth from
 *      disk. This catches silent dropouts that don't fire
 *      `client.on('disconnected')` — Chromium hung, host slept,
 *      WhatsApp Web's underlying pupBrowser detached, etc.
 *
 *   2. **Disconnect alert** — when `client.on('disconnected')` fires
 *      for a non-recoverable reason (LOGOUT / CONFLICT / UNPAIRED) or
 *      the auto-reconnect circuit breaker opens after 5 attempts, email
 *      every SuperAdmin (and tenant admins) with the tenant phone +
 *      reason + the action they need to take. Without this admins only
 *      learn about a dropout when a user complains Brain went silent.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('whatsapp:watchdog');

// Tightened from 5 min → 60s per Basit 2026-07-06 "ensure it will
// keep connected". A missed heartbeat now costs at most 60s of
// silent-drop window instead of 5 min. Cost is ~1 probe per tenant
// per minute; at <20 tenants this is nothing.
const HEARTBEAT_INTERVAL_MS = 60 * 1000;
let heartbeatHandle: NodeJS.Timeout | null = null;
let probeInFlight = false;

// ─── Health metrics (in-memory ring buffer per tenant) ──────────
// Feeds the resilience dashboard (commit 3). Every probe appends a
// sample; we keep the last N=200 (~200 minutes) per tenant which is
// enough for a 3-hour view without unbounded memory growth.

interface HealthSample {
  at: number;         // Date.now()
  ok: boolean;
  latencyMs?: number;
  error?: string;
  action?: 'noop' | 'init_wait' | 'init_timeout' | 'reinit_success' | 'reinit_failed';
}
const HEALTH_HISTORY_CAP = 200;
const healthByTenant = new Map<string, HealthSample[]>();

function pushHealth(clientNumber: string, sample: HealthSample): void {
  const arr = healthByTenant.get(clientNumber) ?? [];
  const prev = arr[arr.length - 1];
  arr.push(sample);
  if (arr.length > HEALTH_HISTORY_CAP) arr.splice(0, arr.length - HEALTH_HISTORY_CAP);
  healthByTenant.set(clientNumber, arr);

  // #8 (audit 2026-07-14): the ring buffer dies with the process — the
  // TRANSITIONS (up→down, down→up, reinit outcomes) are the part worth
  // keeping, so persist those to system_logs (deduped/aggregated by its
  // recurrence machinery; steady-state healthy probes write nothing).
  const wasOk = prev ? prev.ok : true;
  const transitioned = wasOk !== sample.ok || sample.action === 'reinit_success' || sample.action === 'reinit_failed';
  if (transitioned) {
    import('../systemLogService')
      .then(({ log: sysLog }) => sysLog({
        level: sample.ok ? 'info' : 'warning',
        category: 'health_transition',
        source: `whatsapp:${clientNumber}`,
        message: sample.ok
          ? `WhatsApp wire recovered (${sample.action}, latency ${sample.latencyMs}ms)`
          : `WhatsApp wire DOWN (${sample.action}): ${sample.error ?? 'probe failed'}`,
        clientNumber,
      } as any))
      .catch(() => { /* ring buffer still has it */ });
  }
}

/** Exposed for the dashboard route to read the ring buffer. */
export function getHealthHistory(clientNumber: string): HealthSample[] {
  return healthByTenant.get(clientNumber) ?? [];
}

/** Aggregate stats for the dashboard header row (uptime %, avg
 *  latency, last error) — computed once per read from the ring buffer. */
export function getHealthStats(clientNumber: string): {
  totalSamples: number;
  okCount: number;
  uptimePct: number;
  avgLatencyMs: number | null;
  lastError: string | null;
  lastProbeAt: number | null;
  reinitSuccessCount: number;
  reinitFailedCount: number;
} {
  const arr = healthByTenant.get(clientNumber) ?? [];
  if (!arr.length) {
    return {
      totalSamples: 0, okCount: 0, uptimePct: 0,
      avgLatencyMs: null, lastError: null, lastProbeAt: null,
      reinitSuccessCount: 0, reinitFailedCount: 0,
    };
  }
  const okCount = arr.filter((s) => s.ok).length;
  const withLatency = arr.filter((s) => typeof s.latencyMs === 'number');
  const avgLatencyMs = withLatency.length
    ? Math.round(withLatency.reduce((a, s) => a + (s.latencyMs || 0), 0) / withLatency.length)
    : null;
  const lastErrSample = [...arr].reverse().find((s) => !s.ok);
  return {
    totalSamples: arr.length,
    okCount,
    uptimePct: Math.round((okCount / arr.length) * 100),
    avgLatencyMs,
    lastError: lastErrSample?.error ?? null,
    lastProbeAt: arr[arr.length - 1].at,
    reinitSuccessCount: arr.filter((s) => s.action === 'reinit_success').length,
    reinitFailedCount: arr.filter((s) => s.action === 'reinit_failed').length,
  };
}

/**
 * Start the heartbeat. Idempotent — safe to call multiple times during
 * boot; each start cancels the prior interval.
 */
export function startConnectionWatchdog(): void {
  if (heartbeatHandle) clearInterval(heartbeatHandle);
  heartbeatHandle = setInterval(probeAllTenants, HEARTBEAT_INTERVAL_MS);
  log.info('heartbeat started', { intervalMs: HEARTBEAT_INTERVAL_MS });
}

export function stopConnectionWatchdog(): void {
  if (heartbeatHandle) clearInterval(heartbeatHandle);
  heartbeatHandle = null;
}

/** Probe every tenant whose DB row says connected. Re-init if unhealthy. */
async function probeAllTenants(): Promise<void> {
  // setInterval does not await async callbacks. A slow Chromium init must not
  // let the next heartbeat start a competing sweep for the same LocalAuth dir.
  if (probeInFlight) {
    log.info('heartbeat sweep skipped — previous sweep still in flight');
    return;
  }
  probeInFlight = true;
  try {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT client_number, connected_number, status
       FROM whatsapp_config
      WHERE status IN ('connected', 'connecting', 'init_timeout',
                       'connected_unverified', 'liveness_failed', 'degraded')`,
  ).catch(() => [] as any[]);

  for (const row of rows) {
    const cn = row.client_number;
    const t0 = Date.now();
    try {
      // REQ-007 decision table: liveness states are handled explicitly
      // and are NEVER treated as send-capable or as ordinary drift.
      if (['connected_unverified', 'liveness_failed', 'degraded'].includes(row.status)) {
        const { decideWatchdogAction, mayReprobe } = await import('./webjsLiveness');
        const { isProbeInFlight, requestLivenessProbe } = await import('./WebjsProvider');
        const decision = decideWatchdogAction({
          status: row.status,
          probeInFlight: isProbeInFlight(cn),
          reprobeAllowed: mayReprobe(cn).allowed,
        });
        if (decision === 'wait_for_probe') {
          pushHealth(cn, { at: Date.now(), ok: false, error: `${row.status}: probe in flight`, action: 'init_wait' });
          continue;
        }
        if (decision === 'capped_reprobe') {
          await requestLivenessProbe(cn).catch(() => undefined);
          pushHealth(cn, { at: Date.now(), ok: false, error: `${row.status}: reprobe requested`, action: 'init_wait' });
          continue;
        }
        if (decision === 'bounded_reinit') {
          const { getProvider } = await import('./WhatsAppManager');
          const provider = await getProvider(cn);
          await provider.initialize(cn).catch((e: any) =>
            log.warn('liveness bounded re-init failed to start', { clientNumber: cn, error: e?.message }));
          pushHealth(cn, { at: Date.now(), ok: false, error: 'liveness_failed: bounded re-init', action: 'reinit_failed' });
          continue;
        }
        // withhold_for_repair: degraded with the episode cap exhausted.
        pushHealth(cn, { at: Date.now(), ok: false, error: 'degraded: probe episode cap exhausted — manual repair required', action: 'init_timeout' });
        continue;
      }
      const { getProvider } = await import('./WhatsAppManager');
      const provider = await getProvider(cn);
      const providerStatus = await provider.getStatus(cn);
      const init = providerStatus.init;
      const now = Date.now();
      const { watchdogInitDeferral } = await import('./webjsInitPolicy');
      const deferral = watchdogInitDeferral(providerStatus.status, init, now);

      if (deferral === 'connecting') {
        log.info('heartbeat waiting for bounded initialization', {
          clientNumber: cn, deadlineAt: init?.deadlineAt,
        });
        continue;
      }
      if (providerStatus.status === 'init_timeout') {
        if (deferral === 'repair_required') {
          pushHealth(cn, {
            at: now, ok: false,
            error: 'init_timeout: session likely wedged — re-pair may be required',
            action: 'init_timeout',
          });
          continue;
        }
        if (deferral === 'backoff') {
          log.info('heartbeat respecting init-timeout backoff', {
            clientNumber: cn, retryAt: init?.retryAt,
          });
          continue;
        }
      }
      const t = await provider.testConnection(cn).catch(() => ({ success: false, error: 'probe threw' }));
      const latencyMs = Date.now() - t0;

      if (t.success) {
        pushHealth(cn, { at: Date.now(), ok: true, latencyMs, action: 'noop' });
        continue;
      }

      // DB says connected, in-memory says no. Self-heal by re-initializing.
      log.warn('heartbeat detected drift — re-initializing', { clientNumber: cn, probeError: t.error });
      try {
        await provider.initialize(cn);
      } catch (initError: any) {
        const failedStatus = await provider.getStatus(cn).catch(() => null);
        const isInitTimeout = failedStatus?.status === 'init_timeout';
        pushHealth(cn, {
          at: Date.now(), ok: false, latencyMs: Date.now() - t0,
          error: isInitTimeout ? `init_timeout: ${failedStatus?.error ?? initError?.message}` : initError?.message,
          action: isInitTimeout ? 'init_timeout' : 'reinit_failed',
        });
        if (!isInitTimeout) throw initError;
        continue;
      }

      // Wait briefly for ready; if still failing, alert admins.
      const deadline = Date.now() + 10_000;
      let recovered = false;
      while (Date.now() < deadline) {
        const t2 = await provider.testConnection(cn).catch(() => ({ success: false }));
        if (t2.success) { recovered = true; break; }
        await new Promise((r) => setTimeout(r, 1000));
      }

      pushHealth(cn, {
        at: Date.now(),
        ok: recovered,
        latencyMs: Date.now() - t0,
        error: recovered ? undefined : (t.error ?? 'probe failed + reinit did not recover'),
        action: recovered ? 'reinit_success' : 'reinit_failed',
      });

      if (!recovered) {
        const failedStatus = await provider.getStatus(cn).catch(() => null);
        if (failedStatus?.status === 'connecting') {
          log.info('heartbeat initialization still connecting', { clientNumber: cn });
          continue;
        }
        log.error('heartbeat self-heal failed', { clientNumber: cn });
        await alertWhatsAppDisconnect({
          clientNumber: cn,
          tenantPhone: row.connected_number ?? '(unknown)',
          reason: 'heartbeat_self_heal_failed',
          requiresAction: 'Server-side auto-recovery failed. Open Admin → WhatsApp and re-pair via QR scan.',
        });
      }
    } catch (err: any) {
      pushHealth(cn, {
        at: Date.now(), ok: false,
        latencyMs: Date.now() - t0,
        error: err.message,
        action: 'noop',
      });
      log.error('heartbeat probe error', { clientNumber: cn, error: err.message });
    }
  }
  } finally {
    probeInFlight = false;
  }
}

/**
 * Email every SuperAdmin (and the disconnected tenant's local admins)
 * about a WhatsApp connection failure that needs human attention.
 *
 * Idempotency: we DO NOT dedup here. Callers should only invoke this
 * for state transitions (disconnect happens, circuit breaker opens),
 * not for every failed send — otherwise admins drown in alerts during
 * a transient WhatsApp outage.
 */
export async function alertWhatsAppDisconnect(params: {
  clientNumber: string;
  tenantPhone: string;
  reason: string;
  requiresAction: string;
  attemptCount?: number;
}): Promise<void> {
  const subject = `[Nexeo] WhatsApp disconnected — ${params.clientNumber}`;
  const html = `
    <div style="font-family: -apple-system, system-ui, sans-serif; max-width: 560px;">
      <p style="margin: 0 0 16px;"><strong>Brain has lost contact with users on tenant <code>${params.clientNumber}</code>.</strong></p>
      <table style="border-collapse: collapse; width: 100%; font-size: 13px;">
        <tr><td style="padding: 6px 10px; color: #666;">Tenant</td><td style="padding: 6px 10px;">${params.clientNumber}</td></tr>
        <tr><td style="padding: 6px 10px; color: #666;">WhatsApp number</td><td style="padding: 6px 10px;"><code>${params.tenantPhone}</code></td></tr>
        <tr><td style="padding: 6px 10px; color: #666;">Reason</td><td style="padding: 6px 10px;">${escapeHtml(params.reason)}</td></tr>
        ${params.attemptCount != null ? `<tr><td style="padding: 6px 10px; color: #666;">Auto-retry attempts</td><td style="padding: 6px 10px;">${params.attemptCount}</td></tr>` : ''}
        <tr><td style="padding: 6px 10px; color: #666;">Detected</td><td style="padding: 6px 10px;">${new Date().toISOString()}</td></tr>
      </table>
      <div style="margin-top: 16px; padding: 12px 14px; background: #fff8e6; border: 1px solid #f5d97f; border-radius: 6px; font-size: 13px;">
        <strong>Action required:</strong><br />
        ${escapeHtml(params.requiresAction)}
      </div>
      <p style="margin-top: 16px; font-size: 12px; color: #888;">
        While disconnected, Brain can't deliver criticality alerts, voice notes, or replies on this tenant.
        Inbound user messages will queue at WhatsApp's side until the connection is restored.
      </p>
    </div>
  `;

  // DEF-321 — the 09-04 incident, measured: this very function logged
  // `disconnect alert sent {sent:0, failed:1}` at 07:48:21 and NO ONE was
  // told the channel had died — the owner discovered it himself five hours
  // later ("why silence??"). Three defects in the old three lines, each the
  // codebase's own recorded lesson:
  //   1. `.catch(() => false)` swallowed WHY the email failed (DEF-276e: the
  //      reason must be captured at a level production keeps);
  //   2. sent:0 was logged at INFO — a guard whose failure mode is doing
  //      nothing quietly (DEF-276b, verbatim);
  //   3. email was the ONLY route: no durable receipt, no second transport —
  //      while `brainContactsUser` (audit row + WhatsApp attempt + the
  //      DEF-296 email fallback) sat unused. `protection-with-two-
  //      implementations`, 11th: one notification path with a fallback chain
  //      and one without, and the one without is the one that says "you can
  //      no longer reach me".
  // DEF-329 remediation — recipient resolution + per-recipient sends live in
  // the ONE shared helper now (adminOpsAlert.ts); a second copy here and a
  // second copy in the judgement-outage alarm would drift the moment either
  // changed. Interpretation and every log line below are unchanged.
  const { sendAdminOpsEmail } = await import('../notifications/adminOpsAlert');
  const { total, results } = await sendAdminOpsEmail({ clientNumber: params.clientNumber, subject, html });
  if (total === 0) {
    log.warn('no SA/AD recipients for disconnect alert', { clientNumber: params.clientNumber });
    return;
  }
  const sent = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  if (sent === 0) {
    // An undeliverable "I've gone dark" alert is an incident of its own, not
    // an info line. The per-recipient reasons are the diagnosis the 09-04
    // incident never had.
    log.error('disconnect alert reached NO ONE — escalating through the outbound chokepoint', {
      clientNumber: params.clientNumber,
      failures: failed.map((f) => ({ email: f.email, error: f.error })),
    });
  } else {
    log.info('disconnect alert sent', {
      clientNumber: params.clientNumber, sent, failed: failed.length, total,
      ...(failed.length ? { failures: failed.map((f) => ({ email: f.email, error: f.error })) } : {}),
    });
  }

  // DEF-321 — the SECOND route, through the one chokepoint every Brain→user
  // contact is supposed to take (`brainOutboundService`'s own contract):
  // a durable audit row exists even if delivery fails, and the DEF-296 email
  // fallback gives an independent template and send path. Runs ALWAYS, not
  // only when the admin emails fail: the owner deserves the notice in his own
  // channel history, and dedup bounds it to one per window. Wrapped so alert
  // plumbing can never throw into the disconnect handler.
  try {
    const ownerRows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM users
        WHERE client_number = $1 AND is_active = TRUE AND user_type IN ('SA','AD')
        ORDER BY user_type, id LIMIT 1`,
      params.clientNumber,
    ).catch(() => [] as any[]);
    const ownerId = ownerRows[0]?.id;
    if (ownerId) {
      // Wording belongs to the model (owner ruling 2026-08-19); the curated
      // fallback carries the same FACTS and fires only when the model is
      // unreachable — the DEF-277 pattern. Only WhatsApp is down here; the
      // model is not.
      const facts = `Brain's WhatsApp channel for tenant ${params.clientNumber} is DOWN. `
        + `Reason: ${params.reason}. Until it is re-paired, WhatsApp messages to Brain go `
        + `unanswered and Brain cannot send WhatsApp replies or alerts. Required action: ${params.requiresAction}`;
      let body: string;
      try {
        const { callLLM } = await import('../llmRouter');
        const r = await callLLM(
          'You are Nexeo, writing ONE short message to your owner. Say plainly, in your own '
          + 'words: your WhatsApp channel is down, since when is not known precisely, what that '
          + 'means for him (messages to you go unanswered), and exactly what will bring it back '
          + '(keep the required action verbatim). Under 400 characters, no markdown, no apology theatre.',
          facts,
          { maxTokens: 300, timeoutMs: 12_000 },
        );
        body = String((r as any)?.text ?? '').trim();
        if (!body) throw new Error('empty completion');
      } catch {
        body = facts;
      }
      const { brainContactsUser } = await import('../notifications/brainOutboundService');
      await brainContactsUser({
        userId: ownerId,
        clientNumber: params.clientNumber,
        kind: 'connector_stale',   // DIAGNOSTIC_KINDS: reserved slice, never crowds humans
        provenance: 'brain_prose',
        summary: `WhatsApp channel down: ${params.reason}`.slice(0, 200),
        body,
        urgency: 'high',
        dedupKey: `wa-disconnect:${params.clientNumber}`,
        dedupWindowMs: 6 * 60 * 60 * 1000,   // re-alert at most every 6h while dead
        metadata: { reason: params.reason, requiresAction: params.requiresAction },
      });
    } else {
      log.warn('no active SA/AD user to notify through the chokepoint', { clientNumber: params.clientNumber });
    }
  } catch (err: any) {
    log.error('chokepoint disconnect notice failed too — both routes down', {
      clientNumber: params.clientNumber, error: String(err?.message ?? err).slice(0, 200),
    });
  }
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
