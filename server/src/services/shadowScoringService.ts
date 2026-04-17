/**
 * MyOS Sprint 2 Gap G-C — Shadow Scoring Calibration
 *
 * Monthly job — compares AI's priority ranking vs which items user actually acted on.
 * Surfaces divergence as a ThoughtEntry report. Does NOT auto-change weights.
 * User decides whether to adjust BrainConfig thresholds based on the report.
 *
 * Runs: first Monday of each month, 7am PKT
 * Cron: 0 7 1-7 * 1 (timezone: Asia/Karachi)
 */

import prisma from '../db/prisma';
import * as thoughtPipelineService from './thoughtPipelineService';

// ─── Run for all tenants ────────────────────────────────────────

export async function runForAllTenants(): Promise<void> {
  const tenants = await prisma.tenantConnectorConfig.findMany({
    select: { clientNumber: true },
    distinct: ['clientNumber'],
  });
  for (const { clientNumber } of tenants) {
    await runForTenant(clientNumber);
  }
}

async function runForTenant(clientNumber: string): Promise<void> {
  // Only Standard and Premium tier users
  const users = await prisma.user.findMany({
    where: { clientNumber, isActive: true },
    select: { id: true, userType: true },
  });

  for (const user of users) {
    if (user.userType === 'BS') continue; // skip basic tier
    try {
      await analyseUser(user.id, clientNumber);
    } catch (err: any) {
      console.error(`[shadowScoring] Analysis failed for user ${user.id}:`, err.message);
    }
  }
}

async function analyseUser(userId: number, clientNumber: string): Promise<void> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // What the AI thought was important: top-5 by priorityScore
  const aiTopItems = await prisma.openItem.findMany({
    where: { userId, clientNumber, createdAt: { gte: thirtyDaysAgo }, priorityScore: { not: null } },
    orderBy: { priorityScore: 'desc' },
    take: 5,
    select: { id: true, title: true, priorityScore: true, type: true },
  });

  if (aiTopItems.length < 3) return; // not enough scored items for meaningful analysis

  // What the user actually acted on: fastest response time = most confident
  const userActions = await prisma.decisionLog.findMany({
    where: {
      userId, clientNumber,
      createdAt: { gte: thirtyDaysAgo },
      userDecision: { in: ['approved', 'delegated'] },
      responseTimeMs: { not: null },
    },
    orderBy: { responseTimeMs: 'asc' },
    take: 10,
    select: { openItemId: true, responseTimeMs: true, itemType: true },
  });

  if (userActions.length < 3) return; // not enough decisions

  // Deduplicate by openItemId, take top 5
  const seen = new Set<string>();
  const userTopItemIds: string[] = [];
  for (const action of userActions) {
    if (action.openItemId && !seen.has(action.openItemId)) {
      seen.add(action.openItemId);
      userTopItemIds.push(action.openItemId);
      if (userTopItemIds.length >= 5) break;
    }
  }

  const aiTopItemIds = aiTopItems.map(i => i.id);
  const overlap = aiTopItemIds.filter(id => userTopItemIds.includes(id));
  const overlapPct = Math.round((overlap.length / Math.min(5, aiTopItemIds.length)) * 100);

  // Find divergent item types
  const aiTopTypes = [...new Set(aiTopItems.map(i => i.type))];
  const userActedTypes = [...new Set(userActions.map(a => a.itemType))];
  const divergentTypes: string[] = [];

  for (const type of userActedTypes) {
    if (!aiTopTypes.includes(type)) {
      const actionsOfType = userActions.filter(a => a.itemType === type).length;
      if (actionsOfType >= 3) {
        divergentTypes.push(
          `You acted quickly on ${actionsOfType} "${type}" items this month, but the AI did not rank these highly. Consider raising the impact weight for "${type}" items in your alert thresholds.`,
        );
      }
    }
  }

  // Only generate report if there's something meaningful
  if (overlapPct === 100 && divergentTypes.length === 0) return;

  const period = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const content = buildReport(period, overlapPct, overlap.length, aiTopItems.length, divergentTypes);

  await thoughtPipelineService.createReflectionPrompt({
    userId,
    clientNumber,
    observation: `Monthly priority calibration: AI top-5 and your actual top-5 overlapped ${overlapPct}% this month.`,
    suggestedQuestion: content,
  });
}

function buildReport(
  period: string,
  overlapPct: number,
  overlapCount: number,
  aiCount: number,
  divergentTypes: string[],
): string {
  const lines: string[] = [
    `**Priority calibration — ${period}**`,
    '',
    `This month, the AI's top-${aiCount} priority items and your actual focus overlapped **${overlapPct}%** (${overlapCount}/${aiCount} items matched).`,
    '',
  ];

  if (overlapPct < 60) {
    lines.push(
      `There is a meaningful gap between what the AI considered urgent and what you actually acted on. The scoring weights may not yet reflect your priorities well.`,
      '',
    );
  } else {
    lines.push(
      `The AI's prioritisation is broadly aligned with your actual focus. The suggestions below are refinements, not corrections.`,
      '',
    );
  }

  if (divergentTypes.length > 0) {
    lines.push('**Suggested adjustments:**', '');
    for (const pattern of divergentTypes) {
      lines.push(`- ${pattern}`);
    }
    lines.push('', 'You can update these in My Brain → Alert Thresholds.');
  }

  lines.push('', '_This report is informational. No weights have been changed automatically._');
  return lines.join('\n');
}
