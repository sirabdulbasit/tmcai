/**
 * MyOS Gap 5b — Pattern Analysis Service
 *
 * Weekly job (Sunday 6am) — identifies consistent decision patterns.
 * Patterns with count >= 10 AND matchRate >= 90% surfaced as ThoughtEntry candidates.
 * User reviews and can confirm for auto-action promotion.
 *
 * Feature flag: ff_decisions_log (same as Gap 5a)
 */

import prisma from '../db/prisma';

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
  // Only Standard and Premium tier users get pattern analysis
  const users = await prisma.user.findMany({
    where: { clientNumber, isActive: true },
    select: { id: true, userType: true },
  });

  for (const user of users) {
    // Skip basic tier users
    if (user.userType === 'BS') continue;
    await analyseUserPatterns(user.id, clientNumber);
  }
}

async function analyseUserPatterns(userId: number, clientNumber: string): Promise<void> {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const decisions = await prisma.decisionLog.findMany({
    where: { userId, clientNumber, createdAt: { gte: since } },
    select: { itemType: true, connectorSlug: true, suggestedAction: true, isMatch: true },
  });

  if (decisions.length < 10) return; // not enough data

  // Group by (itemType × connectorSlug × suggestedAction)
  const groups = new Map<string, { count: number; matches: number; itemType: string; connectorSlug: string; suggestedAction: string }>();

  for (const d of decisions) {
    const key = `${d.itemType}:${d.connectorSlug || 'unknown'}:${d.suggestedAction || 'unknown'}`;
    const existing = groups.get(key) || {
      count: 0, matches: 0,
      itemType: d.itemType, connectorSlug: d.connectorSlug || 'unknown',
      suggestedAction: d.suggestedAction || 'unknown',
    };
    existing.count++;
    if (d.isMatch) existing.matches++;
    groups.set(key, existing);
  }

  // Find candidates: count >= 10 AND matchRate >= 0.90
  const candidates = [...groups.values()].filter(g => {
    const matchRate = g.count > 0 ? g.matches / g.count : 0;
    return g.count >= 10 && matchRate >= 0.90;
  });

  // Surface each candidate as a ThoughtEntry (pattern_insight)
  for (const candidate of candidates) {
    const matchRate = Math.round((candidate.matches / candidate.count) * 100);

    // Check if this pattern insight already exists (avoid duplicates)
    const existingInsight = await prisma.thoughtEntry.findFirst({
      where: {
        userId, clientNumber,
        type: 'pattern_insight',
        title: { contains: candidate.suggestedAction },
        createdAt: { gte: since },
      },
    });
    if (existingInsight) continue;

    await prisma.thoughtEntry.create({
      data: {
        userId,
        clientNumber,
        type: 'pattern_insight',
        title: `Pattern: ${matchRate}% match on ${candidate.itemType} → ${candidate.suggestedAction}`,
        content: `Over the past 30 days, you have consistently "${candidate.suggestedAction}" for "${candidate.itemType}" items from ${candidate.connectorSlug} (${candidate.count} decisions, ${matchRate}% acceptance rate).\n\nWould you like to approve this as an auto-action pattern?`,
        status: 'draft',
        triggerSource: 'pattern_analysis',
        relatedEntities: [] as any,
        relatedItems: [] as any,
      },
    });
  }
}

// ─── Pattern confirmation / revocation ──────────────────────────

export async function confirmPattern(userId: number, _clientNumber: string, pattern: object): Promise<void> {
  const brain = await prisma.brainConfig.findUnique({ where: { userId } });
  const confirmed = Array.isArray(brain?.confirmedPatterns) ? [...(brain.confirmedPatterns as any[])] : [];
  confirmed.push({ ...pattern, confirmedAt: new Date().toISOString() });
  await prisma.brainConfig.update({
    where: { userId },
    data: { confirmedPatterns: confirmed as any },
  });
}

export async function revokePattern(userId: number, _clientNumber: string, patternIndex: number): Promise<void> {
  const brain = await prisma.brainConfig.findUnique({ where: { userId } });
  const confirmed = Array.isArray(brain?.confirmedPatterns) ? [...(brain.confirmedPatterns as any[])] : [];
  const revoked = Array.isArray(brain?.revokedPatterns) ? [...(brain.revokedPatterns as any[])] : [];

  if (patternIndex >= 0 && patternIndex < confirmed.length) {
    const [removed] = confirmed.splice(patternIndex, 1);
    revoked.push({ ...removed, revokedAt: new Date().toISOString() });
  }

  await prisma.brainConfig.update({
    where: { userId },
    data: { confirmedPatterns: confirmed as any, revokedPatterns: revoked as any },
  });
}
