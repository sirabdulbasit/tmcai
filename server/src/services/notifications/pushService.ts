/**
 * Web Push service.
 *
 * Sends notifications to user devices via the standard Web Push protocol
 * (RFC 8030 + VAPID). Each user can have multiple device subscriptions;
 * a single send fans out across all of them and respects per-user
 * preferences (event-type toggles + quiet hours + rate limit).
 *
 * Multi-tenant: every read scopes by clientNumber. A push for tenant A
 * cannot fire on a device subscribed for tenant B even if the same user
 * is in both — the two memberships are different (clientNumber, userId)
 * pairs.
 *
 * VAPID keys come from env (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
 * VAPID_CONTACT_EMAIL). When unset the service short-circuits — calls
 * succeed but no actual push fires, so dev environments don't break.
 */
import webpush from 'web-push';
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('push');

let vapidConfigured = false;

function ensureVapid(): boolean {
  if (vapidConfigured) return true;
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const contact = process.env.VAPID_CONTACT_EMAIL || 'mailto:noreply@example.com';
  if (!pub || !priv) return false;
  try {
    webpush.setVapidDetails(contact, pub, priv);
    vapidConfigured = true;
    return true;
  } catch (err: any) {
    log.error('VAPID setup failed', { error: err.message });
    return false;
  }
}

/** Public VAPID key — clients fetch this on subscribe. */
export function getVapidPublicKey(): string | null {
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

// ─── Per-user preferences ──────────────────────────────────────

export type PushEventType =
  | 'approval_request'
  | 'risk_radar_high'
  | 'watchpoint_hit'
  | 'meeting_imminent'
  | 'kill_switch_change'
  | 'cost_anomaly'
  | 'morning_brief'
  | 'low_priority_draft';

export interface PushPrefs {
  enabled: boolean;
  events: Record<PushEventType, boolean>;
  quietHours: { start: string; end: string; timezone: string; allowCritical: boolean };
  rateLimit: { maxPerHour: number };
}

export const DEFAULT_PUSH_PREFS: PushPrefs = {
  enabled: true,
  events: {
    approval_request: true,
    risk_radar_high: true,
    watchpoint_hit: true,
    meeting_imminent: true,
    kill_switch_change: true,
    cost_anomaly: true,
    morning_brief: false,
    low_priority_draft: false,
  },
  quietHours: { start: '22:00', end: '07:00', timezone: 'Asia/Karachi', allowCritical: true },
  rateLimit: { maxPerHour: 20 },
};

export async function loadPrefs(userId: number): Promise<PushPrefs> {
  const row = await prisma.brainConfig.findUnique({
    where: { userId },
    select: { pushPrefs: true },
  });
  return mergePrefs(row?.pushPrefs as Partial<PushPrefs> | null);
}

export async function savePrefs(
  clientNumber: string, userId: number, patch: Partial<PushPrefs>,
): Promise<PushPrefs> {
  const existing = await prisma.brainConfig.findUnique({ where: { userId }, select: { id: true, clientNumber: true } });
  if (!existing) {
    await prisma.brainConfig.create({ data: { userId, clientNumber } });
  } else if (existing.clientNumber !== clientNumber) {
    throw new Error('user does not belong to this tenant');
  }
  const current = await loadPrefs(userId);
  const merged = mergePrefs({ ...current, ...patch });
  await prisma.brainConfig.update({
    where: { userId },
    data: { pushPrefs: merged as unknown as object },
  });
  return merged;
}

function mergePrefs(input: Partial<PushPrefs> | null): PushPrefs {
  if (!input) return JSON.parse(JSON.stringify(DEFAULT_PUSH_PREFS));
  const d = DEFAULT_PUSH_PREFS;
  return {
    enabled: input.enabled ?? d.enabled,
    events: { ...d.events, ...((input.events as Partial<PushPrefs['events']>) ?? {}) },
    quietHours: { ...d.quietHours, ...((input.quietHours as Partial<PushPrefs['quietHours']>) ?? {}) },
    rateLimit: { ...d.rateLimit, ...((input.rateLimit as Partial<PushPrefs['rateLimit']>) ?? {}) },
  };
}

// ─── Device registration ───────────────────────────────────────

export interface SubscribeInput {
  clientNumber: string;
  userId: number;
  endpoint: string;
  p256dhKey: string;
  authKey: string;
  deviceLabel?: string | null;
  userAgent?: string | null;
}

export async function subscribe(input: SubscribeInput) {
  return prisma.pushSubscription.upsert({
    where: { userId_endpoint: { userId: input.userId, endpoint: input.endpoint } } as any,
    create: {
      clientNumber: input.clientNumber,
      userId: input.userId,
      endpoint: input.endpoint,
      p256dhKey: input.p256dhKey,
      authKey: input.authKey,
      deviceLabel: input.deviceLabel ?? null,
      userAgent: input.userAgent ?? null,
      isActive: true,
    },
    update: {
      p256dhKey: input.p256dhKey,
      authKey: input.authKey,
      deviceLabel: input.deviceLabel ?? undefined,
      userAgent: input.userAgent ?? undefined,
      isActive: true,
      lastError: null,
      failureCount: 0,
    },
  });
}

export async function unsubscribe(userId: number, subscriptionId: number) {
  await prisma.pushSubscription.updateMany({
    where: { id: subscriptionId, userId },
    data: { isActive: false },
  });
}

export async function listDevices(clientNumber: string, userId: number) {
  return prisma.pushSubscription.findMany({
    where: { clientNumber, userId, isActive: true },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, deviceLabel: true, userAgent: true,
      createdAt: true, lastPushAt: true,
    },
  });
}

