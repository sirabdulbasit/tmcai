import prisma from '../../db/prisma';

export type RuleState = 'DRAFT' | 'SHADOW' | 'ACTIVE' | 'DEPRECATED' | 'ARCHIVED';
export type RiskTier = 'LOW' | 'MEDIUM' | 'HIGH';

const VALID_TRANSITIONS: Record<RuleState, RuleState[]> = {
  DRAFT: ['SHADOW', 'ARCHIVED'],
  SHADOW: ['ACTIVE', 'DRAFT', 'ARCHIVED'],
  ACTIVE: ['DEPRECATED', 'SHADOW'],
  DEPRECATED: ['ARCHIVED', 'ACTIVE'],
  ARCHIVED: [],
};

const PROMOTION_THRESHOLD: Record<RiskTier, number> = {
  LOW: 0.95,
  MEDIUM: 0.98,
  HIGH: 1.01, // always requires manual certification — no automatic promotion
};

const SHADOW_MIN_DAYS = 30;
const DRIFT_WINDOW_DAYS = 7;
const DRIFT_STD_THRESHOLD = 2.0;

export interface CreateDraftInput {
  clientNumber: string;
  ruleName: string;
  ruleSpec: Record<string, unknown>;
  riskTier: RiskTier;
  authorId?: number;
}

export async function createDraft(input: CreateDraftInput) {
  return prisma.ruleLifecycle.create({
    data: {
      clientNumber: input.clientNumber,
      ruleName: input.ruleName,
      ruleSpec: input.ruleSpec as any,
      riskTier: input.riskTier,
      authorId: input.authorId,
      state: 'DRAFT',
    },
  });
}

/**
 * Enforce state-machine transitions. Throws if the move is invalid.
 * Does NOT evaluate the promotion gate — callers should use promote() for ACTIVE transitions.
 */
export async function advance(ruleId: string, clientNumber: string, newState: RuleState, reason: string): Promise<void> {
  const rule = await prisma.ruleLifecycle.findFirst({ where: { id: ruleId, clientNumber } });
  if (!rule) throw new Error(`rule ${ruleId} not found`);
  if (rule.frozen && newState !== 'ARCHIVED') {
    throw new Error(`rule ${ruleId} is frozen: ${rule.frozenReason ?? 'no reason recorded'}`);
  }
  const allowed = VALID_TRANSITIONS[rule.state as RuleState] ?? [];
  if (!allowed.includes(newState)) {
    throw new Error(`invalid transition ${rule.state} → ${newState}`);
  }
  await prisma.ruleLifecycle.update({
    where: { id: ruleId },
    data: {
      state: newState,
      enteredAt: new Date(),
      frozenReason: newState === 'ARCHIVED' ? `archived: ${reason}` : rule.frozenReason,
    },
  });
}

export interface PromotionGateResult {
  passed: boolean;
  tier: RiskTier;
  score: number | null;
  threshold: number;
  reason: string;
}

/**
 * Evaluate whether a SHADOW rule has earned promotion to ACTIVE.
 * Requires: minimum shadow days elapsed + most recent Golden Dataset score >= tier threshold.
 * HIGH-tier rules always fail — they require manual certification.
 */
export async function promotionGate(ruleId: string, clientNumber: string): Promise<PromotionGateResult> {
  const rule = await prisma.ruleLifecycle.findFirst({ where: { id: ruleId, clientNumber } });
  if (!rule) throw new Error(`rule ${ruleId} not found`);
  const tier = rule.riskTier as RiskTier;
  const threshold = PROMOTION_THRESHOLD[tier];

  if (rule.state !== 'SHADOW') {
    return { passed: false, tier, score: rule.goldenScore, threshold, reason: `rule is in ${rule.state}, not SHADOW` };
  }

  const daysInShadow = (Date.now() - rule.enteredAt.getTime()) / (1000 * 3600 * 24);
  if (daysInShadow < SHADOW_MIN_DAYS) {
    return { passed: false, tier, score: rule.goldenScore, threshold, reason: `only ${daysInShadow.toFixed(1)} days in SHADOW (need ${SHADOW_MIN_DAYS})` };
  }

  if (tier === 'HIGH') {
    return { passed: false, tier, score: rule.goldenScore, threshold, reason: 'HIGH-tier rules require manual certification (no automatic promotion)' };
  }

  const score = rule.goldenScore;
  if (score === null || score === undefined) {
    return { passed: false, tier, score: null, threshold, reason: 'no Golden Dataset evaluation on record' };
  }

  if (score < threshold) {
    return { passed: false, tier, score, threshold, reason: `score ${score.toFixed(3)} below ${tier} threshold ${threshold}` };
  }

  if (rule.frozen) {
    return { passed: false, tier, score, threshold, reason: `rule is frozen by drift guard: ${rule.frozenReason ?? 'unknown'}` };
  }

  return { passed: true, tier, score, threshold, reason: 'all gates passed' };
}

