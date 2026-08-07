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
  // ── DEF-082 — every threshold I invented today, handed to the owner ──
  //
  // "nothing should be hardcoded". Each of these started as a number I chose
  // in a hurry, and each is a real product decision: how long to trust a
  // temporal guess, how long an ignored question may block everything, how far
  // back "recently" reaches. They belong to him, tunable without a deploy.
  'delegation.lid_bootstrap_window_hours': {
    key: 'delegation.lid_bootstrap_window_hours', unit: 'hours', def: 6, min: 1, max: 72, scope: 'tenant',
    description: 'DEF-075. How recently a counterpart must have been messaged for an unknown @lid reply to be bound to them. Longer catches overnight replies; also raises the chance two counterparts overlap, in which case it refuses to bind at all.',
  },
  'prompt.lock_max_age_hours': {
    key: 'prompt.lock_max_age_hours', unit: 'hours', def: 2, min: 1, max: 48, scope: 'tenant',
    description: 'DEF-077. How long an unanswered question may hold the conversational lock before it is released. One ignored reminder held it 28 hours on 2026-08-06 and blocked five notifications.',
  },
  'brain.dispatch_ledger_lookback_hours': {
    key: 'brain.dispatch_ledger_lookback_hours', unit: 'hours', def: 36, min: 6, max: 168, scope: 'tenant',
    description: 'DEF-037. How far back the "what you actually did" block reads. Must comfortably exceed a working day: the failure it fixes was a one-hour gap.',
  },
  'brain.contact_block_size': {
    key: 'brain.contact_block_size', unit: 'count', def: 80, min: 20, max: 300, scope: 'tenant',
    description: 'DEF-050. How many contacts reach the prompt. People NAMED in the message are always included regardless of this cap — the cap only bounds the ranked filler.',
  },
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
  // DEF-095 — how far back Brain looks to find the question a reply answers.
  //
  // The owner, 2026-08-07: "if brain ask me any question... after an hour when i
  // reply to it with 'High Tomorrow' it didnt corelated my this with his last
  // message... don't you think it will read last n number message to correlated
  // what i had asked it".
  //
  // He is right, and correlation was far narrower than he assumed: it looked at
  // exactly ONE row in exactly ONE state (`awaiting_reply`), with no ordering
  // and no history. At the time he raised it there were 0 rows in that state and
  // 119 expired ones — so any reply arriving late correlated to nothing at all
  // and was re-read as a brand-new instruction.
  //
  // Hours, not minutes: a person answers when they get to their phone, and the
  // measured average lifetime of an expired prompt here is ~19 hours. Tenant
  // scope so a busier tenant can shorten it without a deploy.
  'prompt_reply.lookback_hours': {
    key: 'prompt_reply.lookback_hours', unit: 'hours', def: 24, min: 1, max: 168, scope: 'tenant',
    description: 'DEF-095. How far back Brain searches its own recent questions when deciding which one an incoming reply answers. Covers questions that already expired — a question the user finally answers is still answered.',
  },
  // How many recent questions are offered to the relevance classifier. Small on
  // purpose: every candidate is an opportunity to attach an answer to the WRONG
  // question, which is worse than failing to attach it at all.
  'prompt_reply.max_candidates': {
    key: 'prompt_reply.max_candidates', unit: 'count', def: 5, min: 1, max: 20, scope: 'tenant',
    description: 'DEF-095. Maximum recent unanswered questions considered as correlation candidates for one incoming reply, newest first.',
  },
  // Step 5 — when the daily digest goes out, in the user's local hour (PKT).
  // Config rather than a literal so a tenant in another timezone, or an owner
  // who would rather read it at night, changes it without a deploy.
  'notify.digest_hour_local': {
    key: 'notify.digest_hour_local', unit: 'hours', def: 8, min: 0, max: 23, scope: 'tenant',
    description: 'Local hour (PKT) at which Brain sends its daily self-report digest. Quiet hours still apply on top.',
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
