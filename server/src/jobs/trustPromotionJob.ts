import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('trust-promotion');

/**
 * D2 (2026-07-09) — trust promotion proposals.
 *
 * Autonomy levels were static: nothing ever suggested graduating an action
 * type from supervised toward full_auto as the user's trust demonstrably
 * built. The product vision is trust that BUILDS — without promotion,
 * autonomy never graduates.
 *
 * Daily pass per (tenant, user, actionType) with recent approval-gated
 * activity: if the last PROMOTION_STREAK approval-gated actions of that
 * type ALL completed (none rejected), and the user isn't already on
 * full_auto, Brain PROPOSES promotion via the prompt queue.
 *
 * Deliberately conservative:
 *  - NEVER auto-promotes. The only side effect is a queued proposal; the
 *    user flips the level in Settings themselves. (Deterministic safety —
 *    autonomy changes are always explicit user action.)
 *  - dedupKey `trust-promo:<actionType>` — the queue's non-terminal dedup
 *    means one open proposal per action type at a time; declining or
 *    ignoring won't cause a re-nag until the prompt reaches a terminal
 *    state and a fresh streak accumulates.
 *  - The proposal text is a bracketed SYSTEM message, not prose pretending
 *    to be Brain: this is governance machinery reporting a statistic, the
 *    same class as "[session ended]".
 */

export const PROMOTION_STREAK = 10;
const LOOKBACK_DAYS = 90;

export interface PromotionResult {
  scanned: number;
  proposed: number;
  errors: number;
}

export async function proposeTrustPromotions(now: Date = new Date()): Promise<PromotionResult> {
  const result: PromotionResult = { scanned: 0, proposed: 0, errors: 0 };
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 3600_000);

  let candidates: Array<{ clientNumber: string; userId: number; actionType: string }> = [];
  try {
    const grouped = await prisma.agentAction.groupBy({
      by: ['clientNumber', 'userId', 'actionType'],
      where: { requiresApproval: true, createdAt: { gt: since } },
      _count: { _all: true },
    } as any);
    candidates = (grouped as any[])
      .filter((g) => g._count._all >= PROMOTION_STREAK)
      .map((g) => ({ clientNumber: g.clientNumber, userId: g.userId, actionType: g.actionType }));
  } catch (err: any) {
    log.warn('candidate scan failed', { err: err?.message });
    result.errors += 1;
    return result;
  }

  for (const c of candidates) {
    result.scanned += 1;
    try {
      // Newest-first streak: every one of the last N approval-gated actions
      // of this type must have completed. Any rejection/error breaks trust.
      const recent = await prisma.agentAction.findMany({
        where: {
          clientNumber: c.clientNumber, userId: c.userId,
          actionType: c.actionType, requiresApproval: true,
        },
        orderBy: { createdAt: 'desc' },
        take: PROMOTION_STREAK,
        select: { status: true },
      });
      if (recent.length < PROMOTION_STREAK) continue;
      if (!recent.every((r) => r.status === 'done' || r.status === 'approved')) continue;

      const { getAutomationLevel } = await import('../services/brainConfigService');
      const level = await getAutomationLevel(c.userId);
      if (level === 'full_auto') continue; // nothing left to graduate to

      const { enqueueBrainPrompt } = await import('../services/brainPrompts/brainPromptQueueService');
      const r = await enqueueBrainPrompt({
        userId: c.userId,
        clientNumber: c.clientNumber,
        criticality: 'routine',
        dedupKey: `trust-promo:${c.actionType}`,
        sideEffect: { kind: 'noop' },
        question: `[trust proposal] You've approved the last ${PROMOTION_STREAK} '${c.actionType}' actions without rejecting any. If you want Brain to run '${c.actionType}' with more autonomy, raise the automation level in Settings → Brain → Automation. Nothing changes unless you change it.`,
        metadata: { source: 'trust_promotion', actionType: c.actionType, streak: PROMOTION_STREAK, currentLevel: level },
      });
      if (r.status !== 'duplicate') result.proposed += 1;
    } catch (err: any) {
      result.errors += 1;
      log.warn('promotion proposal failed', { actionType: c.actionType, userId: c.userId, err: err?.message });
    }
  }

  if (result.proposed > 0) log.info('trust promotions proposed', result as any);
  return result;
}
