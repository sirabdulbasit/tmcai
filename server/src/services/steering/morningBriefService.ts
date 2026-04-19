/**
 * HaseebOS v15 L4.4 / L4.5 — Morning Brief service.
 *
 * Called from the 06:00 PKT cron in server.ts. Delegates the actual LLM
 * narrative composition to the agent worker's morning_brief ADK agent, but
 * pre-fetches structured data so the agent has concrete inputs.
 *
 * The L4.6 steering-wheel-events publisher fires once per brief with
 * `event: 'morning_brief_composed'`.
 */
import prisma from '../../db/prisma';
import { publish } from '../infra/pubsubPublisher';
import { PUBSUB_TOPICS } from '../../config/pubsub';

export interface BriefOutput {
  clientNumber: string;
  userId: number;
  generatedAt: string;
  kpis: { key: string; value: number | string }[];
  topOpenItems: Array<{ id: string; title: string; priority: string | null; status: string }>;
  riskItems: Array<{ actionId: number; actionType: string; riskTier: string }>;
  meetingsToday: number;
  patternInsight?: string;
}

export async function composeBriefFor(clientNumber: string, userId: number): Promise<BriefOutput> {
  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);
  const tomorrow0 = new Date(today0.getTime() + 24 * 60 * 60 * 1000);

  const [kpis, items, risks] = await Promise.all([
    (prisma as any).kpiValue?.findMany?.({
      where: { clientNumber, recordedAt: { gte: today0 } } as any,
      select: { kpiKey: true, value: true },
      orderBy: { recordedAt: 'desc' },
      take: 10,
    }).catch(() => []) ?? [],
    prisma.openItem.findMany({
      where: {
        clientNumber,
        userId,
        status: { in: ['NEW', 'TRIAGED', 'IN_PROGRESS', 'WAITING_INFO'] as any },
      },
      orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
      take: 5,
      select: { id: true, title: true, priority: true, status: true },
    }),
    prisma.agentAction.findMany({
      where: { clientNumber, riskTier: 'HIGH', status: 'pending' } as any,
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, actionType: true, riskTier: true },
    }),
  ]);

  const meetingsToday = await prisma.feedEvent.count({
    where: {
      clientNumber,
      sourceType: 'gcal',
      createdAt: { gte: today0, lt: tomorrow0 },
    } as any,
  }).catch(() => 0);

  const out: BriefOutput = {
    clientNumber,
    userId,
    generatedAt: new Date().toISOString(),
    kpis: (kpis as any[]).map((k) => ({ key: k.kpiKey, value: k.value })),
    topOpenItems: items as any,
    riskItems: risks.map((r) => ({ actionId: r.id, actionType: r.actionType, riskTier: r.riskTier ?? 'HIGH' })),
    meetingsToday,
  };

  try {
    await publish(
      PUBSUB_TOPICS.STEERING_WHEEL_EVENTS,
      { event: 'morning_brief_composed', ...out },
      {
        tenantId: clientNumber,
        orderingKey: `${clientNumber}:brief:${userId}`,
        attributes: { event: 'morning_brief_composed', userId: String(userId) },
      },
    );
  } catch (err: any) {
    console.warn(`[morningBriefService] publish failed ${clientNumber}/${userId}: ${err.message}`);
  }

  return out;
}
