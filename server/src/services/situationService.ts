/**
 * MyOS Sprint 3 — Situation Synthesis Service
 *
 * When 3+ open items share the same entityId, synthesizes them into a single
 * "situation block" — a multi-signal summary with one recommended action.
 *
 * Runs during Brain Engine step 7. Uses Gemini Flash.
 * Results stored in Entity.metadata.situationBlock.
 * Day Brief shows situation blocks INSTEAD of individual items for that entity.
 */

import prisma from '../db/prisma';
import * as entityService from './entityService';

// ─── Synthesize all entities with 3+ items ──────────────────────

export async function synthesiseAll(userId: number, clientNumber: string): Promise<number> {
  // Find entities with 3+ open items
  const entityGroups = await prisma.openItem.groupBy({
    by: ['entityId'],
    where: {
      userId, clientNumber,
      entityId: { not: null },
      status: { in: ['open', 'in_progress', 'delegated', 'blocked'] },
    },
    _count: { id: true },
    having: { id: { _count: { gte: 3 } } },
  });

  let synthesized = 0;

  for (const group of entityGroups) {
    if (!group.entityId) continue;
    try {
      await synthesiseEntity(group.entityId, userId, clientNumber);
      synthesized++;
    } catch (err: any) {
      console.error(`[situation] Failed for entity ${group.entityId}:`, err.message?.slice(0, 100));
    }
  }

  return synthesized;
}

// ─── Synthesize a single entity ─────────────────────────────────

async function synthesiseEntity(entityId: string, userId: number, clientNumber: string): Promise<void> {
  const entity = await entityService.getEntity(entityId, clientNumber);
  if (!entity) return;

  const items = await prisma.openItem.findMany({
    where: { userId, clientNumber, entityId, status: { in: ['open', 'in_progress', 'delegated', 'blocked'] } },
    orderBy: { priorityScore: 'desc' },
  });

  if (items.length < 3) return;

  // Build signal summary
  const signals = items.map(i => `${i.type}: ${i.title} (score: ${i.priorityScore || '?'}, source: ${i.sourceFeed || 'manual'})`);
  const topScore = items[0].priorityScore || 0;

  const prompt = `You are synthesizing multiple signals about one entity for a senior executive.

Entity: ${entity.name} (${entity.role || entity.entityType}) · ${entity.company || ''}
Sentiment: ${entity.sentimentScore || 'neutral'}
Open items (${items.length} signals):
${signals.join('\n')}

Write a brief situation summary (3-4 sentences) that:
1. Identifies the pattern across these ${items.length} signals
2. Explains the risk or opportunity
3. Recommends ONE clear action

Return only the summary text, no JSON.`;

  try {
    const { getGenAI } = await import('./genaiClient');
    const genai = getGenAI();
    const response = await genai.models.generateContent({ model: 'gemini-2.0-flash', contents: prompt });
    const situationBlock = (response.text || '').trim();

    if (situationBlock) {
      await entityService.updateEntity(entityId, clientNumber, {
        metadata: {
          ...((entity.metadata as object) ?? {}),
          situationBlock,
          situationItemCount: items.length,
          situationScore: topScore,
          situationGeneratedAt: new Date().toISOString(),
          situationItemIds: items.map(i => i.id),
        },
      });
    }
  } catch (err: any) {
    console.error(`[situation] Synthesis failed for ${entity.name}:`, err.message?.slice(0, 100));
  }
}

// ─── Get situation blocks for briefing ──────────────────────────

export async function getSituationBlocks(userId: number, clientNumber: string): Promise<any[]> {
  const entities = await prisma.entity.findMany({
    where: { clientNumber },
    select: { id: true, name: true, role: true, company: true, metadata: true, sentimentScore: true },
  });

  return entities.filter(e => {
    const meta = e.metadata as any;
    return meta?.situationBlock && meta?.situationItemIds?.length >= 3;
  }).map(e => {
    const meta = e.metadata as any;
    return {
      entityId: e.id,
      entityName: e.name,
      entityRole: e.role,
      company: e.company,
      sentimentScore: e.sentimentScore,
      situationBlock: meta.situationBlock,
      itemCount: meta.situationItemCount,
      topScore: meta.situationScore,
      itemIds: meta.situationItemIds || [],
    };
  });
}
