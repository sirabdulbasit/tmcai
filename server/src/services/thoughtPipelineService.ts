/**
 * MyOS Gap 6 — Thought Pipeline Service
 *
 * Personal strategic reflection system — generates prompts, weekly reviews,
 * strategic questions, and pattern insights.
 *
 * Entry types:
 *   1. reflection_prompt  — triggered by pattern analysis
 *   2. weekly_review      — every Friday (or user's configured day)
 *   3. strategic_question — from cross-feed correlation
 *   4. pattern_insight    — from Gap 5 candidates
 *   5. user_note          — manual via ThoughtPipelinePage
 *
 * Publishing: Phase 1 publishes within MyOS only.
 * Notion/OneNote write adapters deferred until connector is actually used.
 *
 * Feature flag: ff_thought_pipeline
 */

import prisma from '../db/prisma';

// ─── Create entry helpers ───────────────────────────────────────

export async function createReflectionPrompt(params: {
  userId: number;
  clientNumber: string;
  observation: string;
  suggestedQuestion: string;
}) {
  return prisma.thoughtEntry.create({
    data: {
      userId: params.userId,
      clientNumber: params.clientNumber,
      type: 'reflection_prompt',
      title: params.suggestedQuestion.slice(0, 120),
      content: `${params.observation}\n\n${params.suggestedQuestion}`,
      status: 'draft',
      triggerSource: 'pattern_analysis',
      relatedEntities: [] as any,
      relatedItems: [] as any,
    },
  });
}

export async function createPatternInsight(params: {
  userId: number;
  clientNumber: string;
  pattern: { itemType: string; connectorSlug: string; suggestedAction: string; count: number; matchRate: number };
}) {
  const { pattern } = params;
  return prisma.thoughtEntry.create({
    data: {
      userId: params.userId,
      clientNumber: params.clientNumber,
      type: 'pattern_insight',
      title: `Pattern: ${pattern.matchRate}% match on ${pattern.itemType} → ${pattern.suggestedAction}`,
      content: `Over the past 30 days, you consistently "${pattern.suggestedAction}" for "${pattern.itemType}" items from ${pattern.connectorSlug} (${pattern.count} decisions, ${pattern.matchRate}% acceptance rate).\n\nWould you like to approve this as an auto-action pattern?`,
      status: 'draft',
      triggerSource: 'pattern_analysis',
      relatedEntities: [] as any,
      relatedItems: [] as any,
    },
  });
}

export async function generateWeeklyReview(userId: number, clientNumber: string) {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [decisions, itemStats] = await Promise.all([
    prisma.decisionLog.findMany({
      where: { userId, clientNumber, createdAt: { gte: sevenDaysAgo } },
    }),
    prisma.openItem.groupBy({
      by: ['status'],
      where: { userId, clientNumber, updatedAt: { gte: sevenDaysAgo } },
      _count: { id: true },
    }),
  ]);

  const accepted = decisions.filter(d => d.isMatch).length;
  const overridden = decisions.filter(d => !d.isMatch).length;
  const itemSummary = itemStats.map(s => `${s._count.id} ${s.status}`).join(', ');

  let content = `## Weekly Review — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}\n\n`;
  content += `**Decisions this week:** ${decisions.length} total (${accepted} accepted AI suggestions, ${overridden} overrides)\n\n`;
  content += `**Items activity:** ${itemSummary || 'No item changes this week'}\n\n`;

  if (overridden > 0) {
    const overrideReasons = decisions
      .filter(d => !d.isMatch && d.overrideReason)
      .map(d => `- ${d.overrideReason}`)
      .slice(0, 3);
    if (overrideReasons.length > 0) {
      content += `**Override reasons:**\n${overrideReasons.join('\n')}\n\n`;
    }
  }

  content += `**Looking ahead:** Review any stale delegations and check if priorities need adjusting in My Brain → Alert Thresholds.`;

  return prisma.thoughtEntry.create({
    data: {
      userId,
      clientNumber,
      type: 'weekly_review',
      title: `Weekly review — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`,
      content,
      status: 'draft',
      triggerSource: 'scheduled',
      relatedEntities: [] as any,
      relatedItems: [] as any,
    },
  });
}

export async function createUserNote(params: {
  userId: number;
  clientNumber: string;
  title: string;
  content: string;
  relatedEntityIds?: string[];
  relatedItemIds?: string[];
}) {
  return prisma.thoughtEntry.create({
    data: {
      userId: params.userId,
      clientNumber: params.clientNumber,
      type: 'user_note',
      title: params.title,
      content: params.content,
      status: 'published',
      triggerSource: 'user_request',
      relatedEntities: (params.relatedEntityIds ?? []) as any,
      relatedItems: (params.relatedItemIds ?? []) as any,
    },
  });
}

// ─── Publishing ─────────────────────────────────────────────────

export async function publishEntry(entryId: string, userId: number, clientNumber: string): Promise<void> {
  const entry = await prisma.thoughtEntry.findFirst({ where: { id: entryId, userId, clientNumber } });
  if (!entry) throw new Error('Entry not found');

  // Phase 1: publish within MyOS only
  // Phase 2: implement Notion/OneNote adapters when connector is actually connected
  await prisma.thoughtEntry.update({
    where: { id: entryId },
    data: { status: 'published', publishedAt: new Date() },
  });
}

// ─── Read operations ────────────────────────────────────────────

export async function getDraftEntries(userId: number, clientNumber: string) {
  return prisma.thoughtEntry.findMany({
    where: { userId, clientNumber, status: 'draft' },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
}

export async function getAllEntries(userId: number, clientNumber: string, limit = 50) {
  return prisma.thoughtEntry.findMany({
    where: { userId, clientNumber },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

// ─── Weekly review generation for all tenants ───────────────────

export async function generateWeeklyReviewsForAllTenants(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, clientNumber: true, userType: true },
  });

  for (const user of users) {
    if (user.userType === 'BS') continue; // skip basic tier

    // Check if thought pipeline is enabled for this user
    const brain = await prisma.brainConfig.findUnique({ where: { userId: user.id } });
    const config = (brain?.thoughtPipelineConfig as any) ?? {};
    if (config.enabled === false) continue;

    try {
      await generateWeeklyReview(user.id, user.clientNumber);
    } catch (err: any) {
      console.error(`[thoughtPipeline] Weekly review failed for user ${user.id}:`, err.message);
    }
  }
}