/**
 * Promote a SHADOW rule to ACTIVE if it passes the gate. Otherwise throws.
 */
export async function promote(ruleId: string, clientNumber: string): Promise<PromotionGateResult> {
  const gate = await promotionGate(ruleId, clientNumber);
  if (!gate.passed) throw new Error(`promotion gate failed: ${gate.reason}`);
  await advance(ruleId, clientNumber, 'ACTIVE', `auto-promote: score=${gate.score} >= ${gate.threshold}`);
  return gate;
}

export interface DriftGuardResult {
  frozen: boolean;
  stdDev: number;
  threshold: number;
  samples: number;
  reason: string;
}

/**
 * Drift guard — compute std dev of recent ShadowScore samples vs baseline.
 * If >2σ shift in the 7-day window, freeze the rule (blocks promotion, but doesn't change state).
 * Returns whether the rule was frozen as a result of this check.
 */
export async function driftGuard(ruleId: string, clientNumber: string): Promise<DriftGuardResult> {
  const since = new Date(Date.now() - DRIFT_WINDOW_DAYS * 24 * 3600 * 1000);
  const recent = await prisma.shadowScore.findMany({
    where: { clientNumber, ruleId, evaluatedAt: { gte: since } },
    select: { score: true },
  });
  if (recent.length < 3) {
    return { frozen: false, stdDev: 0, threshold: DRIFT_STD_THRESHOLD, samples: recent.length, reason: 'insufficient samples' };
  }
  const scores = recent.map((r) => r.score);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
  const std = Math.sqrt(variance);

  if (std > DRIFT_STD_THRESHOLD) {
    await prisma.ruleLifecycle.update({
      where: { id: ruleId },
      data: { frozen: true, frozenReason: `drift guard: ${std.toFixed(3)}σ over ${DRIFT_WINDOW_DAYS}d` },
    });
    return { frozen: true, stdDev: std, threshold: DRIFT_STD_THRESHOLD, samples: recent.length, reason: 'drift exceeds threshold — frozen' };
  }

  return { frozen: false, stdDev: std, threshold: DRIFT_STD_THRESHOLD, samples: recent.length, reason: 'within tolerance' };
}

/**
 * Record a new Golden Dataset evaluation score on the rule.
 * Also updates `goldenScore` on the rule row for fast promotion-gate checks.
 */
export async function recordScore(
  ruleId: string,
  clientNumber: string,
  modelVersion: string,
  agentId: string,
  score: number,
  evaluationDetails: Record<string, unknown>,
  goldenDatasetId?: string,
): Promise<void> {
  await prisma.shadowScore.create({
    data: {
      clientNumber,
      modelVersion,
      agentId,
      ruleId,
      goldenDatasetId,
      score,
      evaluationDetails: evaluationDetails as any,
    },
  });
  await prisma.ruleLifecycle.update({
    where: { id: ruleId },
    data: { goldenScore: score },
  });
}

/**
 * List rules in a given state for tenant — UI driver.
 */
export async function listByState(clientNumber: string, state: RuleState) {
  return prisma.ruleLifecycle.findMany({
    where: { clientNumber, state },
    orderBy: { enteredAt: 'desc' },
  });
}
