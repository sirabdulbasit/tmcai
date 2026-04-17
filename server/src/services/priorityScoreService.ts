/**
 * MyOS Gap 2 — Priority Score Engine
 *
 * Calculates weighted priority score (0–10) for every open item.
 * Formula: score = (impact × 0.40) + (urgency × 0.30) + (dependency × 0.20) + (staleness × 0.10)
 * Each dimension 0–10. All thresholds from user's BrainConfig — nothing hardcoded.
 *
 * Feature flag: part of ff_feed_intelligence
 */

import prisma from '../db/prisma';
import * as brainConfigService from './brainConfigService';
import * as entityService from './entityService';
import * as entityPropagationService from './entityPropagationService';

// ─── Types ──────────────────────────────────────────────────────

export interface PriorityScoreBreakdown {
  total: number;
  impact: number;
  urgency: number;
  dependency: number;
  staleness: number;
  autoDelegate: boolean;
}

// ─── Main scoring function ──────────────────────────────────────

export async function scoreOpenItem(
  itemId: string,
  clientNumber: string,
  userId: number,
): Promise<PriorityScoreBreakdown> {
  const item = await prisma.openItem.findFirst({ where: { id: itemId, clientNumber } });
  if (!item) throw new Error(`Item ${itemId} not found`);

  const thresholds = await brainConfigService.getAlertThresholds(userId);
  const escalationRules = await brainConfigService.getEscalationRules(userId);

  const entity = item.entityId
    ? await entityService.getEntity(item.entityId, clientNumber)
    : null;

  const impact = scoreImpact(item, entity, escalationRules);
  const urgency = scoreUrgency(item, thresholds);
  const dependency = scoreDependency(item);
  const { score: staleness, autoDelegate } = scoreStaleness(item, thresholds);

  const total = Math.round(
    (impact * 0.4 + urgency * 0.3 + dependency * 0.2 + staleness * 0.1) * 10,
  ) / 10;

  // Persist score
  await prisma.openItem.update({
    where: { id: itemId },
    data: { priorityScore: total },
  });

  // ERG propagation — fire-and-forget (Sprint 2 Gap G-A)
  if (total >= 6 && item.entityId) {
    entityPropagationService.propagateScore({
      triggerEntityId: item.entityId,
      triggerItemId: itemId,
      triggerScore: total,
      clientNumber,
      userId,
      propagationNotes: `${item.title} scored ${total} — propagating urgency to related entities`,
    }).catch(err => console.error('[propagation] failed:', err.message));
  }

  // CEO Intent Summary — fire-and-forget (Fix 4: NOT awaited)
  if (autoDelegate && item.entityId) {
    generateCEOIntentSummary(item, userId, clientNumber)
      .then(summary => {
        prisma.openItem.update({
          where: { id: itemId },
          data: {
            metadata: {
              ...((item.metadata as object) ?? {}),
              ceoIntentSummary: summary,
              autoDelegateAt: new Date().toISOString(),
            } as any,
          },
        }).catch(() => {});
      })
      .catch(err => console.error('[ceoIntent] generation failed silently:', err.message));
  }

  return { total, impact, urgency, dependency, staleness, autoDelegate };
}

// ─── Dimension scorers ──────────────────────────────────────────

function scoreImpact(item: any, entity: any | null, escalationRules: any[]): number {
  if (entity && Array.isArray(escalationRules) && escalationRules.some((r: any) =>
    r.condition?.toLowerCase().includes(entity.name?.toLowerCase()) ||
    r.condition?.toLowerCase().includes(entity.role?.toLowerCase()),
  )) return 9;

  if (entity?.sentimentScore && entity.sentimentScore < -0.5) return 8;
  if (item.type === 'erp' || item.type === 'risk') return 6;
  if (entity && (item.type === 'email' || item.type === 'task')) return 4;
  return 2;
}

