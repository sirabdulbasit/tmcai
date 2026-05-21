/**
 * clarificationMemoryService — typed records of "Brain asked X,
 * user said Y" → so Brain doesn't have to ask the same thing twice.
 *
 * Phase 1 of reasoning-first refactor (2026-05-22). This is the
 * load-bearing piece of "Brain learns by asking" — the asking IS
 * the learning, not a separate post-hoc analysis.
 *
 * Lifecycle:
 *   1. Reasoning step decides {decision:'ask', question:{...},
 *      slot_being_filled:'X'} — Brain emits a clarifying question.
 *   2. User answers next turn.
 *   3. The composer captures the resolution and writes a row here.
 *   4. Future turns: BEFORE reasoning decides to ask, lookup if a
 *      similar question (same slot, similar context) was already
 *      answered. If yes, apply the resolution; if no, ask.
 *
 * questionHash: SHA-256 of normalize(slot_being_filled + context_signature).
 * context_signature: stable tokens from the current turn's context
 *   (e.g., person name + topic + action_kind) so similar contexts
 *   match the same memory.
 */
import prisma from '../../db/prisma';
import crypto from 'crypto';

export interface ClarificationRecord {
  id: string;
  questionPattern: string;
  questionHash: string;
  slotBeingFilled: string;
  resolutionValue: unknown;
  resolutionContext: unknown;
  usedCount: number;
  lastUsedAt: Date;
  createdAt: Date;
}

/** Compute the stable hash for a (slot, context) pair. Two semantically
 *  similar clarifications produce the same hash so the lookup hits. */
export function computeQuestionHash(slotBeingFilled: string, contextTokens: string[]): string {
  const norm = [slotBeingFilled.toLowerCase().trim(), ...contextTokens.map((t) => t.toLowerCase().trim())]
    .filter(Boolean)
    .sort()
    .join('|');
  return crypto.createHash('sha256').update(norm).digest('hex');
}

/** Look up a resolution for a specific slot + context. Returns null
 *  when no matching memory exists; the reasoning step then decides to
 *  ask the user. Bumps usedCount + lastUsedAt on hit. */
export async function findResolution(args: {
  userId: number;
  slotBeingFilled: string;
  contextTokens: string[];
}): Promise<ClarificationRecord | null> {
  const hash = computeQuestionHash(args.slotBeingFilled, args.contextTokens);
  const row = await (prisma as any).clarificationMemory.findFirst({
    where: {
      userId: args.userId,
      questionHash: hash,
    },
  });
  if (!row) return null;
  // Bump usage — fire-and-forget.
  void (prisma as any).clarificationMemory.update({
    where: { id: row.id },
    data: { usedCount: { increment: 1 }, lastUsedAt: new Date() },
  }).catch(() => undefined);
  return toRecord(row);
}

/** Record a new clarification resolution. Called by the composer
 *  when the user answers a clarify question Brain just asked.
 *  Idempotent on (userId, questionHash). */
export async function recordResolution(args: {
  clientNumber: string;
  userId: number;
  questionPattern: string;
  slotBeingFilled: string;
  contextTokens: string[];
  resolutionValue: unknown;
  resolutionContext?: unknown;
}): Promise<ClarificationRecord> {
  const hash = computeQuestionHash(args.slotBeingFilled, args.contextTokens);
  const existing = await (prisma as any).clarificationMemory.findFirst({
    where: { userId: args.userId, questionHash: hash },
  });
  if (existing) {
    const row = await (prisma as any).clarificationMemory.update({
      where: { id: existing.id },
      data: {
        resolutionValue: args.resolutionValue as any,
        ...(args.resolutionContext !== undefined ? { resolutionContext: args.resolutionContext as any } : {}),
        usedCount: { increment: 1 },
        lastUsedAt: new Date(),
      },
    });
    return toRecord(row);
  }
  const row = await (prisma as any).clarificationMemory.create({
    data: {
      clientNumber: args.clientNumber,
      userId: args.userId,
      questionPattern: args.questionPattern,
      questionHash: hash,
      slotBeingFilled: args.slotBeingFilled,
      resolutionValue: args.resolutionValue as any,
      resolutionContext: (args.resolutionContext ?? null) as any,
    },
  });
  return toRecord(row);
}

/** Forget a resolution — when the user corrects ("no, I mean the
 *  OTHER Asad") or when the cached resolution becomes stale. */
export async function forgetResolution(args: {
  userId: number;
  questionHash: string;
}): Promise<void> {
  await (prisma as any).clarificationMemory.deleteMany({
    where: { userId: args.userId, questionHash: args.questionHash },
  });
}

/** List recent clarifications for a user — Settings UI surface so
 *  the user can review what Brain has learned. */
export async function listRecentClarifications(userId: number, limit = 50): Promise<ClarificationRecord[]> {
  const rows = await (prisma as any).clarificationMemory.findMany({
    where: { userId },
    orderBy: { lastUsedAt: 'desc' },
    take: limit,
  });
  return rows.map(toRecord);
}

function toRecord(row: any): ClarificationRecord {
  return {
    id: row.id,
    questionPattern: row.questionPattern,
    questionHash: row.questionHash,
    slotBeingFilled: row.slotBeingFilled,
    resolutionValue: row.resolutionValue,
    resolutionContext: row.resolutionContext ?? null,
    usedCount: row.usedCount,
    lastUsedAt: row.lastUsedAt,
    createdAt: row.createdAt,
  };
}
