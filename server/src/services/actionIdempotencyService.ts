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

// ─── Types ──────────────────────────────────────────────────────

export type ActionType =
  | 'REPLY' | 'DELEGATE' | 'SCHEDULE' | 'CLOSE'
  | 'ERP' | 'OKR_ALERT' | 'DELEGATE_MSG';

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

export async function withIdempotency<T>(
  params: IdempotencyKeyParams,
  action: () => Promise<T>,
): Promise<T> {
  const key = generateKey(params);

  // Check if this exact action was already executed
  const cached = await checkKey(key);
  if (cached !== null) return cached as T;

  // Execute the action
  const result = await action();

  // Store the result for future duplicate detection
  await storeKey(key, result, params.userId, params.clientNumber, params.actionType);

  return result;
}
