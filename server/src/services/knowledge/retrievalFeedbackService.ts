/**
 * Retrieval Feedback Service — per-(user, page) cumulative feedback that
 * adjusts vector-similarity rankings.
 *
 * Three callers feed the signal:
 *
 *   1. 👍 on a chat answer (rating='up') →
 *      recordPositiveSignal(userId, citedPageIds)
 *      "These pages were the right ones for this query."
 *
 *   2. 👎 on a chat answer with diagnosis category in
 *      {wrong_source, retrieval_miss} →
 *      recordNegativeSignal(userId, citedPageIds)
 *      "These pages were the wrong source for this query."
 *      Other categories (wrong_tone, too_verbose, hallucination) DON'T
 *      penalise retrieval — those are composer issues. Penalising the
 *      pages would tell Brain "stop retrieving them" when the page was
 *      correct and only the way Brain wrote about them was off.
 *
 *   3. 👍 on a RETRY chat answer →
 *      recordPositiveSignal(userId, citedPageIds)
 *      Strong positive signal: the diagnosis steered Brain to better
 *      pages, and the user confirmed.
 *
 * Smoothed boost (computed in getBoosts):
 *
 *   net    = positive - negative
 *   boost  = clamp(net / (positive + negative + PRIOR_WEIGHT), -CAP, +CAP)
 *
 *   PRIOR_WEIGHT = 5   — small samples → boost ≈ 0; needs evidence to
 *                        move the needle.
 *   CAP          = 0.4 — vector signal stays dominant; feedback steers,
 *                        doesn't override.
 *
 * Re-ranker integration (brainComposer.rankAndTrim):
 *
 *   adjustedScore = vectorScore + boost   (additive — vectorScore is
 *                                           already in 0..1 range)
 *
 * Additive (vs multiplicative) keeps the boost predictable and on the
 * same scale as the existing pageType bonuses (+0.10 for entity_person,
 * +0.05 for project, etc.). A maxed-out positive page gets the same
 * lift as the entity_person bonus.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('retrieval-feedback');

const PRIOR_WEIGHT = 5;
const CAP = 0.4;

export async function recordPositiveSignal(
  clientNumber: string,
  userId: number,
  pageIds: string[],
): Promise<void> {
  if (!pageIds.length) return;
  const now = new Date();
  for (const pageId of pageIds) {
    try {
      await prisma.retrievalFeedback.upsert({
        where: { userId_pageId: { userId, pageId } },
        create: {
          clientNumber, userId, pageId,
          positiveUses: 1, lastPositiveAt: now,
        },
        update: {
          positiveUses: { increment: 1 },
          lastPositiveAt: now,
          updatedAt: now,
        },
      });
    } catch (err: any) {
      log.warn('positive signal upsert failed', { userId, pageId, err: err.message });
    }
  }
}

export async function recordNegativeSignal(
  clientNumber: string,
  userId: number,
  pageIds: string[],
): Promise<void> {
  if (!pageIds.length) return;
  const now = new Date();
  for (const pageId of pageIds) {
    try {
      await prisma.retrievalFeedback.upsert({
        where: { userId_pageId: { userId, pageId } },
        create: {
          clientNumber, userId, pageId,
          negativeUses: 1, lastNegativeAt: now,
        },
        update: {
          negativeUses: { increment: 1 },
          lastNegativeAt: now,
          updatedAt: now,
        },
      });
    } catch (err: any) {
      log.warn('negative signal upsert failed', { userId, pageId, err: err.message });
    }
  }
}

/**
 * Fetch boost values for a set of candidate pageIds. Returns a Map<pageId,
 * boost> where boost ∈ [-0.4, +0.4]. Pages with no feedback row return
 * 0 (no entry in the map). Caller should default to 0 on miss.
 *
 * Single query — bounded by the candidate set size (typically ≤ 40).
 */
export async function getBoosts(
  userId: number,
  pageIds: string[],
): Promise<Map<string, number>> {
  if (!pageIds.length) return new Map();
  const rows = await prisma.retrievalFeedback.findMany({
    where: { userId, pageId: { in: pageIds } },
    select: { pageId: true, positiveUses: true, negativeUses: true },
  }).catch(() => [] as any[]);
  const out = new Map<string, number>();
  for (const r of rows) {
    const boost = computeBoost(r.positiveUses, r.negativeUses);
    if (boost !== 0) out.set(r.pageId, boost);
  }
  return out;
}

export function computeBoost(positive: number, negative: number): number {
  if (positive === 0 && negative === 0) return 0;
  const net = positive - negative;
  const denom = positive + negative + PRIOR_WEIGHT;
  const raw = net / denom;
  if (raw > CAP) return CAP;
  if (raw < -CAP) return -CAP;
  // Round to 3 decimals so log messages and test assertions are stable.
  return Math.round(raw * 1000) / 1000;
}

/** Aggregate "what is Brain learning?" — used by the Day Brief
 *  "What Brain learned this week" panel and admin diagnostics. Returns
 *  top-N best and worst pages by boost. */
export async function getTopAndBottom(
  clientNumber: string,
  userId: number,
  limit = 5,
) {
  const rows = await prisma.retrievalFeedback.findMany({
    where: { clientNumber, userId },
    select: {
      pageId: true, positiveUses: true, negativeUses: true,
      lastPositiveAt: true, lastNegativeAt: true,
    },
  }).catch(() => [] as any[]);
  const scored = rows.map((r) => ({
    pageId: r.pageId,
    pos: r.positiveUses, neg: r.negativeUses,
    boost: computeBoost(r.positiveUses, r.negativeUses),
    lastPositiveAt: r.lastPositiveAt,
    lastNegativeAt: r.lastNegativeAt,
  })).filter((r) => r.boost !== 0);
  scored.sort((a, b) => b.boost - a.boost);
  return {
    top:    scored.slice(0, limit),
    bottom: scored.slice(-limit).reverse(),
  };
}
