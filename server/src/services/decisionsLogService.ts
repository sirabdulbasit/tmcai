/**
 * MyOS Gap 5a — Decisions Log Service
 *
 * Auto-called by actionExecutionService after every user decision.
 * Zero user effort — happens silently.
 *
 * Feature flag: ff_decisions_log
 */

import prisma from '../db/prisma';

// ─── Types ──────────────────────────────────────────────────────

export interface DecisionParams {
  userId: number;
  clientNumber: string;
  sessionType: 'morning_briefing' | 'intraday' | 'auto_action';
  itemType: string;
  entityId?: string;
  connectorSlug?: string;
  suggestedAction: string;
  userDecision: 'approved' | 'overrode' | 'delegated' | 'snoozed' | 'dismissed';
  actionTaken: string;
  isMatch: boolean;
  overrideReason?: string;
  responseTimeMs?: number;
  openItemId: string;
}

// ─── Append decision ────────────────────────────────────────────

export async function appendDecision(params: DecisionParams) {
  return prisma.decisionLog.create({ data: params as any });
}

// ─── Read queries ───────────────────────────────────────────────

export async function getByOpenItemId(openItemId: string, userId: number) {
  return prisma.decisionLog.findFirst({
    where: { openItemId, userId },
  });
}

export async function getLast30Days(userId: number, clientNumber: string) {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return prisma.decisionLog.findMany({
    where: { userId, clientNumber, createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getLast7Days(userId: number, clientNumber: string) {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return prisma.decisionLog.findMany({
    where: { userId, clientNumber, createdAt: { gte: since } },
  });
}

// ─── Outcome assessment (daily 2am job) ─────────────────────────

export async function assessOutcomesForAllTenants(): Promise<void> {
  const windowStart = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  const windowEnd = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const pending = await prisma.decisionLog.findMany({
    where: { outcome: null, createdAt: { gte: windowStart, lte: windowEnd } },
  });

  for (const decision of pending) {
    if (!decision.openItemId) continue;
    const item = await prisma.openItem.findUnique({
      where: { id: decision.openItemId },
    });
    const outcome = deriveOutcome(item);
    await prisma.decisionLog.update({
      where: { id: decision.id },
      data: { outcome },
    });
  }
}

function deriveOutcome(item: any): 'positive' | 'negative' | 'neutral' {
  if (!item) return 'neutral';
  if (item.status === 'done') return 'positive';
  if (item.status === 'overdue' || item.priority === 'critical') return 'negative';
  return 'neutral';
}
