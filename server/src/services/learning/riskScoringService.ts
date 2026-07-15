/**
 * Nexeo Self-Learning — Risk Scoring Service (Phase 1)
 *
 * Per spec §14: every AI action must be risk-scored. The four levels
 * decide whether Brain can auto-execute, must draft-only, must
 * recommend-only, or must NOT execute at all.
 *
 * This service is the single source of truth for risk classification —
 * called from interaction logging, governed-memory creation, and
 * (later in Phase 2) gap proposals + development requests. By keeping
 * the classification rules HERE (not scattered across services),
 * every risk decision stays auditable and uniform.
 */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface RiskInput {
  surface?: string;                 // 'web_chat' | 'whatsapp_brain' | etc.
  interactionType?: string;          // 'ask' | 'compose' | 'send' | 'delegate' | etc.
  /** Will the action send a message FROM the user's identity? Highest signal. */
  sendsAsUser?: boolean;
  /** Will the action send via Brain's tenant channel? */
  sendsAsBrain?: boolean;
  /** Will the action mutate user data (open items, calendar)? */
  mutatesUserData?: boolean;
  /** Will the action mutate connector credentials / auth / tenant isolation? */
  mutatesSecurityState?: boolean;
  /** Does the action touch private/sensitive memory creation? */
  touchesSensitiveMemory?: boolean;
  /** Does the action involve cross-user or cross-tenant data? */
  touchesCrossUserData?: boolean;
  /** Will the action deploy code or modify production state? */
  deploysProductionCode?: boolean;
}

export interface RiskResult {
  level: RiskLevel;
  reasons: string[];
  /** Whether Brain can auto-execute without confirmation. */
  canAutoExecute: boolean;
  /** Whether human approval is required before execution. */
  requiresApproval: boolean;
  /** Whether Brain MUST refuse to execute regardless of approval. */
  mustNotExecute: boolean;
}

/**
 * Classify an action's risk level + the gates that apply.
 *
 * Hierarchy (per §14):
 *   - Critical → must not execute. Examples: deploy code, change
 *     auth/tenant logic, send as user without explicit chain.
 *   - High → recommend only. Examples: send as user (with chain),
 *     delegate task to another person, change connector config.
 *   - Medium → draft + confirm. Examples: send from Brain's tenant
 *     channel, create inferred open item, suggest triage rule.
 *   - Low → auto-execute + log. Examples: summarize email, suggest
 *     reply text (no send), propose reminder.
 */
/** Numeric rank so we can `escalateTo` without TS narrowing pain. */
const RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const BY_RANK: RiskLevel[] = ['low', 'medium', 'high', 'critical'];
function escalateTo(current: RiskLevel, candidate: RiskLevel): RiskLevel {
  return RANK[candidate] > RANK[current] ? candidate : current;
}

export function scoreRisk(input: RiskInput): RiskResult {
  const reasons: string[] = [];
  let level: RiskLevel = 'low';

  // ── Critical signals ──────────────────────────────────────────
  if (input.deploysProductionCode) {
    reasons.push('deploys production code');
    level = escalateTo(level, 'critical');
  }
  if (input.mutatesSecurityState) {
    reasons.push('mutates security state (auth, tenant isolation, credentials)');
    level = escalateTo(level, 'critical');
  }
  if (input.touchesCrossUserData) {
    reasons.push('touches cross-user or cross-tenant data');
    level = escalateTo(level, 'critical');
  }
  if (input.sendsAsUser && input.interactionType !== 'user_initiated_send') {
    reasons.push('sends as user identity outside user-initiated chain');
    level = escalateTo(level, 'critical');
  }

  // ── High signals ──────────────────────────────────────────────
  if (input.interactionType === 'delegate' || input.interactionType === 'schedule') {
    reasons.push(`${input.interactionType} affects another person`);
    level = escalateTo(level, 'high');
  }
  if (input.touchesSensitiveMemory) {
    reasons.push('creates/modifies sensitive memory');
    level = escalateTo(level, 'high');
  }
  if (input.mutatesUserData && input.interactionType === 'follow_up') {
    reasons.push('automated follow-up against another party');
    level = escalateTo(level, 'high');
  }

  // ── Medium signals ────────────────────────────────────────────
  if (input.sendsAsBrain) {
    reasons.push('sends from Brain tenant channel');
    level = escalateTo(level, 'medium');
  }
  if (input.mutatesUserData && !(input.mutatesUserData && input.interactionType === 'follow_up')) {
    reasons.push('creates/updates user-owned data (open item, calendar, etc.)');
    level = escalateTo(level, 'medium');
  }

  // ── Default reasoning when no escalation triggers fired ──────
  if (reasons.length === 0) {
    reasons.push('read-only / suggestion-only — no state change');
  }

  return {
    level,
    reasons,
    canAutoExecute: level === 'low' || level === 'medium',
    requiresApproval: level === 'high',
    mustNotExecute: level === 'critical',
  };
}
