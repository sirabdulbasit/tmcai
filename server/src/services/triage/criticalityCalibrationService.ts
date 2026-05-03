/**
 * Criticality calibration consumer.
 *
 * When a 👎 lands on a criticality decision, the feedback diagnosis
 * service categorises the failure (`over_flagged_critical`,
 * `under_flagged_critical`, `wrong_person_scope`, etc.). This service
 * is the consumer that translates that diagnosis into per-user weight
 * adjustments on the criticality engine's 5 dimensions, plus a global
 * threshold shift if the user systematically marks too much as critical.
 *
 * Conservative semantics:
 *   - Each category nudges the relevant weight by a small delta (≤ 0.1
 *     per event), clamped to [0.5, 1.5].
 *   - A `global_threshold_shift` accumulates so we can adjust the 0.8
 *     critical-band threshold per-user without rewriting the engine.
 *   - We track sample_count so the front-end can show "Brain calibrated
 *     based on 8 of your 👎s — your over-flagging is down 18%".
 *
 * Consumed by `criticalityEngineService.scoreCriticality` via
 * `applyCalibration(rawDimensions, weights)`. If no row exists, all
 * weights are 1.0 and threshold shift is 0 (i.e., engine is unchanged).
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { audit } from '../auditLogService';

const log = createLogger('crit-calibration');

export interface Calibration {
  timePressure: number;
  impact: number;
  relationshipRisk: number;
  cascade: number;
  patternAnomaly: number;
  thresholdShift: number;        // added to the 0.8 cutoff
  sampleCount: number;
}

const DEFAULT: Calibration = {
  timePressure: 1, impact: 1, relationshipRisk: 1, cascade: 1, patternAnomaly: 1,
  thresholdShift: 0, sampleCount: 0,
};

/** Fetch (or default) per-user calibration. */
export async function getCalibration(clientNumber: string, userId: number): Promise<Calibration> {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT * FROM criticality_calibration WHERE client_number=$1 AND user_id=$2`,
    clientNumber, userId,
  ).catch(() => []);
  const r = rows[0];
  if (!r) return { ...DEFAULT };
  return {
    timePressure: clampW(Number(r.time_pressure_w)),
    impact: clampW(Number(r.impact_w)),
    relationshipRisk: clampW(Number(r.relationship_risk_w)),
    cascade: clampW(Number(r.cascade_w)),
    patternAnomaly: clampW(Number(r.pattern_anomaly_w)),
    thresholdShift: clamp(Number(r.global_threshold_shift), -0.2, 0.2),
    sampleCount: Number(r.sample_count ?? 0),
  };
}

/**
 * Apply a single 👎 diagnosis as a calibration update. Idempotent on
 * (clientNumber, userId, diagnosisId) — repeated calls with the same
 * diagnosis won't double-count. Called by the feedback service after
 * it files the diagnosis.
 */
export async function applyDiagnosis(input: {
  clientNumber: string;
  userId: number;
  diagnosisId: string;
  category: string;
  affectedSubsystem?: string;
  confidence: number;
}): Promise<{ ok: boolean; updated: Calibration | null }> {
  const cur = await getCalibration(input.clientNumber, input.userId);

  // Check we haven't applied this diagnosis already.
  const existing = await prisma.$queryRawUnsafe<any[]>(
    `SELECT last_diagnosis_id FROM criticality_calibration WHERE client_number=$1 AND user_id=$2`,
    input.clientNumber, input.userId,
  ).catch(() => []);
  if (existing[0]?.last_diagnosis_id === input.diagnosisId) {
    return { ok: false, updated: null };
  }

  // Compute the nudge. Caps the per-event change so a single diagnosis
  // can't swing the engine wildly. Confidence scales the delta.
  const delta = 0.05 + 0.05 * Math.min(1, Math.max(0, input.confidence));
  const next = { ...cur };
  let nudgedField: keyof Calibration | null = null;

  switch (input.category) {
    case 'over_flagged_critical':
      // User said it shouldn't have been critical. Pull every dim down
      // a hair, raise the global threshold.
      next.timePressure = clampW(cur.timePressure - delta * 0.5);
      next.impact = clampW(cur.impact - delta * 0.5);
      next.thresholdShift = clamp(cur.thresholdShift + delta, -0.2, 0.2);
      nudgedField = 'thresholdShift';
      break;
    case 'under_flagged_critical':
      // User says we missed a critical one. Bump dims up + lower threshold.
      next.timePressure = clampW(cur.timePressure + delta * 0.4);
      next.patternAnomaly = clampW(cur.patternAnomaly + delta * 0.4);
      next.thresholdShift = clamp(cur.thresholdShift - delta, -0.2, 0.2);
      nudgedField = 'thresholdShift';
      break;
    case 'wrong_tone':
    case 'too_verbose':
    case 'too_terse':
      // Tone issues — outside the criticality engine. No-op here.
      return { ok: false, updated: cur };
    case 'retrieval_miss':
    case 'wrong_source':
    case 'hallucination':
    case 'missed_context':
    case 'stale_data':
    case 'wrong_person_scope':
      // Retrieval/identity issues — outside the criticality engine. No-op here.
      return { ok: false, updated: cur };
    case 'irrelevant':
      // Brain surfaced something unrelated. Treat as over-flag-lite.
      next.thresholdShift = clamp(cur.thresholdShift + delta * 0.5, -0.2, 0.2);
      nudgedField = 'thresholdShift';
      break;
    default:
      return { ok: false, updated: cur };
  }

  await prisma.$executeRawUnsafe(
    `INSERT INTO criticality_calibration
       (client_number, user_id, time_pressure_w, impact_w, relationship_risk_w,
        cascade_w, pattern_anomaly_w, global_threshold_shift,
        sample_count, last_diagnosis_at, last_diagnosis_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10, NOW())
     ON CONFLICT (client_number, user_id) DO UPDATE SET
       time_pressure_w = EXCLUDED.time_pressure_w,
       impact_w = EXCLUDED.impact_w,
       relationship_risk_w = EXCLUDED.relationship_risk_w,
       cascade_w = EXCLUDED.cascade_w,
       pattern_anomaly_w = EXCLUDED.pattern_anomaly_w,
       global_threshold_shift = EXCLUDED.global_threshold_shift,
       sample_count = criticality_calibration.sample_count + 1,
       last_diagnosis_at = NOW(),
       last_diagnosis_id = EXCLUDED.last_diagnosis_id,
       updated_at = NOW()`,
    input.clientNumber, input.userId,
    next.timePressure, next.impact, next.relationshipRisk,
    next.cascade, next.patternAnomaly, next.thresholdShift,
    cur.sampleCount + 1,
    input.diagnosisId,
  );

  await audit({
    clientNumber: input.clientNumber, actorId: input.userId, actorKind: 'system',
    action: 'feedback.diagnosed',
    subjectType: 'criticality_calibration', subjectId: `${input.clientNumber}:${input.userId}`,
    details: {
      diagnosisId: input.diagnosisId,
      category: input.category,
      nudgedField,
      delta,
      before: cur,
      after: next,
    },
  });

  log.info('calibration applied', {
    userId: input.userId, category: input.category,
    sampleCount: cur.sampleCount + 1, thresholdShift: next.thresholdShift,
  });
  return { ok: true, updated: { ...next, sampleCount: cur.sampleCount + 1 } };
}

/** Effective critical band threshold for this user. Engine reads this. */
export async function getEffectiveCriticalThreshold(clientNumber: string, userId: number): Promise<number> {
  const c = await getCalibration(clientNumber, userId);
  return clamp(0.8 + c.thresholdShift, 0.5, 0.95);
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return (lo + hi) / 2;
  return Math.min(hi, Math.max(lo, v));
}
function clampW(v: number): number { return clamp(v, 0.5, 1.5); }
