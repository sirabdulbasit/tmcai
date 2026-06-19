/**
 * Nexeo Self-Learning — Audit Service (Phase 1)
 *
 * Surfaces a chronological view of what the learning system DID — every
 * memory approval / rejection / archive, every feedback row, every
 * high-risk interaction. This is the "who/what/when" trail an admin
 * uses to verify Brain is staying within governance rules.
 *
 * Purely read-only. Writes happen via learningService.
 */
import prisma from '../../db/prisma';

export interface AuditEvent {
  kind: 'interaction' | 'feedback' | 'memory_proposed' | 'memory_approved'
      | 'memory_rejected' | 'memory_archived';
  id: string;
  at: Date;
  userId: number | null;
  summary: string;
  riskLevel?: string;
  status?: string;
}

/**
 * Combined chronological audit feed for a tenant. Caller can narrow
 * by user (when an admin is auditing one specific user's activity).
 * Hard-capped at 200 rows per call — admin UI is expected to page
 * via since-cursor (not implemented yet — Session 2 UI work).
 */
export async function getAuditFeed(args: {
  clientNumber: string;
  userId?: number;
  sinceDays?: number;
  limit?: number;
}): Promise<AuditEvent[]> {
  const limit = Math.min(args.limit ?? 200, 500);
  const sinceDate = args.sinceDays
    ? new Date(Date.now() - args.sinceDays * 24 * 60 * 60 * 1000)
    : new Date(Date.now() - 14 * 24 * 60 * 60 * 1000); // default 14d
  const userFilter = args.userId !== undefined ? { userId: args.userId } : {};
  const tenantFilter = { clientNumber: args.clientNumber };

  // Fan out 3 parallel queries — interactions (high-risk only —
  // low/medium are too noisy for audit), feedback, memory mutations.
  const [interactions, feedback, memoryMutations] = await Promise.all([
    prisma.brainInteractionLearningLog.findMany({
      where: {
        ...tenantFilter, ...userFilter,
        createdAt: { gte: sinceDate },
        riskLevel: { in: ['high', 'critical'] },
      },
      select: {
        id: true, userId: true, surface: true, interactionType: true,
        riskLevel: true, status: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.brainFeedback.findMany({
      where: { ...tenantFilter, ...userFilter, createdAt: { gte: sinceDate } },
      select: {
        id: true, userId: true, feedbackType: true, createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
    prisma.governedBrainMemory.findMany({
      where: {
        ...tenantFilter,
        ...(args.userId !== undefined ? {
          OR: [{ userId: args.userId }, { approvedBy: args.userId }, { rejectedBy: args.userId }],
        } : {}),
        updatedAt: { gte: sinceDate },
        status: { in: ['active', 'rejected', 'archived'] },
      },
      select: {
        id: true, userId: true, title: true, status: true, sensitivityLevel: true,
        approvedBy: true, rejectedBy: true, approvedAt: true, rejectedAt: true,
        updatedAt: true, createdAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    }),
  ]);

  const events: AuditEvent[] = [];
  for (const i of interactions) {
    events.push({
      kind: 'interaction', id: i.id, at: i.createdAt, userId: i.userId,
      riskLevel: i.riskLevel, status: i.status,
      summary: `${i.riskLevel.toUpperCase()} ${i.interactionType} on ${i.surface}`,
    });
  }
  for (const f of feedback) {
    events.push({
      kind: 'feedback', id: f.id, at: f.createdAt, userId: f.userId,
      summary: `feedback: ${f.feedbackType}`,
    });
  }
  for (const m of memoryMutations) {
    const kind = (m.status === 'active' ? 'memory_approved'
      : m.status === 'rejected' ? 'memory_rejected'
      : 'memory_archived') as AuditEvent['kind'];
    const at = m.approvedAt || m.rejectedAt || m.updatedAt;
    const actorId = m.approvedBy ?? m.rejectedBy ?? m.userId ?? null;
    events.push({
      kind, id: m.id, at, userId: actorId,
      summary: `${m.status}: "${m.title}" (${m.sensitivityLevel})`,
    });
  }

  events.sort((a, b) => b.at.getTime() - a.at.getTime());
  return events.slice(0, limit);
}
