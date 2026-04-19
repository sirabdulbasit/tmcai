import { getRedis } from '../../utils/redisClient';
import { REDIS_KEY_PATTERNS } from '../../config/redis';
import prisma from '../../db/prisma';

export interface KillSwitchState {
  active: boolean;
  triggeredAt?: string;
  triggeredBy?: number;
  reason?: string;
  tenantId: string;
}

interface TriggerInput {
  tenantId: string;
  triggeredBy: number;
  reason: string;
}

export async function isActive(tenantId: string): Promise<boolean> {
  const key = REDIS_KEY_PATTERNS.killSwitch(tenantId);
  const result = await getRedis().exists(key);
  return result === 1;
}

export async function getState(tenantId: string): Promise<KillSwitchState> {
  const key = REDIS_KEY_PATTERNS.killSwitch(tenantId);
  const raw = await getRedis().get(key);
  if (!raw) return { active: false, tenantId };
  try {
    const parsed = JSON.parse(raw);
    return { active: true, tenantId, ...parsed };
  } catch {
    return { active: true, tenantId };
  }
}

export async function trigger(input: TriggerInput): Promise<KillSwitchState> {
  const key = REDIS_KEY_PATTERNS.killSwitch(input.tenantId);
  const state = {
    triggeredAt: new Date().toISOString(),
    triggeredBy: input.triggeredBy,
    reason: input.reason,
  };
  await getRedis().set(key, JSON.stringify(state));
  await auditEvent(input.tenantId, input.triggeredBy, 'kill_switch_triggered', input.reason);
  return { active: true, tenantId: input.tenantId, ...state };
}

export async function release(tenantId: string, releasedBy: number, reason: string): Promise<KillSwitchState> {
  const key = REDIS_KEY_PATTERNS.killSwitch(tenantId);
  await getRedis().del(key);
  await auditEvent(tenantId, releasedBy, 'kill_switch_released', reason);
  return { active: false, tenantId };
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
