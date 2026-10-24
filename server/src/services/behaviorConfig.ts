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
  // DEF-104 — the slice of a user's daily message budget that Brain's own
  // health reporting may consume. The rest is reserved for messages about the
  // user's actual work.
  //
  // 25% of a 20/day cap is 5 diagnostics: enough for a digest, a deploy report
  // and a couple of alerts, and never enough to displace a day's reminders.
  'notify.diagnostic_budget_pct': {
    key: 'notify.diagnostic_budget_pct', unit: 'count', def: 25, min: 1, max: 100, scope: 'tenant',
    description: 'DEF-104. Percentage of the daily message cap that Brain self-reporting (health alerts, digest, deploy reports) may use. Protects user-facing reminders from being crowded out.',
  },
  // DEF-120 — Brain speaks during working hours, in the user's own timezone.
  //
  // Owner, 2026-08-11: *"brain should send message only in office hour as per
  // region"*. That morning he received an intervention notice at 06:11 and
  // another at 08:16. Quiet hours ended at 06:00, so 06:11 was legal — and
  // still wrong. "Not asleep" is not the same as "at work", and an assistant
  // that opens with a blocker before the working day is one you learn to mute.
  //
  // Hours, not a boolean, because the answer differs by region and by person.
  // The window is read in the USER's timezone, so a tenant in Karachi and one
  // in London each get their own 9-to-6 without any coordination.
  'notify.office_start_hour': {
    key: 'notify.office_start_hour', unit: 'hours', def: 9, min: 0, max: 23, scope: 'tenant',
    description: 'DEF-120. Earliest local hour Brain may send a non-urgent proactive message. Below this it waits rather than suppressing.',
  },
  'notify.office_end_hour': {
    key: 'notify.office_end_hour', unit: 'hours', def: 18, min: 1, max: 24, scope: 'tenant',
    description: 'DEF-120. Latest local hour (exclusive) for non-urgent proactive messages. 18 means the last send is at 17:59.',
  },
  // 0 = Sunday. Default Mon-Fri; a tenant working Sat is one config change away.
  'notify.office_days_mask': {
    key: 'notify.office_days_mask', unit: 'count', def: 62, min: 1, max: 127, scope: 'tenant',
    description: 'DEF-120. Bitmask of working days, bit 0 = Sunday. Default 62 = Mon-Fri. Brain holds non-urgent messages outside these days.',
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
  // ── C-3: self-pruning ─────────────────────────────────────────────
  'selfpruning.filesystem_prune_enabled': {
    key: 'selfpruning.filesystem_prune_enabled', unit: 'count', def: 0, min: 0, max: 1, scope: 'tenant',
    description: 'Let the daily filesystem sweep actually REMOVE what it measures (0/1). Owner ruling 2026-10-09: "keep your self pruning from sizes, files, db etc" — aspect 1 of Self-Pruning, made continuous. Default 0 for the same reason every other suppressing switch here defaults 0: deleting takes consent. At 0 the sweep still runs daily and still raises the disk-pressure finding, so the measurement is never withheld — only the deletion is. The families it can touch are a hand-verified whitelist, each carrying the guard that proved it safe on 2026-10-04/05 (no hardlinks elsewhere; no process references it; the directory is empty). A guard that throws counts as "not safe". Deliberately outside its reach: WhatsApp session dirs, other sessions\' scratch, other applications, and anything deploy.sh already retains.',
  },
  'selfpruning.daily_rollup_enabled': {
    key: 'selfpruning.daily_rollup_enabled', unit: 'count', def: 0, min: 0, max: 1, scope: 'tenant',
    description: 'ONE message per user per DAY, across all items (0/1). Owner ruling 2026-09-08, CL-057/DEF-325: "i should received one digest email per day instead of n number of email". Default 0 for the same reason digest_enabled is — SUPPRESSING pushes takes consent — but this is the stronger switch and the difference matters. `digest_enabled` digests per ITEM and only from the 4th unanswered push about that item in 24h, so at the owner\'s measured volume (28 pushes over 7 days across 2-5 distinct items, ~2 per item) it NEVER fires: turning it on would have changed nothing while reading as a fix. This key keys the digest per USER per DAY instead, so exactly one rollup exists however many items are pushing. Everything the per-item policy refuses to touch, this refuses too: a digest is never digested, and high/top criticality is never muffled — both guards run BEFORE this switch is read.',
  },
  'selfpruning.digest_enabled': {
    key: 'selfpruning.digest_enabled', unit: 'count', def: 0, min: 0, max: 1, scope: 'tenant',
    description: 'C-3 increment 2 MASTER SWITCH (0/1). While 0 — the default — no push is ever digested, so deploying the mechanism changes nothing until the owner opts in. DECIDED SEMANTICS (DEF-173, Codex iteration-29 MEDIUM #4): turning this on IS blanket consent for per-item digesting across the tenant. Per-item pre-consent was rejected deliberately — the drip is only visible after it has happened, so requiring consent per item would make the feature inert for every new item. The per-item escape is `selfpruning.decision.item:<id>` = keep, which always wins; unknown values are keep, never consent; a per-item `suppress` level is NOT implemented.',
  },
  'selfpruning.withdrawal_notice_enabled': {
    key: 'selfpruning.withdrawal_notice_enabled', unit: 'count', def: 1, min: 0, max: 1, scope: 'tenant',
    description: 'C-3 increment 3 switch for the withdrawal-notice DISPATCHER (0/1). Default 1 — DEF-242: the 0 default was a HOLD, not a consent gate, and its stated condition is met. The hold (DEF-191, 2026-08-17) named four open findings against this announce path — a restore inside the revalidate→enqueue window, immortal batch membership suppressing a re-withdrawal, no DB ownership constraint for concurrent dispatchers, cap starvation behind uncleared sent members — and said notices flow "once the event-token redesign lands and the gate opens." It landed: DEF-208 made revalidation, the per-row claim CAS, the queue insert and the sent-mark ONE transaction; DEF-202 minted per-withdrawal event tokens and derived the batch dedup key from the sorted member tokens, making the existing unique index the concurrency ownership constraint; DEF-209 pages past claimed debt. All deployed, mapped finding-by-finding in build_log Iteration 9, with DEF-236 VERIFIED (LIVE) on the adjacent lifecycle path. This differs from selfpruning.digest_enabled (still 0: SUPPRESSING pushes takes consent) the way the noise report (def 1) does: telling the owner what withdrew is increment 3\'s own contract — "the owner is told once what was withdrawn" — and is bounded to one batch notice per user per tick through quiet-hours-aware dispatch. Set 0 to silence it.',
  },
  'selfpruning.burst_rollup_enabled': {
    key: 'selfpruning.burst_rollup_enabled', unit: 'count', def: 0, min: 0, max: 1, scope: 'tenant',
    description: 'C-3 increment 2, the same-SENDER half (DEF-330) — CL-033 verbatim: "ten unactionable pushes from one unknown number in a single morning". When one sender\'s relayed messages exceed selfpruning.burst_threshold inside selfpruning.burst_window_minutes, the excess is HELD (suppressed/burst_rollup, fully retrievable, receipted into the DEF-277 suppression digest) instead of delivered one by one. The first threshold-many always deliver, so a sender is never silenced outright; high/emergency and admin probes are never held. Default 0 for the digest_enabled reason: SUPPRESSING pushes takes consent — deploying this changes nothing until the owner opts in. Contrast digest_enabled (per-ITEM, needs item identity) and daily_rollup_enabled (per-DAY, housekeeping kinds only): this is the only switch that touches same-sender HUMAN-relay bursts, the one shape CL-033 actually describes.',
  },
  'selfpruning.burst_threshold': {
    key: 'selfpruning.burst_threshold', unit: 'count', def: 4, min: 2, max: 20, scope: 'tenant',
    description: 'DEF-330 — how many delivered messages from ONE sender inside the burst window before further ones are held. The threshold-many always deliver (he must SEE the sender is active); min 2 so a single message can never be held.',
  },
  'selfpruning.burst_window_minutes': {
    key: 'selfpruning.burst_window_minutes', unit: 'minutes', def: 90, min: 5, max: 1440, scope: 'tenant',
    description: 'DEF-330 — the rolling window for the same-sender burst count. 90min covers the CL-033 "single morning" shape without holding a sender who writes a few times across a day.',
  },
  'selfpruning.noise_report_enabled': {
    key: 'selfpruning.noise_report_enabled', unit: 'count', def: 1, min: 0, max: 1, scope: 'tenant',
    description: 'C-3 increment 1 (DEF-217) — the read-only inbound-noise COUNT report. Default 1, and deliberately so: increment 1 is explicitly "no suppression, no deletion, no behaviour change — it only produces the number that proves the problem", and its Done-when requires that number to reach the owner. Nothing here reads or changes an open item, and nothing is withheld from him; the only effect is at most ONE message per user per day naming a sender, how many pushes reached him and how many he acted on. Contrast selfpruning.digest_enabled and selfpruning.withdrawal_notice_enabled, which default 0 because they SUPPRESS or ANNOUNCE state changes. Set to 0 to silence the report.',
  },
  'learn.proposal_digest_enabled': {
    key: 'learn.proposal_digest_enabled', unit: 'count', def: 1, min: 0, max: 1, scope: 'tenant',
    description: 'DEF-349 — the pending-proposals digest, the surfacing half of the human-gated Learn loop. Default 1, deliberately, on the withdrawal-notice/noise-report justification: telling the owner that governed-memory proposals await HIS approval IS the loop\'s contract — without it the human gate is a Settings tab he never opens and DEF-348\'s generation layer manifests nothing. Nothing is suppressed, activated or changed by this switch: at most ONE digest per user per day (queue day-key dedup), and only when NEW proposals exist since the last digest (per-tenant cursor in system_config). Contrast selfpruning.digest_enabled (def 0: SUPPRESSING takes consent). Set 0 to silence.',
  },
  'comm.email_item_derivation_enabled': {
    key: 'comm.email_item_derivation_enabled', unit: 'count', def: 1, min: 0, max: 1, scope: 'tenant',
    description: 'DEF-246 — derive open items from arriving email (0/1). Default 1 because this fulfils the owner\'s explicit, twice-repeated request verbatim ("Derive actionable or open items from each email arrive and add them", S20/S23) — the same def-1 rationale as the noise report: delivering what he asked for is the contract, not a consent question. The MODEL judges actionability per email (governance ruling: judgements are the model\'s); code enforces tenant/user scope, the canonical creation gate with dedup, and receipts (a feed row leaves status:new only as processed=item-created or skipped=judged-not-actionable). Bounded: 48h window (the pre-existing backlog stays untouched — flooding weeks of dead email into his list would be CL-033 in a new costume) and a per-tick LLM batch cap. Set 0 to stop deriving.',
  },
  'comm.chat_item_derivation_enabled': {
    key: 'comm.chat_item_derivation_enabled', unit: 'count', def: 1, min: 0, max: 1, scope: 'tenant',
    description: 'DEF-253 — derive open items from Google Chat messages (0/1), through the SAME consumer as email derivation. Default 1 under the owner\'s 08-24 ruling verbatim: "it not limit with whatsapp it should cover all aspects of communications" — the channel sat at 294 received / 0 ever processed, his own leadership space unread, while Brain claimed to review across channels. The MODEL judges each message\'s actionability; creation goes through the canonical gate; a row leaves status:new only as processed or skipped, receipted. Shares comm.email_item_derivation_batch (the cap bounds LLM spend per tenant, not per channel) and the same 48h window, so the 294-row backlog stays untouched. Set 0 to stop deriving from chat.',
  },
  'comm.gcal_item_derivation_enabled': {
    key: 'comm.gcal_item_derivation_enabled', unit: 'count', def: 1, min: 0, max: 1, scope: 'tenant',
    description: 'DEF-307 — review arriving calendar events through the SAME consumer as email/chat derivation (0/1). Default 1 under the owner\'s 08-24 ruling ("it not limit with whatsapp it should cover all aspects of communications") — gcal was the last dead channel: 55 of 55 in-window events at status:new, 0 ever processed, while Brain implied it reads every channel. The MODEL judges each event, and the judgement is deliberately CONSERVATIVE per the owner\'s own complaint (CL-041, "why are you creating item based on invitations?"): an invite he can simply attend or decline is NOT actionable — only an event that asks him to prepare, decide, respond or provide something beyond attending mints an item. Most events therefore leave status:new as skipped WITH a receipt, which is the point: a reviewed-and-skipped channel is honest, an unread one licenses fabrication (DEF-243\'s co-existence test). Shares comm.email_item_derivation_batch and the 48h window; the 800+-row backlog stays untouched. Set 0 to stop reviewing calendar events.',
  },
  'comm.email_item_derivation_batch': {
    key: 'comm.email_item_derivation_batch', unit: 'count', def: 5, min: 1, max: 25, scope: 'tenant',
    description: 'DEF-246 — maximum email actionability judgements (LLM calls) per derivation tick per tenant. Cost cap and spam cap in one: a bad model day can mint at most this many items per 15-minute tick.',
  },
  'selfpruning.noise_report_min_pushes': {
    key: 'selfpruning.noise_report_min_pushes', unit: 'count', def: 5, min: 2, max: 100, scope: 'tenant',
    description: 'DEF-217 — the report says nothing below this many pushes from one sender in the window. CL-033 was ten in a morning; five is the floor at which a count is worth a message. A report about two pushes would itself be the noise the campaign exists to remove.',
  },
  'selfpruning.digest_after_pushes': {
    key: 'selfpruning.digest_after_pushes', unit: 'count', def: 3, min: 2, max: 20, scope: 'tenant',
    description: 'C-3 increment 2. How many DELIVERED-and-unanswered pushes about one item, inside the digest window, before further pushes fold into the item\'s single digest message.',
  },
  'selfpruning.digest_window_hours': {
    key: 'selfpruning.digest_window_hours', unit: 'hours', def: 24, min: 1, max: 168, scope: 'tenant',
    description: 'C-3 increment 2. The window the digest counts over, and the bucket size for "one digest message per item per window".',
  },
  'selfpruning.burst_max_span_minutes': {
    key: 'selfpruning.burst_max_span_minutes', unit: 'minutes', def: 1440, min: 30, max: 43200, scope: 'tenant',
    description: 'DEF-170. How close together repeated unanswered pushes about one subject must be to count as a burst rather than a cadence. The default separates CL-033 (45 minutes) from monthly status notices; the right value is an owner preference. NOTE: iteration 26 shipped the ledger reading this key WITHOUT registering it here, so getBehaviorValue threw "unknown behavior key" and a silent catch pinned the span to 1440 — the owner\'s override could never take effect (Codex iteration-26 HIGH #1).',
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
