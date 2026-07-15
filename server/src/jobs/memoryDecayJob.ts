import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('memory-decay');

/**
 * C5 (2026-07-08) — memory decay / confidence aging.
 *
 * Nothing enforced UserMemory.expiresAt and confidence never changed after
 * being written, so stale inferred preferences ossified — the brain could
 * never "change its mind" the way a human impression fades.
 *
 * Daily pass, three steps:
 *   1. EXPIRE  — rows past expiresAt are deleted (deletion is the
 *      established archival pattern here; dismissMemory deletes too).
 *   2. DECAY   — UNCONFIRMED INFERRED memories untouched for 30+ days lose
 *      confidence multiplicatively (×0.9 per pass over the stale set).
 *      Explicit memories and anything the user confirmed NEVER decay —
 *      the user said so; only inferences fade.
 *   3. FLOOR   — inferred rows whose confidence fell below 0.2 are removed
 *      entirely; a preference we barely believe anymore must not keep
 *      biasing prompts.
 *
 * Conflict resolution is structural already: user_memories is UNIQUE on
 * (userId, key) and recordInferredMemory upserts, so the newer signal
 * always owns the key. Decay handles the remaining case — an old signal
 * nobody overwrote.
 *
 * Confidence-weighted injection: renderMemoriesBlock reads these rows;
 * as confidence sinks the row eventually drops out at the floor. (Explicit
 * per-row weighting inside the prompt block is a follow-up.)
 */

export const DECAY_FACTOR = 0.9;
export const CONFIDENCE_FLOOR = 0.2;
export const STALE_AFTER_DAYS = 30;

export interface DecayResult {
  expired: number;
  decayed: number;
  floored: number;
  errors: number;
}

export async function decayUserMemories(now: Date = new Date()): Promise<DecayResult> {
  const result: DecayResult = { expired: 0, decayed: 0, floored: 0, errors: 0 };

  // 1. Expire
  try {
    const r = await prisma.userMemory.deleteMany({
      where: { expiresAt: { not: null, lt: now } },
    });
    result.expired = r.count;
  } catch (err: any) {
    result.errors += 1;
    log.warn('expiry pass failed', { err: err?.message });
  }

  // 2. Decay — raw SQL because Prisma updateMany can't express
  //    column-multiplication. Parameterized cutoff; constants are
  //    module-level numbers, not user input.
  try {
    const staleCutoff = new Date(now.getTime() - STALE_AFTER_DAYS * 24 * 3600_000);
    const n = await prisma.$executeRawUnsafe(
      `UPDATE user_memories
          SET confidence = confidence * ${DECAY_FACTOR}
        WHERE source = 'inferred'
          AND confirmed_at IS NULL
          AND updated_at < $1`,
      staleCutoff,
    );
    result.decayed = Number(n) || 0;
  } catch (err: any) {
    result.errors += 1;
    log.warn('decay pass failed', { err: err?.message });
  }

  // 3. Floor
  try {
    const r = await prisma.userMemory.deleteMany({
      where: { source: 'inferred', confirmedAt: null, confidence: { lt: CONFIDENCE_FLOOR } },
    });
    result.floored = r.count;
  } catch (err: any) {
    result.errors += 1;
    log.warn('floor pass failed', { err: err?.message });
  }

  if (result.expired || result.decayed || result.floored) {
    log.info('memory decay pass complete', result as any);
  }
  return result;
}
