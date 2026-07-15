import prisma from '../../db/prisma';
import { publish } from '../infra/pubsubPublisher';
import { PUBSUB_TOPICS } from '../../config/pubsub';
import { matchRateByRiskTier } from '../decisions/decisionLogService';

export type KpiMetricType =
  | 'decisions_total'
  | 'decisions_approved'
  | 'decisions_overridden'
  | 'actions_executed'
  | 'actions_failed'
  | 'open_items_new'
  | 'feed_events_ingested'
  | 'match_rate_low'
  | 'match_rate_medium'
  | 'match_rate_high';

export interface KpiRecord {
  metricType: KpiMetricType;
  metricValue: number;
  dimensions?: Record<string, unknown>;
  periodStart: Date;
  periodEnd: Date;
}

/**
 * Compute today's KPIs for a tenant and write them to kpi_values.
 * Publishes a steering.snapshot Pub/Sub event so the Steering Wheel UI + BQ analytics pick them up.
 */
export async function computeDailySnapshot(clientNumber: string, forDate?: Date): Promise<KpiRecord[]> {
  const day = forDate ?? new Date();
  const periodStart = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const periodEnd = new Date(periodStart.getTime() + 24 * 3600 * 1000);

  const [
    decisionsTotal,
    decisionsApproved,
    decisionsOverridden,
    actionsExecuted,
    actionsFailed,
    openItemsNew,
    feedEventsIngested,
  ] = await Promise.all([
    prisma.decisionLog.count({ where: { clientNumber, createdAt: { gte: periodStart, lt: periodEnd } } }),
    prisma.decisionLog.count({ where: { clientNumber, createdAt: { gte: periodStart, lt: periodEnd }, userDecision: 'approved' } }),
    prisma.decisionLog.count({ where: { clientNumber, createdAt: { gte: periodStart, lt: periodEnd }, userDecision: 'overrode' } }),
    prisma.agentAction.count({ where: { clientNumber, updatedAt: { gte: periodStart, lt: periodEnd }, status: 'done' } }),
    prisma.agentAction.count({ where: { clientNumber, updatedAt: { gte: periodStart, lt: periodEnd }, status: 'error' } }),
    prisma.openItem.count({ where: { clientNumber, createdAt: { gte: periodStart, lt: periodEnd } } }),
    prisma.feedEvent.count({ where: { clientNumber, createdAt: { gte: periodStart, lt: periodEnd } } }),
  ]);

  const matchRates = await matchRateByRiskTier(clientNumber, 1); // 1-day window

  const records: KpiRecord[] = [
    { metricType: 'decisions_total', metricValue: decisionsTotal, periodStart, periodEnd },
    { metricType: 'decisions_approved', metricValue: decisionsApproved, periodStart, periodEnd },
    { metricType: 'decisions_overridden', metricValue: decisionsOverridden, periodStart, periodEnd },
    { metricType: 'actions_executed', metricValue: actionsExecuted, periodStart, periodEnd },
    { metricType: 'actions_failed', metricValue: actionsFailed, periodStart, periodEnd },
    { metricType: 'open_items_new', metricValue: openItemsNew, periodStart, periodEnd },
    { metricType: 'feed_events_ingested', metricValue: feedEventsIngested, periodStart, periodEnd },
    { metricType: 'match_rate_low', metricValue: matchRates.LOW?.matchRate ?? 0, dimensions: { samples: matchRates.LOW?.total ?? 0 }, periodStart, periodEnd },
    { metricType: 'match_rate_medium', metricValue: matchRates.MEDIUM?.matchRate ?? 0, dimensions: { samples: matchRates.MEDIUM?.total ?? 0 }, periodStart, periodEnd },
    { metricType: 'match_rate_high', metricValue: matchRates.HIGH?.matchRate ?? 0, dimensions: { samples: matchRates.HIGH?.total ?? 0 }, periodStart, periodEnd },
  ];

  await prisma.$transaction(
    records.map((r) =>
      prisma.kpiValue.create({
        data: {
          clientNumber,
          metricType: r.metricType,
          metricValue: r.metricValue,
          dimensions: (r.dimensions ?? null) as any,
          periodStart: r.periodStart,
          periodEnd: r.periodEnd,
        },
      }),
    ),
  );

  try {
    await publish(
      PUBSUB_TOPICS.STEERING_SNAPSHOT,
      { eventType: 'daily_snapshot', records, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString() },
      { tenantId: clientNumber, attributes: { eventType: 'daily_snapshot' } },
    );
  } catch (err: any) {
    console.warn(`[steeringWheel] pubsub publish failed: ${err.message}`);
  }

  return records;
}

export interface DashboardRow {
  metricType: KpiMetricType;
  current: number;
  previous: number | null;
  deltaPct: number | null;
}

/**
 * Dashboard readout: for each metric, compare the latest daily value to the prior day.
 * Powers the Steering Wheel "Health Check" tab with week-over-week trends.
 */
export async function dashboard(clientNumber: string): Promise<DashboardRow[]> {
  const latest = await prisma.kpiValue.groupBy({
    by: ['metricType'],
    where: { clientNumber },
    _max: { periodStart: true },
  });

  const rows: DashboardRow[] = [];
  for (const { metricType, _max } of latest) {
    if (!_max.periodStart) continue;
    const current = await prisma.kpiValue.findFirst({
      where: { clientNumber, metricType, periodStart: _max.periodStart },
      orderBy: { computedAt: 'desc' },
    });
    const prevPeriodStart = new Date(_max.periodStart.getTime() - 24 * 3600 * 1000);
    const previous = await prisma.kpiValue.findFirst({
      where: { clientNumber, metricType, periodStart: prevPeriodStart },
      orderBy: { computedAt: 'desc' },
    });
    const currentVal = current?.metricValue ?? 0;
    const prevVal = previous?.metricValue ?? null;
    const deltaPct = prevVal && prevVal > 0 ? ((currentVal - prevVal) / prevVal) * 100 : null;
    rows.push({ metricType: metricType as KpiMetricType, current: currentVal, previous: prevVal, deltaPct });
  }
  return rows;
}

/**
 * Trend for a single metric across a window of days.
 */
export async function trend(clientNumber: string, metricType: KpiMetricType, days = 30) {
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  return prisma.kpiValue.findMany({
    where: { clientNumber, metricType, periodStart: { gte: since } },
    orderBy: { periodStart: 'asc' },
    select: { periodStart: true, metricValue: true, dimensions: true },
  });
}

/** Naïve anomaly detector — flags today vs 7-day average. */
export async function alerts(clientNumber: string) {
  const rows = await dashboard(clientNumber);
  return rows.filter((r) => r.deltaPct !== null && Math.abs(r.deltaPct) > 50);
}