// ─── Sending ───────────────────────────────────────────────────

export interface PushPayload {
  /** Event type — checked against user prefs to decide whether to fire. */
  event: PushEventType;
  /** Notification title (≤80 chars recommended). */
  title: string;
  /** Body (≤300 chars recommended). */
  body: string;
  /** URL to open when the notification is clicked (no action). */
  url?: string;
  /** Action buttons. Each `action` is matched by the service worker. */
  actions?: Array<{ action: string; title: string; url?: string }>;
  /** Optional grouping tag — same tag replaces an older notification. */
  tag?: string;
  /** Severity. 'critical' bypasses quiet hours when allowCritical=true. */
  severity?: 'low' | 'medium' | 'high' | 'critical';
  /** Optional structured data passed verbatim to the SW. */
  data?: Record<string, unknown>;
}

export interface SendResult {
  attempted: number;
  delivered: number;
  failed: number;
  skipped: number;
  reason?: string;
}

/** Send a push to one user (fans out across all their active devices). */
export async function sendToUser(
  clientNumber: string, userId: number, payload: PushPayload,
): Promise<SendResult> {
  const result: SendResult = { attempted: 0, delivered: 0, failed: 0, skipped: 0 };

  if (!ensureVapid()) {
    result.reason = 'vapid_not_configured';
    return result;
  }

  const prefs = await loadPrefs(userId);
  if (!prefs.enabled) { result.reason = 'push_disabled_by_user'; return result; }
  if (prefs.events[payload.event] === false) { result.reason = `event_${payload.event}_disabled`; return result; }

  if (isQuietNow(prefs.quietHours)) {
    if (!(prefs.quietHours.allowCritical && payload.severity === 'critical')) {
      result.reason = 'quiet_hours';
      return result;
    }
  }

  const within = await isWithinRateLimit(userId, prefs.rateLimit.maxPerHour);
  if (!within) { result.reason = 'rate_limited'; return result; }

  const subs = await prisma.pushSubscription.findMany({
    where: { clientNumber, userId, isActive: true },
  });
  if (subs.length === 0) { result.reason = 'no_active_devices'; return result; }

  const json = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? '/',
    actions: payload.actions ?? [],
    tag: payload.tag,
    severity: payload.severity ?? 'medium',
    data: payload.data ?? {},
    event: payload.event,
  });

  for (const s of subs) {
    result.attempted += 1;
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dhKey, auth: s.authKey } },
        json,
        { TTL: 60 * 60 * 24 }, // 24h
      );
      result.delivered += 1;
      await prisma.pushSubscription.update({
        where: { id: s.id },
        data: { lastPushAt: new Date(), failureCount: 0, lastError: null },
      });
    } catch (err: any) {
      result.failed += 1;
      const status = (err?.statusCode ?? 0) as number;
      // 410 Gone / 404 Not Found = subscription is dead. Soft-delete so
      // we don't keep retrying (and pile up failure_count forever).
      if (status === 404 || status === 410) {
        await prisma.pushSubscription.update({
          where: { id: s.id },
          data: { isActive: false, lastError: `expired (${status})` },
        });
      } else {
        await prisma.pushSubscription.update({
          where: { id: s.id },
          data: { failureCount: { increment: 1 }, lastError: String(err?.message ?? err).slice(0, 500) },
        });
      }
    }
  }

  return result;
}

/** Send to every admin in a tenant (kill-switch state changes, anomaly alerts). */
export async function sendToTenantAdmins(
  clientNumber: string, payload: PushPayload,
): Promise<SendResult & { recipients: number }> {
  const admins = await prisma.user.findMany({
    where: {
      clientNumber, isActive: true,
      OR: [{ userType: 'AD' }, { userType: 'SA' }],
    },
    select: { id: true },
  });
  const agg: SendResult & { recipients: number } = {
    attempted: 0, delivered: 0, failed: 0, skipped: 0, recipients: admins.length,
  };
  for (const a of admins) {
    const r = await sendToUser(clientNumber, a.id, payload);
    agg.attempted += r.attempted;
    agg.delivered += r.delivered;
    agg.failed += r.failed;
    agg.skipped += r.skipped;
  }
  return agg;
}

// ─── helpers ─────────────────────────────────────────────────────

function isQuietNow(qh: PushPrefs['quietHours']): boolean {
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: qh.timezone, hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const hhmm = fmt.format(now); // "HH:MM"
    const cur = toMinutes(hhmm);
    const start = toMinutes(qh.start);
    const end = toMinutes(qh.end);
    if (start === end) return false;
    if (start < end) return cur >= start && cur < end;
    // Crosses midnight
    return cur >= start || cur < end;
  } catch {
    return false;
  }
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  return (h || 0) * 60 + (m || 0);
}

async function isWithinRateLimit(userId: number, maxPerHour: number): Promise<boolean> {
  if (maxPerHour <= 0) return true;
  const cutoff = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await prisma.pushSubscription.aggregate({
    where: { userId, lastPushAt: { gte: cutoff } },
    _count: { lastPushAt: true },
  });
  return (recent._count.lastPushAt ?? 0) < maxPerHour;
}
