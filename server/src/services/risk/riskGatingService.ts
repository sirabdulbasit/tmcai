import prisma from '../../db/prisma';
import { evaluate } from './riskEvaluator';

export type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH';

export interface RiskEntityContext {
  entity?: { id: string; type: string; name?: string | null } | null;
  relatedOpenItems?: Array<{ id: string; title: string; status: string; priority: string | null }>;
  relatedActions?: Array<{ id: number; actionType: string; status: string; riskTier: string | null; createdAt: Date }>;
  recentFeedEvents?: Array<{ id: string; sourceType: string; eventType: string | null; senderEmail: string | null; createdAt: Date }>;
}

export interface RiskEvaluation {
  tier: RiskTier;
  reasons: string[];
  policy: 'auto_execute' | 'confirm' | 'full_review';
  /** L3.1 — entity-context snapshot, populated only for HIGH tier (and optionally MEDIUM) */
  entityContext?: RiskEntityContext;
}

export interface ActionContext {
  clientNumber: string;
  userId: number;
  actionType: string;
  openItemId?: string;
  entityId?: string;
  payload?: Record<string, unknown>;
  /** monetary value in USD if action has one (deal, invoice, payment) */
  financialValueUsd?: number;
  /** is target a VIP/key-contact? */
  targetIsVip?: boolean;
  /** is target external (not in the tenant)? */
  targetIsExternal?: boolean;
}

export async function assess(ctx: ActionContext): Promise<RiskEvaluation> {
  const evaluation = await evaluate(ctx);
  const policy = tierToPolicy(evaluation.tier);
  const result: RiskEvaluation = { ...evaluation, policy };
  // L3.1 — HIGH tier must carry full entity context into the approval UI so the
  // approver can see the web of related items, not just this one action.
  if (evaluation.tier === 'HIGH') {
    result.entityContext = await loadEntityContext(ctx);
  }
  return result;
}

function tierToPolicy(tier: RiskTier): RiskEvaluation['policy'] {
  if (tier === 'LOW') return 'auto_execute';
  if (tier === 'MEDIUM') return 'confirm';
  return 'full_review';
}

/**
 * L3.1 — load related entities, open items, recent actions, and recent feed
 * events so the HIGH-tier approver sees the full blast-radius of the action.
 */
async function loadEntityContext(ctx: ActionContext): Promise<RiskEntityContext> {
  const out: RiskEntityContext = {};
  const where = { clientNumber: ctx.clientNumber };

  if (ctx.entityId) {
    try {
      const entity = await (prisma as any).entity?.findFirst?.({
        where: { ...where, id: ctx.entityId },
        select: { id: true, type: true, name: true },
      });
      out.entity = entity ?? null;
    } catch {
      out.entity = null;
    }

    try {
      out.relatedOpenItems = await prisma.openItem.findMany({
        where: { ...where, entityId: ctx.entityId as any },
        select: { id: true, title: true, status: true, priority: true },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
    } catch {
      out.relatedOpenItems = [];
    }
  }

  try {
    out.relatedActions = await prisma.agentAction.findMany({
      where: { ...where, OR: [{ openItemId: ctx.openItemId ?? undefined }, { entityId: ctx.entityId ?? undefined }] } as any,
      select: { id: true, actionType: true, status: true, riskTier: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
  } catch {
    out.relatedActions = [];
  }

  if (ctx.openItemId) {
    try {
      const item = await prisma.openItem.findFirst({
        where: { ...where, id: ctx.openItemId },
        select: { sourceFeedEventId: true },
      });
      if (item?.sourceFeedEventId) {
        const feedEvent = await prisma.feedEvent.findFirst({
          where: { ...where, id: item.sourceFeedEventId },
          select: { senderEmail: true },
        });
        if (feedEvent?.senderEmail) {
          out.recentFeedEvents = await prisma.feedEvent.findMany({
            where: { ...where, senderEmail: feedEvent.senderEmail },
            select: { id: true, sourceType: true, eventType: true, senderEmail: true, createdAt: true },
            orderBy: { createdAt: 'desc' },
            take: 5,
          });
        }
      }
    } catch {
      out.recentFeedEvents = [];
    }
  }

  return out;
}
