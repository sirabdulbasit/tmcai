/**
 * Per-tenant kill switch.
 *
 * Storage strategy: dual-write to Redis (fast path) AND `system_config`
 * (durable). Reads check Redis first; on Redis miss we fall back to
 * `system_config` and rehydrate Redis. This prevents the silent-release
 * failure mode where a Redis flush releases the switch without any
 * admin action — the durable copy keeps the switch engaged across
 * cache failures, restarts, and infra changes.
 *
 * Audit: every flip writes an `audit_logs` row. A list of recent flips
 * is exposed via getHistory() for the admin UI.
 *
 * Failure semantics:
 *   - Triggers fail SAFE: if EITHER Redis OR system_config write fails,
 *     the trigger is reported as failed and the caller can retry.
 *   - Reads fail OPEN at the HTTP middleware (existing behaviour) and at
 *     the executor boundary (action handlers proceed). This is a
 *     deliberate trade-off — a check-failure during a Redis outage
 *     should not freeze every action across every tenant.
 */
import { getRedis } from '../../utils/redisClient';
import { REDIS_KEY_PATTERNS } from '../../config/redis';
import { getConfig, setConfig, deleteConfig } from '../configService';
import prisma from '../../db/prisma';

const CONFIG_KEY = 'kill_switch_state';

export interface KillSwitchState {
  active: boolean;
  triggeredAt?: string;
  triggeredBy?: number;
  reason?: string;
  tenantId: string;
}

export interface KillSwitchHistoryEntry {
  event: 'kill_switch_triggered' | 'kill_switch_released';
  reason: string;
  byUserId: number | null;
  at: Date;
}

interface TriggerInput {
  tenantId: string;
  triggeredBy: number;
  reason: string;
}

interface InternalStatePayload {
  triggeredAt: string;
  triggeredBy: number;
  reason: string;
}

/** Fast check used by middleware + executor on the hot path. */
export async function isActive(tenantId: string): Promise<boolean> {
  // Redis hit — fast path.
  try {
    const exists = await getRedis().exists(REDIS_KEY_PATTERNS.killSwitch(tenantId));
    if (exists === 1) return true;
  } catch {
    // Redis unavailable; check durable store
  }
  // Redis miss OR Redis down — consult durable store. Rehydrate Redis on
  // success so subsequent reads stay on the fast path.
  const persisted = await loadFromConfig(tenantId);
  if (persisted) {
    try {
      await getRedis().set(REDIS_KEY_PATTERNS.killSwitch(tenantId), JSON.stringify(persisted));
    } catch { /* rehydrate is best-effort */ }
    return true;
  }
  return false;
}

/** Full state for the admin status route. */
export async function getState(tenantId: string): Promise<KillSwitchState> {
  // Try Redis first
  try {
    const raw = await getRedis().get(REDIS_KEY_PATTERNS.killSwitch(tenantId));
    if (raw) {
      try { return { active: true, tenantId, ...JSON.parse(raw) }; }
      catch { return { active: true, tenantId }; }
    }
  } catch { /* fall through to durable */ }
  const persisted = await loadFromConfig(tenantId);
  if (persisted) return { active: true, tenantId, ...persisted };
  return { active: false, tenantId };
}

export async function trigger(input: TriggerInput): Promise<KillSwitchState> {
  const payload: InternalStatePayload = {
    triggeredAt: new Date().toISOString(),
    triggeredBy: input.triggeredBy,
    reason: input.reason,
  };
  // Durable write FIRST so even if Redis succeeds and a crash follows,
  // the switch is still engaged on next boot.
  await setConfig(input.tenantId, CONFIG_KEY, JSON.stringify(payload), false, 'Kill switch state — triggered=true');
  try {
    await getRedis().set(REDIS_KEY_PATTERNS.killSwitch(input.tenantId), JSON.stringify(payload));
  } catch {
    // Redis miss is non-fatal for trigger — durable write succeeded so
    // isActive() will fall back to system_config and still return true.
  }
  await auditEvent(input.tenantId, input.triggeredBy, 'kill_switch_triggered', input.reason);
  return { active: true, tenantId: input.tenantId, ...payload };
}

export async function release(tenantId: string, releasedBy: number, reason: string): Promise<KillSwitchState> {
  // Delete durable record FIRST so even if Redis del fails, isActive()
  // won't rehydrate from a stale config row.
  await deleteConfig(tenantId, CONFIG_KEY);
  try {
    await getRedis().del(REDIS_KEY_PATTERNS.killSwitch(tenantId));
  } catch { /* non-fatal */ }
  await auditEvent(tenantId, releasedBy, 'kill_switch_released', reason);
  return { active: false, tenantId };
}

/**
 * Recent kill-switch history for the admin "what happened" panel. Reads
 * from audit_logs filtered by source='kill_switch'.
 */
export async function getHistory(tenantId: string, limit = 50): Promise<KillSwitchHistoryEntry[]> {
  const rows = await prisma.auditLog.findMany({
    where: { clientNumber: tenantId, source: 'kill_switch' },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 200),
    select: { userId: true, maskedQuery: true, createdAt: true },
  });
  return rows.map((r) => {
    const q = r.maskedQuery ?? '';
    const event = q.startsWith('kill_switch_triggered') ? 'kill_switch_triggered' : 'kill_switch_released';
    const reason = q.split(': ').slice(1).join(': ') || '(no reason)';
    return { event, reason, byUserId: r.userId, at: r.createdAt };
  });
}

// ─── internals ────────────────────────────────────────────────────

async function loadFromConfig(tenantId: string): Promise<InternalStatePayload | null> {
  const raw = await getConfig(tenantId, CONFIG_KEY).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch { return { triggeredAt: '', triggeredBy: 0, reason: '(corrupt)' }; }
}

async function auditEvent(clientNumber: string, userId: number, event: string, reason: string): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        clientNumber,
        maskedQuery: `${event}: ${reason}`.slice(0, 500),
        provider: 'system',
        responseTimeMs: 0,
        intentType: 'governance',
        source: 'kill_switch',
      },
    });
  } catch (err: any) {
    console.error('[killSwitch] audit write failed:', err.message);
  }
}
