/**
 * MyOS Sprint 3 — Action Suggestion Service
 *
 * Generates ranked action suggestions with full draft text for top-12 scored items.
 * Runs during Brain Engine step 6. Uses Gemini Flash.
 * Results stored in OpenItem.metadata.rankedSuggestions[].
 */

import prisma from '../db/prisma';
import * as brainConfigService from './brainConfigService';
import * as entityService from './entityService';

// ─── Run for top items ──────────────────────────────────────────

export async function runForTopItems(userId: number, clientNumber: string): Promise<number> {
  const items = await prisma.openItem.findMany({
    where: { userId, clientNumber, status: { in: ['open', 'in_progress', 'delegated', 'blocked'] } },
    orderBy: { priorityScore: 'desc' },
    take: 12,
  });

  const masterContext = await brainConfigService.getMasterContext(userId);
  const delegationRules = await brainConfigService.getDelegationRules(userId);
  const escalationRules = await brainConfigService.getEscalationRules(userId);

  let generated = 0;

  // Process concurrently in batches of 4 (avoid rate limiting)
  for (let i = 0; i < items.length; i += 4) {
    const batch = items.slice(i, i + 4);
    await Promise.allSettled(
      batch.map(item => generateSuggestionsForItem(item, userId, clientNumber, masterContext, delegationRules, escalationRules)),
    );
    generated += batch.length;
  }

  return generated;
}

// ─── Generate suggestions for a single item ─────────────────────

async function generateSuggestionsForItem(
  item: any,
  userId: number,
  clientNumber: string,
  masterContext: string,
  delegationRules: any[],
  escalationRules: any[],
): Promise<void> {
  // Load entity context
  let entityContext = '';
  if (item.entityId) {
    const entity = await entityService.getEntity(item.entityId, clientNumber);
    if (entity) {
      const sentimentEmoji = entity.sentimentScore && entity.sentimentScore < -0.3 ? '😟' :
        entity.sentimentScore && entity.sentimentScore > 0.3 ? '😊' : '😐';
      const lastContact = entity.lastInteraction
        ? `${Math.round((Date.now() - new Date(entity.lastInteraction).getTime()) / 86400000)}d ago`
        : 'unknown';
      const linkedItems = await prisma.openItem.count({ where: { clientNumber, entityId: item.entityId, status: { not: 'done' } } });
      entityContext = `Entity: ${entity.name} (${entity.role || entity.entityType}) · ${entity.company || ''} · sentiment: ${sentimentEmoji} · last contact: ${lastContact} · ${linkedItems} open items`;
    }
  }

  // Load recent decisions for pattern context
  let patternContext = '';
  try {
    const recentDecisions = await prisma.decisionLog.findMany({
      where: { userId, clientNumber, entityId: item.entityId || undefined },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { suggestedAction: true, userDecision: true, actionTaken: true },
    });
    if (recentDecisions.length > 0) {
      patternContext = `Recent decisions for this entity: ${recentDecisions.map(d => `${d.userDecision}: ${d.actionTaken || d.suggestedAction}`).join(' | ')}`;
    }
  } catch {}

  // Find matching delegation rule
  const matchingRule = delegationRules.find((r: any) => r.itemType === item.type || r.itemType === '*');
  const isEscalation = escalationRules.some((r: any) =>
    r.condition?.toLowerCase().includes(item.type) || (item.entityId && r.condition?.toLowerCase().includes('personal')),
  );

  const prompt = `You are generating action suggestions for a senior executive's priority item.

USER CONTEXT: ${masterContext || 'Not configured'}

ITEM:
- Title: ${item.title}
- Type: ${item.type}
- Status: ${item.status}
- Priority: ${item.priority} (score: ${item.priorityScore || 'unscored'})
- Due: ${item.dueDate ? new Date(item.dueDate).toLocaleDateString() : 'No deadline'}
- Description: ${item.description || 'None'}
- Source: ${item.sourceFeed || 'manual'}
${entityContext ? `\n${entityContext}` : ''}
${patternContext ? `\n${patternContext}` : ''}
${matchingRule ? `\nDelegation rule: ${item.type} items → ${matchingRule.assigneeName} via ${matchingRule.channel}` : ''}
${isEscalation ? '\nNote: This matches an escalation rule — user should handle personally.' : ''}

Generate 2-3 action suggestions. For each:
1. A short label (e.g., "Reply", "Delegate to Salman", "Snooze 24h")
2. A full draft message if applicable (email reply text, delegation message, etc.)
3. Brief reasoning (1 sentence — why this action)

Return valid JSON array: [{"label":"...","draft":"...or null","reasoning":"..."}]
Return ONLY the JSON array.`;

  try {
    const { getGenAI } = await import('./genaiClient');
    const genai = getGenAI();
    const response = await genai.models.generateContent({ model: 'gemini-2.0-flash', contents: prompt });
    const text = response.text || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);

    if (jsonMatch) {
      const suggestions = JSON.parse(jsonMatch[0]);
      await prisma.openItem.update({
        where: { id: item.id },
        data: {
          metadata: {
            ...((item.metadata as object) ?? {}),
            rankedSuggestions: suggestions,
            entityContext: entityContext || null,
            suggestionsGeneratedAt: new Date().toISOString(),
          } as any,
        },
      });
    }
  } catch (err: any) {
    // Non-fatal — item will show without suggestions
    console.error(`[actionSuggestion] Failed for item ${item.id}:`, err.message?.slice(0, 100));
  }
}
