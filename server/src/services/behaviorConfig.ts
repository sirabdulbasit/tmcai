/**
 * behaviorConfig — one resolver for tunable behavioral thresholds
 * (hardening audit 2026-07-14, item #3).
 *
 * Classification (documented per key below and in
 * docs/behavior_config.md):
 *   A. SAFETY INVARIANTS stay hardcoded in their services and are NOT
 *      resolvable here — e.g. AUTO_CONFIRM_ELIGIBLE allowlist, the 200
 *      hard daily outbound cap, rule-promotion HIGH=manual-cert. No
 *      user or tenant setting can move them.
 *   B/C. Operational defaults & preferences resolve through:
 *      user override → tenant override → env override → code default
 *      with every level VALIDATED and CLAMPED to [min,max]; an invalid
 *      value at any level is skipped (warn), never used.
 *
 * Storage piggybacks the existing machinery — no new mechanism:
 *   user:   users.notification_preferences JSONB → behavior.<key>
 *   tenant: system_config row, key "behavior.<key>"
 *   env:    BEHAVIOR_<KEY_WITH_DOTS_AS_UNDERSCORES> (deployment-wide)
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('behavior-config');

export interface BehaviorSpec {
  /** Dotted key, e.g. 'preactive.meeting_prep_window_min'. */
  key: string;
  unit: 'minutes' | 'hours' | 'count' | 'days';
  def: number;
  min: number;
  max: number;
  /** Who may override: 'user' allows user+tenant; 'tenant' allows tenant only. */
  scope: 'user' | 'tenant';
  description: string;
}

export const BEHAVIOR_SPECS: Record<string, BehaviorSpec> = {
  // ── Section 33a: delegation capture (flags are 0/1 counts) ────────
  // DEF-076/079 — how sure must Brain be before it interrupts the owner?
  //
  // He asked for this to be governed by confidence rather than by rules:
  // "agreed if you controlled it through confidence level". Raise it and Brain
  // acts more and asks less; lower it and it checks in more often. A tenant
  // config value so it can be tuned without a deploy.
  //
  // 75 means: only stop and ask when the assessment is at least 75% sure the
  // check-in tells him something he does not already know.
  'confirmation.min_confidence_pct': {
    key: 'confirmation.min_confidence_pct', unit: 'count', def: 75, min: 0, max: 100, scope: 'tenant',
    description: 'Confidence (%) required before Brain asks the owner to confirm an action he already instructed. Higher = acts more, asks less. Hard safety cases (unresolved recipient, failed assessment) ask regardless.',
  },
  'delegation.capture_enabled': {
    key: 'delegation.capture_enabled', unit: 'count', def: 0, min: 0, max: 1, scope: 'tenant',
    description: '33a inbound delegation-reply capture. DEFAULT OFF; enabled per tenant after migration + health verification. Env kill switch DELEGATION_CAPTURE_ENABLED=0 overrides everything.',
  },
  'delegation.autonomous_outbound_enabled': {
    key: 'delegation.autonomous_outbound_enabled', unit: 'count', def: 0, min: 0, max: 1, scope: 'tenant',
    description: '33b autonomous follow-up sends. DEFAULT OFF; no consumer exists in 33a. Env kill switch DELEGATION_AUTONOMOUS_OUTBOUND_ENABLED=0 overrides everything.',
  },
  'delegation.receipt_recovery_window_min': {
    key: 'delegation.receipt_recovery_window_min', unit: 'minutes', def: 30, min: 5, max: 240, scope: 'tenant',
    description: 'How long a dispatch_pending thread may wait for a transport receipt before recovery marks it receipt_unknown (never resends).',
  },
  'delegation.thread_ttl_days': {
    key: 'delegation.thread_ttl_days', unit: 'days', def: 30, min: 3, max: 120, scope: 'tenant',
    description: 'Idle TTL after which an active delegation thread is marked expired (kept, never deleted).',
  },
  'delegation.ambiguity_candidate_cap': {
    key: 'delegation.ambiguity_candidate_cap', unit: 'count', def: 10, min: 3, max: 25, scope: 'tenant',
    description: 'Max candidate threads recorded per correlation-ambiguity incident; extras are counted in overflow_count.',
  },
  'preactive.meeting_prep_window_min': {
    key: 'preactive.meeting_prep_window_min', unit: 'minutes', def: 90, min: 10, max: 480, scope: 'user',
    description: 'How long before a meeting the preactive prep brief fires.',
  },
  'preactive.due_soon_hours': {
    key: 'preactive.due_soon_hours', unit: 'hours', def: 24, min: 1, max: 168, scope: 'user',
    description: 'Deadline lookahead for preactive due-date nudges.',
  },
  'pending_action.ttl_hours': {
    key: 'pending_action.ttl_hours', unit: 'hours', def: 4, min: 1, max: 24, scope: 'user',
    description: 'How long a previewed-but-unconfirmed action stays alive.',
  },
  'auto_confirm.streak_threshold': {
    key: 'auto_confirm.streak_threshold', unit: 'count', def: 10, min: 5, max: 100, scope: 'user',
    description: 'Clean approvals required before Brain offers auto-send. min=5 is a safety floor no config can lower.',
  },
  'contact_prune.max_merges_per_run': {
    key: 'contact_prune.max_merges_per_run', unit: 'count', def: 25, min: 1, max: 100, scope: 'tenant',
    description: 'Blast-radius cap per daily contact-prune run.',
  },
  'followup.subsequent_ping_hours': {
    key: 'followup.subsequent_ping_hours', unit: 'hours', def: 24, min: 4, max: 168, scope: 'user',
    description: 'Gap between delegatee follow-up pings after the first.',
  },
  'followup.escalate_after_hours': {
    key: 'followup.escalate_after_hours', unit: 'hours', def: 120, min: 24, max: 720, scope: 'user',
    description: 'Silent-delegatee window before escalating back to the user.',
  },
  'connector.stale_realert_hours': {
    key: 'connector.stale_realert_hours', unit: 'hours', def: 24, min: 1, max: 168, scope: 'user',
    description: 'Re-alert suppression window for stale-connector pings.',
  },
};

