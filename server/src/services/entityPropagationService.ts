/**
 * MyOS Sprint 2 Gap G-A — ERG Cross-Entity Propagation
 *
 * When an open item scores high for a given entity, related entities
 * (via EntityLink) receive a propagation boost to their open items' scores.
 *
 * Fix 1: PROPAGATION_LINK_TYPES whitelist — 'works_at' EXCLUDED to prevent runaway noise.
 * Fix 2: Score capped at 10.0 — prevents formula breakage from multiple boosts.
 *
 * Uses existing EntityLink table — no Firestore, no schema changes.
 */

import prisma from '../db/prisma';

// ─── Fix 1: Link type whitelist (CRITICAL) ──────────────────────
// Only these link types warrant propagation.
// 'works_at' is intentionally excluded — colleagues sharing an employer
// should NOT cause cascading score boosts on every incoming signal.
const PROPAGATION_LINK_TYPES = ['owns', 'sponsors', 'reports_to', 'manages'];

// ─── Types ──────────────────────────────────────────────────────

export interface PropagationEvent {
  triggerEntityId: string;
  triggerItemId: string;
  triggerScore: number;
  clientNumber: string;
  userId: number;
  propagationNotes: string;
}

// ─── Boost calculation ──────────────────────────────────────────

function getPropagationBoost(triggerScore: number): number {
  if (triggerScore >= 8) return 1.5;
  if (triggerScore >= 6) return 0.8;
  return 0; // below 6 — no propagation
}

// ─── Find connected entities via meaningful links ───────────────

export async function getConnectedEntities(
  entityId: string,
  clientNumber: string,
): Promise<string[]> {
  const links = await prisma.entityLink.findMany({
    where: {
      clientNumber,
      OR: [
        { entityId, linkType: { in: PROPAGATION_LINK_TYPES } },
        { linkedEntityId: entityId, linkType: { in: PROPAGATION_LINK_TYPES } },
      ],
    },
  });

  const connected = new Set<string>();
  for (const link of links) {
    if (link.entityId !== entityId) connected.add(link.entityId);
    if (link.linkedEntityId !== entityId) connected.add(link.linkedEntityId);
  }
  return Array.from(connected);
}

// ─── Apply propagation boost ────────────────────────────────────

export async function propagateScore(event: PropagationEvent): Promise<void> {
  const boost = getPropagationBoost(event.triggerScore);
  if (boost === 0) return;

  const connectedEntityIds = await getConnectedEntities(event.triggerEntityId, event.clientNumber);
  if (connectedEntityIds.length === 0) return;

  // Find open items for connected entities — same user, same tenant
  const affectedItems = await prisma.openItem.findMany({
    where: {
      clientNumber: event.clientNumber,
      userId: event.userId,
      entityId: { in: connectedEntityIds },
      status: { in: ['open', 'in_progress', 'delegated', 'blocked'] },
    },
    select: { id: true, priorityScore: true, metadata: true },
  });

  for (const item of affectedItems) {
    const currentScore = item.priorityScore ?? 0;
    // Fix 2: Score cap at 10.0 (CRITICAL)
    const boostedScore = Math.min(10.0, currentScore + boost);

    await prisma.openItem.update({
      where: { id: item.id },
      data: {
        priorityScore: boostedScore,
        metadata: {
          ...((item.metadata as object) ?? {}),
          propagationBoost: boost,
          propagationTrigger: event.triggerItemId,
          propagationNote: event.propagationNotes,
          propagatedAt: new Date().toISOString(),
        } as any,
      },
    });
  }

  // Log propagation on trigger item for visibility
  if (affectedItems.length > 0) {
    await prisma.openItem.update({
      where: { id: event.triggerItemId },
      data: {
        notes: {
          push: {
            text: `Score propagated to ${affectedItems.length} connected item(s) via ERG (+${boost} boost)`,
            at: new Date().toISOString(),
            type: 'propagation',
          },
        } as any,
      },
    });
  }
}

// ─── Revert propagation when trigger item is resolved ───────────

export async function revertPropagation(
  triggerItemId: string,
  clientNumber: string,
): Promise<void> {
  // Find items that received a boost from this trigger
  const allItems = await prisma.openItem.findMany({
    where: { clientNumber, status: { in: ['open', 'in_progress', 'delegated', 'blocked'] } },
    select: { id: true, priorityScore: true, metadata: true },
  });

  // Filter to items with this trigger
  const boostedItems = allItems.filter(item => {
    const meta = item.metadata as any;
    return meta?.propagationTrigger === triggerItemId;
  });

  for (const item of boostedItems) {
    const meta = (item.metadata as any) ?? {};
    const boost = meta.propagationBoost ?? 0;
    const revertedScore = Math.max(0, (item.priorityScore ?? 0) - boost);

    await prisma.openItem.update({
      where: { id: item.id },
      data: {
        priorityScore: revertedScore,
        metadata: {
          ...meta,
          propagationBoost: 0,
          propagationTrigger: null,
          propagationNote: null,
          propagationReverted: true,
          propagationRevertedAt: new Date().toISOString(),
        } as any,
      },
    });
  }
}
