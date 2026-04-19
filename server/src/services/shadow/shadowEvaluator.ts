import prisma from '../../db/prisma';
import { recordScore, driftGuard, promotionGate } from './ruleLifecycleService';

/**
 * ShadowScorer — evaluates a rule in SHADOW state against the tenant's Golden Dataset
 * and records the match-rate score.
 *
 * This is the TypeScript scorer that will eventually be a Python ADK worker in Phase 4.
 * For now it runs as a standalone function callable from a cron or admin route so Phase 5
 * can unit-test the state machine end-to-end.
 *
 * Contract:
 *  - Load all Golden Dataset rows for the tenant matching the rule's `category`.
 *  - For each, apply the rule's `ruleSpec.predicate` (stubbed matcher below) and compare
 *    the rule's suggested output against `expectedOutput.userDecision`.
 *  - Score = matches / total.
 *  - Record via `ruleLifecycleService.recordScore`, then run drift guard.
 *  - Return a summary; do NOT auto-promote (caller decides).
 */

export interface EvaluationInput {
  ruleId: string;
  clientNumber: string;
  modelVersion?: string;
  agentId?: string;
}

export interface EvaluationResult {
  ruleId: string;
  samplesEvaluated: number;
  matches: number;
  score: number;
  driftFrozen: boolean;
  driftReason: string;
  gate: Awaited<ReturnType<typeof promotionGate>>;
}

export async function evaluate(input: EvaluationInput): Promise<EvaluationResult> {
  const rule = await prisma.ruleLifecycle.findFirst({
    where: { id: input.ruleId, clientNumber: input.clientNumber },
  });
  if (!rule) throw new Error(`rule ${input.ruleId} not found`);
  if (rule.state !== 'SHADOW' && rule.state !== 'DRAFT') {
    throw new Error(`rule ${input.ruleId} is in state ${rule.state}; only DRAFT/SHADOW rules get evaluated`);
  }

  const spec = (rule.ruleSpec as Record<string, unknown>) ?? {};
  const category = typeof spec.category === 'string' ? spec.category : null;
  if (!category) throw new Error(`rule ${input.ruleId} has no ruleSpec.category — cannot select Golden Dataset slice`);

  const samples = await prisma.goldenDataset.findMany({
    where: { clientNumber: input.clientNumber, category, riskTier: rule.riskTier },
  });

  if (samples.length < 10) {
    // Insufficient data — score is null; don't advance
    return {
      ruleId: input.ruleId,
      samplesEvaluated: samples.length,
      matches: 0,
      score: 0,
      driftFrozen: false,
      driftReason: `only ${samples.length} golden samples (need ≥10)`,
      gate: { passed: false, tier: rule.riskTier as any, score: null, threshold: 0, reason: 'insufficient golden samples' } as any,
    };
  }

  let matches = 0;
  for (const sample of samples) {
    const predicted = applyRule(spec, sample.inputText ?? '', sample.expectedOutput as any);
    const expected = (sample.expectedOutput as any)?.userDecision ?? null;
    if (predicted && expected && predicted === expected) matches += 1;
  }
  const score = matches / samples.length;

  await recordScore(
    input.ruleId,
    input.clientNumber,
    input.modelVersion ?? 'manual-eval-v1',
    input.agentId ?? 'shadow_scorer',
    score,
    { matches, total: samples.length, category, riskTier: rule.riskTier },
  );

  const drift = await driftGuard(input.ruleId, input.clientNumber);
  const gate = await promotionGate(input.ruleId, input.clientNumber);

  return {
    ruleId: input.ruleId,
    samplesEvaluated: samples.length,
    matches,
    score,
    driftFrozen: drift.frozen,
    driftReason: drift.reason,
    gate,
  };
}

/**
 * Stub matcher. Real rules will have structured predicates (keyword presence,
 * entity sentiment, deal stage, etc.). For Phase 5, the rule spec can declare:
 *
 *   ruleSpec: {
 *     category: 'email',
 *     keywords: ['invoice', 'payment'],   // any match → applies
 *     predictedDecision: 'approved'       // what this rule would decide
 *   }
 *
 * Returns the rule's predicted decision if the input matches, null otherwise.
 */
function applyRule(
  spec: Record<string, unknown>,
  inputText: string,
  _expectedOutput: Record<string, unknown> | null,
): string | null {
  const keywords = Array.isArray(spec.keywords) ? (spec.keywords as string[]) : [];
  const predicted = typeof spec.predictedDecision === 'string' ? (spec.predictedDecision as string) : null;
  if (keywords.length === 0 || !predicted) return null;

  const lc = inputText.toLowerCase();
  const anyHit = keywords.some((k) => lc.includes(k.toLowerCase()));
  return anyHit ? predicted : null;
}

/** Evaluate all SHADOW rules for a tenant — called by scheduled job or admin. */
export async function evaluateAllShadow(clientNumber: string): Promise<EvaluationResult[]> {
  const rules = await prisma.ruleLifecycle.findMany({
    where: { clientNumber, state: 'SHADOW' },
    select: { id: true },
  });
  const out: EvaluationResult[] = [];
  for (const r of rules) {
    try {
      out.push(await evaluate({ ruleId: r.id, clientNumber }));
    } catch (err: any) {
      console.warn(`[shadowEval] rule ${r.id}: ${err.message}`);
    }
  }
  return out;
}
