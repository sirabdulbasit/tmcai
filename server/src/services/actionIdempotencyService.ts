/**
 * MyOS Gap 3 — Action Idempotency Service
 *
 * Wraps every action execution so retries never produce duplicate side effects.
 * Cloud infrastructure retries, network blips, double-clicks — all handled.
 * Always active (no feature flag needed — this is reliability infrastructure).
 *
 * Key generation: SHA-256(clientNumber:userId:actionType:referenceId:disambiguator)
 * Storage: ActionIdempotencyLog table with 7-day TTL
 * Cleanup: daily 3am cron via schedulerService
 */

import crypto from 'crypto';
import prisma from '../db/prisma';
import { getRedis } from '../utils/redisClient';
import { REDIS_KEY_PATTERNS, REDIS_TTL } from '../config/redis';

// ─── Types ──────────────────────────────────────────────────────

export type ActionType =
  | 'REPLY' | 'DELEGATE' | 'SCHEDULE' | 'CLOSE'
  | 'ERP' | 'OKR_ALERT' | 'DELEGATE_MSG'
  // Sprint 3 additions: Brain's full action set so the composer can
  // dispatch through withIdempotency() — prevents duplicate sends on
  // webhook retries, pm2 restarts, user double-taps.
  | 'BRAIN_SCHEDULE_MEETING'
  | 'BRAIN_RESCHEDULE_MEETING'
  | 'BRAIN_CANCEL_MEETING'
  | 'BRAIN_SEND_EMAIL'
  | 'BRAIN_NOTIFY_WA'
  | 'BRAIN_DELEGATE_OPEN_ITEM'
  | 'BRAIN_ADD_OPEN_ITEM';

export interface IdempotencyKeyParams {
  actionType: ActionType;
  clientNumber: string;
  userId: number;
  referenceId: string;       // itemId, threadId, erpRecordId, etc.
  disambiguator?: string;    // delegateeEmail, proposedDate, weekNumber — prevents collisions
}

// ─── Key generation ─────────────────────────────────────────────

export function generateKey(params: IdempotencyKeyParams): string {
  const raw = [
    params.clientNumber,
    params.userId.toString(),
    params.actionType,
    params.referenceId,
    params.disambiguator ?? '',
  ].join(':');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// ─── Check if key already exists (returns cached result or null) ─

export async function checkKey(key: string): Promise<unknown | null> {
  const row = await prisma.actionIdempotencyLog.findUnique({
    where: { idempotencyKey: key },
  });
  if (!row) return null;
  if (row.expiresAt < new Date()) {
    // Expired — treat as not found, cleanup will remove it
    return null;
  }
  return row.result;
}

// ─── Store key with result (7-day TTL default) ──────────────────

export async function storeKey(
  key: string,
  result: unknown,
  userId: number,
  clientNumber: string,
  actionType: string,
  ttlDays = 7,
): Promise<void> {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + ttlDays);

  await prisma.actionIdempotencyLog.upsert({
    where: { idempotencyKey: key },
    create: {
      idempotencyKey: key,
      clientNumber,
      userId,
      actionType,
      result: result as any,
      expiresAt,
    },
    update: {
      result: result as any,
      expiresAt,
    },
  });
}

// ─── Cleanup expired keys (called by daily 3am cron) ────────────

export async function cleanupExpiredKeys(): Promise<number> {
  const result = await prisma.actionIdempotencyLog.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}

// ─── Helper: wrap any action function with idempotency check ────
// Two-layer: Redis SETNX (distributed lock, 24h TTL) + SQL audit row (7d TTL)

export async function withIdempotency<T>(
  params: IdempotencyKeyParams,
  action: () => Promise<T>,
  opts: {
    /** B3 (2026-07-09): a cached success is only as good as the system of
     *  record it claims to describe. When provided, a cache hit is
     *  re-confirmed (e.g. handler.confirm() against the stored provider
     *  message id) before being returned; a false re-confirmation treats
     *  the cache as a miss and re-executes. */
    reconfirm?: (cached: T) => Promise<boolean>;
    /** B3: which results deserve caching. Previously EVERYTHING was cached,
     *  including {ok:false} outcomes — so a transient failure blocked all
     *  retries for 7 days by replaying the stale failure. Return false to
     *  leave the key unset so a retry can actually retry. */
    shouldCache?: (result: T) => boolean;
  } = {},
): Promise<T> {
  const key = generateKey(params);

  // Layer 1: SQL audit — if a previous successful run stored its result, return it
  const cached = await checkKey(key);
  if (cached !== null) {
    if (!opts.reconfirm) return cached as T;
    const stillHolds = await opts.reconfirm(cached as T).catch(() => false);
    if (stillHolds) return cached as T;
    // Side effect can no longer be verified — fall through and re-execute.
    console.warn(`[idempotency] cached result failed re-confirmation — re-executing key ${key.slice(0, 16)}…`);
  }

  // Layer 2: Redis distributed lock — prevents two processes from both passing
  // the SQL check simultaneously and double-executing.
  const redisKey = REDIS_KEY_PATTERNS.idempotency(params.clientNumber, key);
  const ttlSec = REDIS_TTL.idempotencyHours * 3600;
  const redis = getRedis();
  let acquired = false;
  try {
    const ok = await redis.set(redisKey, 'inflight', 'EX', ttlSec, 'NX');
    acquired = ok === 'OK';
  } catch (err: any) {
    // Redis unreachable → fall back to SQL-only mode (degraded but correct for single-process)
    console.warn(`[idempotency] redis unavailable, falling back to SQL-only: ${err.message}`);
  }

  if (!acquired) {
    // Another worker has the lock — wait briefly then re-check the SQL cache
    await new Promise((r) => setTimeout(r, 250));
    const afterWait = await checkKey(key);
    if (afterWait !== null) return afterWait as T;
    throw new Error(`idempotency lock busy for key ${key.slice(0, 16)}… — retry later`);
  }

  try {
    const result = await action();
    if (opts.shouldCache && !opts.shouldCache(result)) {
      // Uncacheable outcome (typically ok:false) — release the lock so a
      // retry can proceed, and store nothing.
      try { await redis.del(redisKey); } catch { /* ignore */ }
      return result;
    }
    await storeKey(key, result, params.userId, params.clientNumber, params.actionType);
    // Upgrade the Redis value from "inflight" to the result so next-layer callers can skip
    try {
      await redis.set(redisKey, JSON.stringify({ done: true, ts: Date.now() }), 'EX', ttlSec);
    } catch {
      /* ignore — SQL is the source of truth */
    }
    return result;
  } catch (err) {
    // Release the Redis lock on failure so retries can proceed
    try {
      await redis.del(redisKey);
    } catch {
      /* ignore */
    }
    throw err;
  }
}