/** Pure resolution: first PRESENT and VALID (numeric) candidate wins,
 *  then clamps into [min,max]. Exported for tests. */
export function resolveBehaviorValue(
  spec: BehaviorSpec,
  candidates: Array<{ source: string; value: unknown }>,
): { value: number; source: string } {
  for (const c of candidates) {
    if (c.value === undefined || c.value === null || c.value === '') continue;
    const n = Number(c.value);
    if (!Number.isFinite(n)) {
      log.warn('non-numeric behavior override skipped', { key: spec.key, source: c.source, value: String(c.value) });
      continue;
    }
    const clamped = Math.min(Math.max(n, spec.min), spec.max);
    if (clamped !== n) log.warn('behavior override clamped', { key: spec.key, source: c.source, raw: n, clamped });
    return { value: clamped, source: c.source };
  }
  return { value: spec.def, source: 'default' };
}

function envKeyFor(key: string): string {
  return `BEHAVIOR_${key.replace(/[.\-]/g, '_').toUpperCase()}`;
}

const cache = new Map<string, { value: number; at: number }>();
const CACHE_TTL_MS = 60_000;

/** Resolve a behavioral value for a user/tenant. Both ids optional:
 *  system-level callers get tenant/env/default resolution only. */
export async function getBehaviorValue(
  key: keyof typeof BEHAVIOR_SPECS | string,
  ctx: { userId?: number; clientNumber?: string } = {},
): Promise<number> {
  const spec = BEHAVIOR_SPECS[key as string];
  if (!spec) throw new Error(`unknown behavior key: ${key}`);

  const cacheKey = `${key}:${ctx.clientNumber ?? '-'}:${ctx.userId ?? '-'}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let userVal: unknown;
  if (ctx.userId != null && spec.scope === 'user') {
    const row = await prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { notificationPreferences: true },
    }).catch(() => null);
    userVal = (row?.notificationPreferences as any)?.behavior?.[spec.key];
  }

  let tenantVal: unknown;
  if (ctx.clientNumber) {
    const { getConfig } = await import('./configService');
    tenantVal = await getConfig(ctx.clientNumber, `behavior.${spec.key}`).catch(() => null);
  }

  const { value } = resolveBehaviorValue(spec, [
    { source: 'user', value: userVal },
    { source: 'tenant', value: tenantVal },
    { source: 'env', value: process.env[envKeyFor(spec.key)] },
  ]);

  cache.set(cacheKey, { value, at: Date.now() });
  return value;
}

/** Test/ops hook. */
export function clearBehaviorCache(): void {
  cache.clear();
}