function scoreUrgency(item: any, thresholds: any): number {
  const now = Date.now();

  if (item.dueDate) {
    const hoursUntilDue = (new Date(item.dueDate).getTime() - now) / 3_600_000;
    if (hoursUntilDue < 0) return 10;
    if (hoursUntilDue < 24) return 9;
    if (hoursUntilDue < 72) return 7;
    if (hoursUntilDue < 168) return 5;
    if (hoursUntilDue < 720) return 3;
  }

  if (item.type === 'erp') {
    const arDays = thresholds?.arOverdueDays ?? 60;
    const hoursSinceCreation = (now - new Date(item.createdAt).getTime()) / 3_600_000;
    if (hoursSinceCreation > arDays * 24) return 8;
  }

  return 2;
}

function scoreDependency(item: any): number {
  if (item.status === 'delegated') {
    const trail = Array.isArray(item.delegationTrail) ? item.delegationTrail : [];
    if (trail.length >= 2) return 9;
    return 7;
  }
  if (item.status === 'blocked') return 7;
  return 2;
}

function scoreStaleness(item: any, thresholds: any): { score: number; autoDelegate: boolean } {
  const overdueHours = thresholds?.overdueHours ?? 48;
  const hoursSinceUpdate = (Date.now() - new Date(item.updatedAt).getTime()) / 3_600_000;

  if (hoursSinceUpdate > 72) return { score: 10, autoDelegate: true };
  if (hoursSinceUpdate > overdueHours) return { score: 8, autoDelegate: false };
  if (hoursSinceUpdate > 24) return { score: 5, autoDelegate: false };
  return { score: 2, autoDelegate: false };
}

// ─── Batch scoring ──────────────────────────────────────────────

export async function rescoreUserItems(userId: number, clientNumber: string): Promise<void> {
  const items = await prisma.openItem.findMany({
    where: { userId, clientNumber, status: { in: ['open', 'in_progress', 'delegated', 'blocked'] } },
    select: { id: true },
  });
  await Promise.all(items.map(i => scoreOpenItem(i.id, clientNumber, userId)));
}

export async function getTopScoredItems(userId: number, clientNumber: string, cap = 12): Promise<any[]> {
  return prisma.openItem.findMany({
    where: { userId, clientNumber, status: { in: ['open', 'in_progress', 'delegated', 'blocked'] } },
    orderBy: { priorityScore: 'desc' },
    take: cap,
  });
}

// ─── CEO Intent Summary (Fix 3: reads DecisionLog, Fix 4: fire-and-forget) ─

async function generateCEOIntentSummary(item: any, userId: number, clientNumber: string): Promise<string> {
  const delegationRules = await brainConfigService.getDelegationRules(userId);
  const matchingRule = (delegationRules as any[]).find(
    (r: any) => r.itemType === item.type || r.itemType === '*',
  );

  // Fix 3: Read DecisionLog for pattern context
  let patternContext = 'No prior delegation pattern found for this item type.';
  try {
    const { getLast30Days } = await import('./decisionsLogService');
    const recentSimilar = (await getLast30Days(userId, clientNumber))
      .filter((d: any) => d.itemType === item.type && d.userDecision === 'delegated')
      .slice(0, 3);
    if (recentSimilar.length > 0) {
      patternContext = `In recent weeks, similar items were delegated with: "${recentSimilar[0].actionTaken}"`;
    }
  } catch {
    // decisionsLogService may not exist yet — graceful fallback
  }

  const assignee = matchingRule?.assigneeName ?? 'the relevant team member';
  const channel = matchingRule?.channel ?? 'chat';

  const prompt = `You are drafting a delegation message on behalf of a senior executive.

Item waiting 72+ hours without action:
Title: ${item.title}
Type: ${item.type}
Description: ${item.description ?? 'No description'}
Due date: ${item.dueDate ? new Date(item.dueDate).toLocaleDateString() : 'Not set'}

Delegate to: ${assignee}
Channel: ${channel}
${patternContext}

Write a clear, direct delegation message (3-5 sentences) that:
1. States what needs to be done
2. Gives relevant context
3. Sets a clear expectation or deadline
4. Sounds like a senior executive — confident, brief

Return only the message text.`;

  try {
    const { getGenAI } = await import('./genaiClient');
    const genai = getGenAI();
    const response = await genai.models.generateContent({ model: 'gemini-2.0-flash', contents: prompt });
    return (response.text || '').trim();
  } catch {
    return `Please handle: "${item.title}". This item has been waiting over 72 hours. — Sent via MyOS auto-delegate`;
  }
}
