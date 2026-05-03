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
import { sendEmail } from '../emailService';

const log = createLogger('whatsapp:watchdog');

const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
let heartbeatHandle: NodeJS.Timeout | null = null;

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
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT client_number, connected_number FROM whatsapp_config WHERE status = 'connected'`,
  ).catch(() => [] as any[]);

  for (const row of rows) {
    const cn = row.client_number;
    try {
      const { getProvider } = await import('./WhatsAppManager');
      const provider = await getProvider(cn);
      const t = await provider.testConnection(cn).catch(() => ({ success: false, error: 'probe threw' }));

      if (t.success) continue;

      // DB says connected, in-memory says no. Self-heal by re-initializing.
      log.warn('heartbeat detected drift — re-initializing', { clientNumber: cn, probeError: t.error });
      await provider.initialize(cn);

      // Wait briefly for ready; if still failing, alert admins.
      const deadline = Date.now() + 10_000;
      let recovered = false;
      while (Date.now() < deadline) {
        const t2 = await provider.testConnection(cn).catch(() => ({ success: false }));
        if (t2.success) { recovered = true; break; }
        await new Promise((r) => setTimeout(r, 1000));
      }

      if (!recovered) {
        log.error('heartbeat self-heal failed', { clientNumber: cn });
        await alertWhatsAppDisconnect({
          clientNumber: cn,
          tenantPhone: row.connected_number ?? '(unknown)',
          reason: 'heartbeat_self_heal_failed',
          requiresAction: 'Server-side auto-recovery failed. Open Admin → WhatsApp and re-pair via QR scan.',
        });
      }
    } catch (err: any) {
      log.error('heartbeat probe error', { clientNumber: cn, error: err.message });
    }
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
  // Recipients: every active SuperAdmin + every active admin of the
  // affected tenant. SuperAdmin needs the cross-tenant operational view;
  // tenant admin actually has to scan the QR.
  const recipients = await prisma.$queryRawUnsafe<any[]>(
    `SELECT DISTINCT email, name, user_type, client_number
       FROM users
      WHERE is_active = TRUE
        AND ( user_type = 'SA'
              OR (user_type = 'AD' AND client_number = $1) )
        AND email IS NOT NULL
        AND email <> ''`,
    params.clientNumber,
  ).catch(() => [] as any[]);

  if (recipients.length === 0) {
    log.warn('no SA/AD recipients for disconnect alert', { clientNumber: params.clientNumber });
    return;
  }

  const subject = `[MyOS] WhatsApp disconnected — ${params.clientNumber}`;
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

  const results = await Promise.all(
    recipients.map(async (r) => ({
      email: r.email,
      ok: await sendEmail(r.email, subject, html).catch(() => false),
    })),
  );
  const sent = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  log.info('disconnect alert sent', { clientNumber: params.clientNumber, sent, failed, total: recipients.length });
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
