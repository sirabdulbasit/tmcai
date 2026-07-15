/**
 * MyOS — pattern_insights service.
 *
 * The Reflection agent (hourly) writes patterns it notices here. Day Brief
 * reads the top recent ones per user to populate "What I noticed overnight".
 *
 * Lifecycle: new → acknowledged (MD saw it in a brief) → dismissed (MD said
 * "not useful") / or converted to a shadow rule draft.
 */
import prisma from '../../db/prisma';

export interface InsightInput {
  clientNumber: string;
  userId?: number;
  description: string;
  evidenceCount?: number;
  ruleDraftId?: string;
  expiresInDays?: number;
}

export async function recordInsight(input: InsightInput): Promise<number> {
  const expires = input.expiresInDays
    ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
    : undefined;
  const row = await prisma.patternInsight.create({
    data: {
      clientNumber: input.clientNumber,
      userId: input.userId,
      description: input.description.slice(0, 500),
      evidenceCount: input.evidenceCount ?? 1,
      ruleDraftId: input.ruleDraftId,
      expiresAt: expires,
    },
  });
  return row.id;
}

export async function listFreshInsights(
  clientNumber: string,
  userId: number,
  limit = 5,
): Promise<Array<{ id: number; description: string; ruleDraftId: string | null; evidenceCount: number }>> {
  const now = new Date();
  const rows = await prisma.patternInsight.findMany({
    where: {
      clientNumber,
      OR: [{ userId }, { userId: null }],
      status: { in: ['new', 'acknowledged'] },
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      ],
    } as any,
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: limit,
    select: { id: true, description: true, ruleDraftId: true, evidenceCount: true },
  });
  return rows;
}

export async function markAcknowledged(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.patternInsight.updateMany({
    where: { id: { in: ids }, status: 'new' },
    data: { status: 'acknowledged' },
  });
}

export async function dismiss(id: number): Promise<void> {
  await prisma.patternInsight.update({ where: { id }, data: { status: 'dismissed' } });
}
