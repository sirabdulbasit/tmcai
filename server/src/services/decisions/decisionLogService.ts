import prisma from '../../db/prisma';
import { publish } from '../infra/pubsubPublisher';
import { PUBSUB_TOPICS } from '../../config/pubsub';

export type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH';
export type UserDecision = 'approved' | 'overrode' | 'delegated' | 'snoozed' | 'dismissed';

export interface DecisionRecord {
  clientNumber: string;
  userId: number;
  sessionType: string; // morning_briefing | intraday | auto_action
  itemType: string; // email | whatsapp | task | calendar | erp | okr | manual
  entityId?: string;
  connectorSlug?: string;
  suggestedAction?: string;
  userDecision: UserDecision;
  actionTaken?: string;
  isMatch: boolean;
  overrideReason?: string;
  responseTimeMs?: number;
  outcome?: 'positive' | 'negative' | 'neutral';
  openItemId?: string;
  confidenceScore?: number;
  riskTier?: RiskTier;
  inputSummary?: string;
  outputSummary?: string;
  durationMs?: number;
  traceId?: string;
  agentId?: string;
}

export interface DecisionLogResult {
  id: string;
  archivedToBq: boolean;
}

/**
 * Three-Layer Decision Log writer:
 *  L1 (BigQuery immutable archive) — published to `steering.snapshot` as event_type=decision
 *                                    cowork Cloud Function siphons into BQ nightly
 *  L2 (curated training set) — filtered BQ view, generated later by cowork
 *  L3 (Postgres operational view) — the DecisionLog table for live UI queries
 *
 * This function is the ONLY sanctioned entry point for creating DecisionLog rows
 * once Phase 5 is complete. Direct prisma.decisionLog.create writes should be
 * migrated here so every decision picks up trace_id + risk_tier + BQ publish.
 */
export async function record(entry: DecisionRecord): Promise<DecisionLogResult> {
  const row = await prisma.decisionLog.create({
    data: {
      userId: entry.userId,
      clientNumber: entry.clientNumber,
      sessionType: entry.sessionType,
      itemType: entry.itemType,
      entityId: entry.entityId,
      connectorSlug: entry.connectorSlug,
      suggestedAction: entry.suggestedAction,
      userDecision: entry.userDecision,
      actionTaken: entry.actionTaken,
      isMatch: entry.isMatch,
      overrideReason: entry.overrideReason,
      responseTimeMs: entry.responseTimeMs,
      outcome: entry.outcome,
      openItemId: entry.openItemId,
      confidenceScore: entry.confidenceScore,
      riskTier: entry.riskTier,
      inputSummary: entry.inputSummary,
      outputSummary: entry.outputSummary,
      durationMs: entry.durationMs,
      traceId: entry.traceId,
      agentId: entry.agentId,
    },
  });

  let archivedToBq = false;
  try {
    await publish(
      PUBSUB_TOPICS.STEERING_SNAPSHOT,
      { eventType: 'decision_recorded', decisionLogId: row.id, ...entry, recordedAt: row.createdAt.toISOString() },
      {
        tenantId: entry.clientNumber,
        traceId: entry.traceId,
        orderingKey: `decisions:${entry.clientNumber}`,
        attributes: { eventType: 'decision_recorded', riskTier: entry.riskTier, agentId: entry.agentId },
      },
    );
    archivedToBq = true;
  } catch (err: any) {
    // Pub/Sub down → Postgres row is source of truth. BQ sink will catch up on backfill.
    console.warn(`[decisionLog] pubsub publish failed for ${row.id}: ${err.message}`);
  }

  return { id: row.id, archivedToBq };
}

/** Read one decision with its archive status. Read path is always Postgres (L3). */
export async function getById(id: string, clientNumber: string) {
  return prisma.decisionLog.findFirst({ where: { id, clientNumber } });
}

/** Tenant-scoped decision history for Action Center & analytics. */
export interface ListOptions {
  userId?: number;
  riskTier?: RiskTier;
  userDecision?: UserDecision;
  from?: Date;
  to?: Date;
  take?: number;
  skip?: number;
}

export async function list(clientNumber: string, opts: ListOptions = {}) {
  return prisma.decisionLog.findMany({
    where: {
      clientNumber,
      ...(opts.userId ? { userId: opts.userId } : {}),
      ...(opts.riskTier ? { riskTier: opts.riskTier } : {}),
      ...(opts.userDecision ? { userDecision: opts.userDecision } : {}),
      ...(opts.from || opts.to
        ? { createdAt: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: opts.take ?? 100,
    skip: opts.skip ?? 0,
  });
}

/** Aggregate match rate by risk tier for Shadowing calibration. */
export async function matchRateByRiskTier(clientNumber: string, sinceDays = 30) {
  const since = new Date(Date.now() - sinceDays * 24 * 3600 * 1000);
  const rows = await prisma.decisionLog.groupBy({
    by: ['riskTier', 'isMatch'],
    where: { clientNumber, createdAt: { gte: since }, riskTier: { not: null } },
    _count: true,
  });
  const out: Record<string, { total: number; matched: number; matchRate: number }> = {};
  for (const r of rows) {
    const tier = r.riskTier ?? 'UNKNOWN';
    if (!out[tier]) out[tier] = { total: 0, matched: 0, matchRate: 0 };
    out[tier].total += r._count;
    if (r.isMatch) out[tier].matched += r._count;
  }
  for (const tier of Object.keys(out)) {
    out[tier].matchRate = out[tier].total === 0 ? 0 : out[tier].matched / out[tier].total;
  }
  return out;
}
