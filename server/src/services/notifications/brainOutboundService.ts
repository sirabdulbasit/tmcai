/**
 * MyOS — Brain → user proactive outbound channel.
 *
 * One entry point for every "Brain pings the user" path: critical bundle,
 * standing-instruction fire, follow-up nudge, agent-run done, emergency.
 * Replaces ad-hoc `enqueue({channel:'whatsapp'})` calls scattered across
 * triage / autonomous executor / agent engine.
 *
 *   import { brainContactsUser } from '.../brainOutboundService';
 *   await brainContactsUser({
 *     userId, clientNumber, kind: 'critical_bundle', urgency: 'high',
 *     summary: 'Two critical emails arrived in the last 20 min',
 *     body: '<message text>',
 *     dedupKey: 'criticals:abc,def',
 *   });
 *
 * What it does:
 *   1. Resolves user's WhatsApp target phone (prefs override → contact_number).
 *   2. Honors quiet hours (override only for urgency=emergency).
 *   3. Per-(user, kind, dedupKey) suppression in last 20 min via DB lookup —
 *      survives restarts/replicas (the in-process Map in criticalityNotifier
 *      did not).
 *   4. Picks channel(s) by urgency:
 *        low/normal → text
 *        high       → text + voice note (TTS via voiceService)
 *        emergency  → voice note + initiate WhatsApp Business call
 *                     (with text-with-call-CTA fallback if call API fails
 *                      or tenant isn't enrolled)
 *   5. Records every send to brain_user_messages for audit + caps.
 *
 * Caller never has to think about quiet hours, dedup, channel selection,
 * or fallback. The flip side: every Brain → user contact MUST go through
 * this function so the audit log is complete.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import {
  sendCallNudgeViaNotifier,
  initiateBusinessCall,
} from './whatsappNotifierService';
import {
  sendTenantWhatsAppText,
  sendTenantWhatsAppVoiceNote,
} from './tenantWhatsappSender';
// Static import deliberately (DEF-174): this is the last-resort text when
// marker rendering itself fails, so it must not depend on a runtime import
// that could be the very thing that failed.
import { NEUTRAL_MARKER_FALLBACK } from '../knowledge/systemMarker';

const log = createLogger('brain-outbound');

export type Urgency = 'low' | 'normal' | 'high' | 'emergency';

/**
 * What KIND of text a producer is handing to the owner (DEF-140).
 *
 * The inventory behind this type is the point of it. Owner-visible text
 * comes from 66 producer call sites, and they are not the same kind of
 * thing:
 *
 *   - `brain_prose` — Brain's own words, in its own voice. The persona's
 *     address rules apply here and ONLY here. Examples: the daily draft
 *     ask, the owner-chase prompt, the self-heal "I found a problem with
 *     my own behaviour" notice.
 *   - `quoted_third_party` — contains another person's words verbatim.
 *     `delegationCaptureService`'s unattached-reply notice and
 *     `senderTriage`'s counterpart forward both embed
 *     `"${body.slice(0, 300)}"`. **Rewriting these misquotes a real
 *     human**, which is DEF-137 one layer out, and DEF-137 was found in
 *     review rather than production only by luck.
 *   - `deterministic` — a rendered artifact: the day brief, the lifecycle
 *     intervention form, connector alerts. Its shape is its meaning.
 *   - `system_marker` — a bracketed marker, never persona prose. Rendered
 *     AT THIS BOUNDARY by `answerSanitizer` (DEF-174): curated meaning →
 *     `markerVoice`, or the neutral fallback when no curated meaning
 *     exists. Raw marker text cannot reach the owner from here.
 *
 * Omitting this field is safe by construction: an unclassified payload is
 * treated as "not Brain prose" and is never touched. That is invariant #6
 * (fail closed) and it is deliberate — the 60-odd pre-existing producers
 * that have not been classified yet cannot be silently corrupted by this
 * boundary, and a NEW producer of Brain prose that forgets to declare
 * simply misses a cosmetic rule rather than mangling someone's quote.
 */
export type OwnerMessageProvenance =
  | 'brain_prose'
  | 'quoted_third_party'
  | 'deterministic'
  | 'system_marker';

export interface BrainContactRequest {
  userId: number;
  /**
   * Tenant the caller is acting FOR. REQUIRED (DEF-178, Codex iteration-50;
   * corrected DEF-179, iteration-53): delivery used to resolve everything
   * from the userId alone, which made a bare integer an authorization — any
   * caller holding a userId could reach that user and influence their
   * suppression/dedup/rate ledger, whatever tenant the caller was working
   * in. The declaration CONSTRAINS the user-resolution query itself
   * (id + clientNumber) — a foreign id resolves to no row, unread — and
   * every ledger read below is scoped by (clientNumber, userId).
   */
  clientNumber: string;
  /**
   * What kind of text `body` is — see OwnerMessageProvenance. Address
   * policy is applied to `brain_prose` and nothing else. Optional and
   * fail-closed: absent means "do not touch".
   */
  provenance?: OwnerMessageProvenance;
  /**
   * Why Brain is reaching out. Free-form key so callers can register new
   * kinds without a schema change. Used for audit grouping + per-kind caps.
   * Convention: snake_case, e.g. 'critical_bundle', 'standing_due',
   * 'follow_up_nudge', 'agent_run_done', 'emergency'.
   */
  kind: string;
  /** What the user sees in the audit log. One short line. */
  summary: string;
  /** The actual message body delivered as text + (if voice) read aloud. */
  body: string;
  urgency?: Urgency;
  /**
   * Stable key used to suppress duplicates within the dedup window.
   * Same (userId, kind, dedupKey) won't resend within `dedupWindowMs`.
   * Pass `null` to send unconditionally (use sparingly — only for
   * one-shot emergencies the user explicitly requested).
   */
  dedupKey?: string | null;
  /** Override the default 20-minute dedup window. */
  dedupWindowMs?: number;
  /**
   * Force a specific channel. Default 'auto' resolves by urgency.
   * Useful for tests and admin tooling.
   */
  // DEF-296: 'email' is a real delivery channel (the WhatsApp fallback) and must be
  // recordable as one — the audit row is what the daily cap and rate limiter read.
  channel?: 'text' | 'voicenote' | 'call_cta' | 'call_business' | 'auto' | 'email';
  /**
   * Bypass quiet-hours. Default false. Auto-set to true when
   * urgency=emergency.
   */
  bypassQuietHours?: boolean;
  /**
   * Bypass the per-kind 60s rate limit + dedup. Intended for admin
   * verify-panel sends and smoke tests where the user is intentionally
   * firing back-to-back probes. NEVER set from production code paths.
   */
  bypassRateLimit?: boolean;
  /** Bypass the opt-in gate (outboundEnabled). Reserved for explicit
   *  user-initiated probes — Settings → "Send test ping" — where the
   *  user clicked the button to verify the channel reaches them. The
   *  user's intent is the consent. NEVER use from background jobs. */
  bypassOptIn?: boolean;
  /** Free-form metadata persisted on the audit row. */
  metadata?: Record<string, unknown>;
}

export interface BrainContactResult {
  sent: boolean;
  reason?: string;             // when sent=false: 'suppressed' | 'quiet_hours' | 'no_phone' | 'send_failed'
  /** DEF-304 — WHY it was suppressed, as a value a caller can branch on.
   *  `reason` above is prose meant for a log; a sweep that has to decide
   *  "retry next tick or stop for the window?" must not match on prose. */
  suppressedBy?: string;
  channelsUsed: string[];
  waMessageIds: string[];
  recordId?: string;            // brain_user_messages.id
}

const DEFAULT_DEDUP_WINDOW_MS = 20 * 60 * 1000;

// ─── Hard safety caps ──────────────────────────────────────────────────
// Defensive guardrails so even a future bug or a misconfigured cron
// can't blast a real user. All three trigger AFTER user-resolution but
// BEFORE any Meta API / WebJS dispatch — failed-closed by default.

/** Daily cap: max outbound from Brain to any one user per 24h. Above
 *  this, every send is hard-suppressed and an admin-visible audit row
 *  is recorded. Override per-user via notificationPreferences.brain_channel.dailyCap. */
const DEFAULT_DAILY_CAP = 20;

/**
 * DEF-308 — the kinds a PERSON wrote.
 *
 * This is the set the volume budget exists to protect, so this is the set that
 * gets enumerated. Every other kind — including one added tomorrow — is
 * non-human by default and stops short of the reserve below. Omission fails
 * CLOSED: a new kind does not have to be listed anywhere to be excluded, and
 * only an explicit addition here can spend a person's slot.
 *
 * Exported so "who is protected?" has exactly one answer, the same reason
 * `SUPPRESSION_DIGEST_KIND` is exported rather than repeated.
 */
export const HUMAN_KINDS = new Set(['wa_counterpart_message']);

/** Share of the daily cap that non-human kinds may never consume: 25% of the
 *  default 20 = five slots held for people. Override per user with the
 *  `notify.human_reserve_pct` behaviour key. */
const DEFAULT_HUMAN_RESERVE_PCT = 25;

/** Content-fingerprint window: identical body text within this window
 *  is dropped even if every other dedup key differs. Catches the
 *  duplicate-bundle class of bug where the same content arrived under
 *  different fingerprints due to a race / concurrent dispatch. */
const CONTENT_DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/** Test/smoke isolation: any outbound carrying metadata.smoke=true is
 *  suppressed unless BRAIN_SMOKE_LIVE=1. Smoke tests can still observe
 *  the dispatch chain via the audit log without ever hitting a real
 *  user's WhatsApp. */
const SMOKE_LIVE = process.env.BRAIN_SMOKE_LIVE === '1';

function contentHash(body: string): string {
  const crypto = require('crypto') as typeof import('crypto');
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
}

export async function brainContactsUser(req: BrainContactRequest): Promise<BrainContactResult> {
  const urgency: Urgency = req.urgency ?? 'normal';
  const channel = req.channel ?? 'auto';
  const dedupWindowMs = req.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  const bypassQuiet = req.bypassQuietHours ?? (urgency === 'emergency');

  // ── Tenant boundary (DEF-178, corrected by DEF-179) ────────────────
  // The caller declares which tenant it is acting for, and the QUERY is
  // constrained by that declaration — id + clientNumber, one read. DEF-178
  // read the whole user by bare id and compared tenants afterwards, which
  // meant tenant A calling with tenant B's user id had already read B's
  // name, email, phone and preferences before being refused (Codex
  // iteration-53 HIGH). The invariant is that every query includes
  // `client_number`, not that cross-tenant data is read and rejected later.
  // A foreign id now resolves to NO ROW: nothing read, nothing leaked, and
  // wrong-tenant is indistinguishable from nonexistent — which is the
  // point. Refused before any audit write, so a wrong-tenant attempt
  // leaves no state on the tenant it failed to reach.
  const user = await prisma.user.findFirst({
    where: { id: req.userId, clientNumber: req.clientNumber },
    select: {
      id: true, name: true, email: true, clientNumber: true, isActive: true,
      contactNumber: true, notificationPreferences: true,
    },
  });
  if (!user) {
    log.warn('outbound refused — no such user under the declared tenant', {
      userId: req.userId, declaredTenant: req.clientNumber, kind: req.kind,
    });
    return { sent: false, reason: 'user_not_found', channelsUsed: [], waMessageIds: [] };
  }
  // Suspended user — refuse to deliver. Critical safeguard so an
  // admin who suspends a user knows for sure that NO Brain outbound
  // (Day Brief, criticality bundle, watchpoint fire, manual ping)
  // can ever reach that user's phone or email until they're
  // reactivated. Per Basit 2026-06-10: "after deletion, will that
  // user receive any email or whatsapp communication?" — answer
  // must be a structural NO, not "depends if the dispatcher
  // happens to remember to check".
  if (!user.isActive) {
    return { sent: false, reason: 'user_suspended', channelsUsed: [], waMessageIds: [] };
  }

  const prefs = (user.notificationPreferences as any) ?? {};
  const bc = prefs.brain_channel ?? {};

  // ── Owner-message rendering boundary (DEF-140) ───────────────────────
  //
  // The ONE place proactive owner-visible prose has the persona's address
  // rules applied. It sits here, not at `sendTenantWhatsAppText`, because
  // the transport is shared with messages to OTHER PEOPLE (delegatee
  // nudges via actionLifecycleWorker, counterpart sends) and a rule about
  // how to address the owner has no business running over those.
  //
  // Provenance-gated, and that gate is the whole design: `senderTriage`
  // and `delegationCaptureService` forward a third party's words verbatim
  // inside `"${body.slice(0, 300)}"`. A universal finaliser here would
  // rewrite a counterpart whose message happens to open "Hi Basit Ahmed"
  // or "Sir, ..." — misquoting a real human to fix a cosmetic rule. That
  // is DEF-137 with a wider blast radius, and DEF-137 reached review
  // rather than production by luck.
  //
  // Reuses `finaliseUserVisibleProse` deliberately rather than writing a
  // second address policy — the whole defect being closed here is that
  // address handling had two implementations that disagreed.
  //
  // It runs BEFORE the content-fingerprint dedup below, so the hash is
  // taken over the text actually delivered.
  if (req.provenance === 'brain_prose' && req.body) {
    try {
      const [{ getBrainPersona }, { finaliseUserVisibleProse }] = await Promise.all([
        import('../knowledge/brainPersonaService'),
        import('../knowledge/brainComposer'),
      ]);
      const persona = await getBrainPersona(user.id, user.clientNumber);
      const rendered = finaliseUserVisibleProse(req.body, persona);
      if (rendered !== req.body) {
        log.info('owner address policy applied', {
          userId: user.id, kind: req.kind,
          // Bounded — never the full body.
          before: req.body.slice(0, 40), after: rendered.slice(0, 40),
        });
        req = { ...req, body: rendered };
      }
    } catch (e: any) {
      // Never block an owner message on a cosmetic rule.
      log.warn('owner address policy skipped', { userId: user.id, kind: req.kind, error: e?.message });
    }
  }

  // ── Smoke isolation ─────────────────────────────────────────────────
  // Suppress any test-flagged outbound unless explicitly opted in. This
  // is the FIRST check so a stray smoke test on a developer machine
  // can't ever reach a real user's phone, regardless of subsequent
  // logic. bypassRateLimit does NOT bypass this — smoke isolation is
  // about user safety, not test convenience.
  const isSmoke = !!(req.metadata && (req.metadata as any).smoke === true);
  if (isSmoke && !SMOKE_LIVE) {
    return await record({
      ...req, user, channel: 'text', urgency,
      status: 'suppressed', summary: req.summary,
    }, 'smoke_suppressed (set BRAIN_SMOKE_LIVE=1 to allow)');
  }

  // ── Opt-in gate ─────────────────────────────────────────────────────
  // Brain → user WhatsApp is OFF by default. The user must explicitly
  // enable it from Settings → Brain notifications. Until they do, every
  // outbound is suppressed regardless of urgency.
  //
  // Per user 2026-05-10: "we need to provide option to user if he wants
  // brain to communicate him on whatsapp ... brain never response from
  // user". The tenant Brain notifier number exists only to inform the
  // user when something genuinely needs them — and only when the user
  // has chosen to receive those pings.
  //
  // outboundPaused is preserved as a hard kill switch on top of the
  // opt-in: if the user enabled outbound but later wants silence, they
  // flip pause and even legitimate-looking sends are blocked.
  if (bc.outboundEnabled !== true && !req.bypassOptIn) {
    return await record({
      ...req, user, channel: 'text', urgency,
      status: 'suppressed', summary: req.summary,
    }, 'opt_in_required (Settings → Brain notifications → Enable WhatsApp)');
  }
  if (bc.outboundPaused === true) {
    return await record({
      ...req, user, channel: 'text', urgency,
      status: 'suppressed', summary: req.summary,
    }, 'user_paused_outbound');
  }

  // ── Daily cap ──────────────────────────────────────────────────────
  // Hard ceiling on per-user outbound volume per 24h. Catches the
  // worst case of any bug (runaway cron, dispatch loop, content-
  // fingerprint mismatch) before Brain hammers a real user's phone.
  const dailyCap = Number.isFinite(bc.dailyCap) && bc.dailyCap >= 1 ? Math.min(bc.dailyCap, 200) : DEFAULT_DAILY_CAP;
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sentToday = await prisma.brainUserMessage.count({
    where: {
      // DEF-178: every ledger read on this path is (tenant, user)-scoped —
      // a userId alone is never the identity a cap/dedup decision hangs on.
      clientNumber: user.clientNumber,
      userId: user.id,
      createdAt: { gte: since24h },
      status: { in: ['sent', 'partial'] },
    },
  }).catch(() => 0);

  // ── DEF-308: the digest's cap exemption, bounded where it cannot be raced ──
  //
  // The exemption itself is right — a cap that silences its own receipt is
  // CL-043 verbatim — and its comment below claims to be bounded "BY
  // CONSTRUCTION: one send per (user, day)". It was not. On 09-03 at 07:57:41
  // FIFTEEN digests were sent inside one second, they took 15 of the owner's
  // 20 daily slots, and ten inbound human messages were refused to pay for it.
  //
  // DEF-297 fixed the burst with an in-process claim. That is the right guard
  // for a burst and it is silent about the two cases only the chokepoint can
  // cover: a restart mid-burst, and a second process. So the exemption is now
  // conditional on the thing it always claimed. The FIRST digest of the
  // rolling window passes the volume gates; a second is capped like any other
  // kind. Read from sent rows, so nothing can race it — and `catch(() => 1)`
  // because a failed count must WITHHOLD the exemption, never grant it.
  const digestExempt = req.kind === SUPPRESSION_DIGEST_KIND
    ? (await prisma.brainUserMessage.count({
      where: {
        clientNumber: user.clientNumber,
        userId: user.id,
        createdAt: { gte: since24h },
        status: { in: ['sent', 'partial'] },
        kind: SUPPRESSION_DIGEST_KIND,
      },
    }).catch(() => 1)) === 0
    : false;

  // ── DEF-104: diagnostics must never crowd out the user's own messages ──
  //
  // Measured 2026-08-08: exactly 20 of 20 sent, and 3 of them were mine —
  // deploy reports and an ask-recovery notice — while 104 of the owner's real
  // overdue-task reminders were suppressed. The machinery built to stop him
  // missing notifications had started causing him to miss notifications.
  //
  // These kinds report on Brain's own health. They are useful; they are never
  // more useful than the reminder they would displace. So they get a small
  // reserved slice of the budget and are refused well before the cap, leaving
  // the remainder for messages that are actually about the user's work.
  const DIAGNOSTIC_KINDS = new Set([
    'brain_health_alert', 'brain_daily_digest', 'deploy_report',
    'self_upgrade', 'unnotified_answered_ask', 'connector_stale',
  ]);

  // DEF-271 — HOUSEKEEPING gets a slice too, for the same reason and by the same rule.
  //
  // Owner, 2026-09-01: *"it sent multple messages and brain only notify me 2 messages"*. Four
  // people's messages were relayed and two were suppressed. Not dedup — all four carried
  // distinct dedup keys AND distinct content hashes. It was this cap, with 18 of 20 already
  // spent, and the breakdown is the point:
  //
  //     10  open_item_draft_ask      <- asking him for deadlines
  //      5  brain_prompt
  //      2  wa_counterpart_message   <- actual human beings
  //      1  day_brief
  //
  // Half his daily budget went on asking for a deadline on items like "Join Google Meet call",
  // and real people were dropped to pay for it. The diagnostic tier above already states the
  // principle — "never more useful than the reminder they would displace" — and a nag is never
  // more useful than a message from a person. It was simply not in a tier.
  const HOUSEKEEPING_KINDS = new Set([
    'open_item_draft_ask', 'brain_prompt', 'open_item_overdue',
  ]);

  // ONE tier mechanism, two tiers. Copy-pasting the diagnostic block for housekeeping would
  // make this the 11th `protection-with-two-implementations` in a codebase that has recorded ten
  // — and the two would drift the moment either budget rule changed.
  const TIERS: Array<{ kinds: Set<string>; configKey: string; defaultPct: number; label: string }> = [
    { kinds: DIAGNOSTIC_KINDS, configKey: 'notify.diagnostic_budget_pct', defaultPct: 25, label: 'diagnostic' },
    { kinds: HOUSEKEEPING_KINDS, configKey: 'notify.housekeeping_budget_pct', defaultPct: 50, label: 'housekeeping' },
  ];

  for (const tier of TIERS) {
    if (!tier.kinds.has(req.kind)) continue;
    const { getBehaviorValue } = await import('../behaviorConfig');
    const pct = await getBehaviorValue(tier.configKey, {
      userId: user.id, clientNumber: user.clientNumber,
    }).catch(() => tier.defaultPct);
    const tierCap = Math.max(1, Math.floor((dailyCap * pct) / 100));
    const tierToday = await prisma.brainUserMessage.count({
      where: {
        clientNumber: user.clientNumber,
        userId: user.id,
        createdAt: { gte: since24h },
        status: { in: ['sent', 'partial'] },
        kind: { in: [...tier.kinds] },
      },
    }).catch(() => 0);
    if (tierToday >= tierCap) {
      log.warn('tier_budget_exceeded', {
        userId: user.id, kind: req.kind, tier: tier.label, tierToday, tierCap, dailyCap,
      });
      // DEF-277 — the row says WHY it was suppressed. `record`'s reason arg is
      // logged and returned but never persisted, so before this stamp the audit
      // trail could not tell a budget hold from a dedup skip — and the digest
      // below needs exactly that distinction to count what the owner is owed.
      const res = await record({
        ...req, user, channel: 'text', urgency,
        status: 'suppressed', summary: req.summary,
        metadata: { ...(req.metadata ?? {}), suppressedBy: 'budget', suppressReason: `${tier.label}_budget_exceeded` },
      }, `${tier.label}_budget_exceeded (${tierToday}/${tierCap} of ${dailyCap})`);
      if (req.kind !== SUPPRESSION_DIGEST_KIND) void maybeSendSuppressionDigest(user);
      return res;
    }
    break;   // a kind belongs to at most one tier; the first match decides
  }

  // ── DEF-308: enumerate what is PROTECTED, not what competes with it ──
  //
  // Third occurrence of ONE mechanism — Brain's own machinery spends the
  // channel, and a real person's message is dropped to pay for it:
  //
  //   DEF-104, 08-08 — diagnostics took 3 of 20 while 104 of his real overdue
  //                    reminders were suppressed. Fix: a 25% DIAGNOSTIC ceiling.
  //   DEF-271, 09-01 — draft-asks took 10 of 20 and 8 human messages were
  //                    suppressed. Fix: a 50% HOUSEKEEPING ceiling.
  //   DEF-308, 09-03 — the suppression digest, written 09-02, in no tier and
  //                    exempt from the cap outright, took 15 of 20. TEN inbound
  //                    human messages were refused `daily_cap_exceeded`.
  //
  // Each fix so far put a ceiling on whichever competitor had just won, and a
  // ceiling on the competitors cannot close this class, because that set is
  // OPEN: every kind not yet in a tier is the next occurrence. The digest
  // became one the day after it was written, which is as fast as this class
  // can possibly recur.
  //
  // DEF-271's own solution column already named the missing piece — "a relayed
  // human message must outrank a deadline prompt when the budget is short" —
  // and then shipped ceilings instead of the ranking. This is the ranking, and
  // it is stated the only way that closes the class: the protected set is
  // enumerated (see HUMAN_KINDS) and everything else is non-human by default.
  //
  // Looser than the tiers above and tighter than the daily cap below, so the
  // sequence of gates only ever loosens and the most specific reason wins the
  // audit row.
  if (!HUMAN_KINDS.has(req.kind) && !digestExempt) {
    const { getBehaviorValue } = await import('../behaviorConfig');
    const reservePct = await getBehaviorValue('notify.human_reserve_pct', {
      userId: user.id, clientNumber: user.clientNumber,
    }).catch(() => DEFAULT_HUMAN_RESERVE_PCT);
    // At least one slot for people, and at least one for everything else — a
    // 0% or 100% config value must not turn either side of this off entirely.
    const reserve = Math.min(dailyCap - 1, Math.max(1, Math.floor((dailyCap * reservePct) / 100)));
    const nonHumanCap = dailyCap - reserve;
    // Counted over NON-HUMAN sends only. Counting everything would make the
    // reserve self-defeating in the other direction: five real messages would
    // shrink the machinery's allowance by five, so a busy day of people would
    // silence his reminders — DEF-104 with the roles swapped.
    const nonHumanToday = await prisma.brainUserMessage.count({
      where: {
        clientNumber: user.clientNumber,
        userId: user.id,
        createdAt: { gte: since24h },
        status: { in: ['sent', 'partial'] },
        kind: { notIn: [...HUMAN_KINDS] },
      },
    }).catch(() => 0);
    if (nonHumanToday >= nonHumanCap) {
      log.warn('human_reserve_protected', {
        userId: user.id, kind: req.kind, nonHumanToday, nonHumanCap, reserve, dailyCap,
      });
      const res = await record({
        ...req, user, channel: 'text', urgency,
        status: 'suppressed', summary: req.summary,
        metadata: {
          ...(req.metadata ?? {}),
          suppressedBy: 'budget', suppressReason: 'human_reserve_protected',
        },
      }, `human_reserve_protected (${nonHumanToday}/${nonHumanCap}; ${reserve} of ${dailyCap} held for people)`);
      if (req.kind !== SUPPRESSION_DIGEST_KIND) void maybeSendSuppressionDigest(user);
      return res;
    }
  }

  // DEF-277 (C-3 increment 2) — the digest is the cap's own RECEIPT and is the
  // one kind exempt from the cap, because a cap that silences its own receipt
  // is CL-043 verbatim: four humans' messages arrived, two were held, and the
  // owner had to ask where they went. Bounded BY CONSTRUCTION, not by promise:
  // one send per (user, day) via its dedupKey, plus the per-kind 60s limit,
  // quiet hours and the opt-in gate, all of which still apply. This is not a
  // capability allow-list — it is the suppression mechanism's single receipt
  // kind. Guardrail served: no-claim-without-a-receipt, applied to the claim
  // "I am managing your notification volume".
  if (sentToday >= dailyCap && !digestExempt) {
    log.warn('daily_cap_exceeded', { userId: user.id, sentToday, dailyCap });
    const res = await record({
      ...req, user, channel: 'text', urgency,
      status: 'suppressed', summary: req.summary,
      metadata: { ...(req.metadata ?? {}), suppressedBy: 'budget', suppressReason: 'daily_cap_exceeded' },
    }, `daily_cap_exceeded (${sentToday}/${dailyCap} in last 24h)`);
    // DEF-308 — guarded now that the digest can actually reach this branch:
    // unguarded, a refused digest would fire another. The in-process claim
    // would also stop it, but a recursion blocked in only one caller's memory
    // is not blocked.
    if (req.kind !== SUPPRESSION_DIGEST_KIND) void maybeSendSuppressionDigest(user);
    return res;
  }

  // ── Content-fingerprint dedup ──────────────────────────────────────
  // Dedup by SHA-256 of the body text within the last hour. Catches
  // identical-content sends that slipped past the dedupKey/race guards.
  // bypassRateLimit DOES bypass this for admin verify panel; it's the
  // only legitimate case where the same body should be allowed twice.
  //
  // For `system_marker` provenance the body here is still the MARKER — the
  // pre-render stable fact fingerprint (DEF-176, Codex iteration-42 MEDIUM):
  // hashing the deterministic payload instead of the LLM's rendition makes
  // the dedup STRONGER (two phrasings of one fact still collide) and lets
  // rendering move below every suppression gate, so a suppressed message
  // never spends the LLM call.
  if (!req.bypassRateLimit && req.body) {
    const cHash = contentHash(req.body);
    const sinceContent = new Date(Date.now() - CONTENT_DEDUP_WINDOW_MS);
    const dup = await prisma.brainUserMessage.findFirst({
      where: {
        clientNumber: user.clientNumber,
        userId: user.id,
        createdAt: { gte: sinceContent },
        status: { in: ['sent', 'partial'] },
        metadata: { path: ['contentHash'], equals: cHash } as any,
      },
      select: { id: true, createdAt: true },
    }).catch(() => null);
    if (dup) {
      const ageMin = Math.round((Date.now() - dup.createdAt.getTime()) / 60000);
      log.info('content_fp_dup', { userId: user.id, ageMin });
      return await record({
        ...req, user, channel: 'text', urgency,
        status: 'suppressed', summary: req.summary,
        metadata: { ...(req.metadata ?? {}), contentHash: cHash },
      }, `content_fingerprint_dup (identical body sent ${ageMin}m ago)`);
    }
    // Stamp the hash for future dedup checks
    req.metadata = { ...(req.metadata ?? {}), contentHash: cHash };
  }

  // Order: cheap suppression checks (dedup, quiet) before phone resolution.
  // Saves a row + a Meta hit when the message wouldn't have gone anyway,
  // and ensures a duplicate emergency request doesn't spam audit rows
  // even on misconfigured users.

  // ── Dedup check ─────────────────────────────────────────────────────
  if (req.dedupKey && !req.bypassRateLimit) {
    const last = await prisma.brainUserMessage.findFirst({
      where: {
        clientNumber: user.clientNumber,
        userId: user.id, kind: req.kind, dedupKey: req.dedupKey,
        createdAt: { gte: new Date(Date.now() - dedupWindowMs) },
        status: { in: ['sent', 'partial'] },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    }).catch(() => null);
    if (last) {
      const ageMin = Math.round((Date.now() - last.createdAt.getTime()) / 60000);
      log.info('suppressed', { userId: user.id, kind: req.kind, ageMin });
      return await record({
        ...req, user, channel: 'text', urgency,
        status: 'suppressed', summary: req.summary,
      }, `suppressed (last sent ${ageMin}m ago)`);
    }
  }

  // ── Per-kind rate limit ─────────────────────────────────────────────
  // Backstop against twin notifications when dedupKey legitimately
  // changes (e.g. a critical bundle that adds one new item, producing
  // a different sorted-feedEventIds fingerprint). The user got two
  // near-identical pings 60s apart in 2026-05-04 — this guard keeps
  // any one `kind` from firing more than once per 60s, no matter what
  // dedupKey the caller sent.
  const KIND_MIN_INTERVAL_MS = 60_000;
  // ── DEF-294 — a relayed human message is not a duplicate notification ────────────────────
  //
  // Owner, 2026-09-03: *"i also often see that someone has sent messaged to brain but it didnt
  // notify"*. Live evidence: `rate-limited kind=wa_counterpart_message ageSec=8 / 55 / 9`.
  //
  // This limiter exists for a real reason, stated in the comment above — twin pings of the SAME
  // notification 60s apart, when a legitimately-changed `dedupKey` let one through twice. But it
  // keys on `kind`, and **every relayed human message shares one kind**. So a second message
  // inside a minute is dropped as a duplicate of the first — even when it is a DIFFERENT person.
  // Two people writing to him a minute apart and he hears about one.
  //
  // Relays are exempt because their own protection is stronger and per-message, not per-kind:
  // each carries a distinct `dedupKey` (`wa_counterpart:<identity>:<body>`) AND a distinct
  // content hash — verified during DEF-271, where all four relays that day were confirmed
  // distinct on both. The twin-notification failure this guard was built for cannot arise here.
  //
  // Deliberately narrow: every other kind still rate-limits. `open_item_draft_ask` hitting this
  // limiter is the guard doing its job.
  //
  // DEF-308 — reads the same HUMAN_KINDS the volume reserve reads, rather than
  // repeating the literal. Two protections that each decided independently what
  // "a person wrote this" means would be the 11th `protection-with-two-
  // implementations` in a codebase carrying ten, and they would drift the first
  // time a second relay kind is added: it would gain the reserve and silently
  // keep rate-limiting, or the reverse.
  const isRelayedHumanMessage = HUMAN_KINDS.has(req.kind);
  const rec = (!req.bypassRateLimit && !isRelayedHumanMessage) ? await prisma.brainUserMessage.findFirst({
    where: {
      clientNumber: user.clientNumber,
      userId: user.id, kind: req.kind,
      createdAt: { gte: new Date(Date.now() - KIND_MIN_INTERVAL_MS) },
      status: { in: ['sent', 'partial'] },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true },
  }).catch(() => null) : null;
  if (rec) {
    const ageSec = Math.round((Date.now() - rec.createdAt.getTime()) / 1000);
    log.info('rate-limited', { userId: user.id, kind: req.kind, ageSec });
    return await record({
      ...req, user, channel: 'text', urgency,
      status: 'suppressed', summary: req.summary,
    }, `rate_limited (kind sent ${ageSec}s ago)`);
  }

  // ── Quiet hours check ───────────────────────────────────────────────
  if (!bypassQuiet && await isWithinQuietHours(bc, user.id)) {
    return await record({
      ...req, user, channel: 'text', urgency,
      status: 'suppressed', summary: req.summary,
    }, 'quiet_hours');
  }

  // ── Office hours (DEF-120) ──────────────────────────────────────────
  // Stricter than quiet hours and for a different reason: quiet hours protect
  // sleep, office hours protect the working day. 06:11 passed the first and
  // still should not have been sent.
  //
  // Emergencies are exempt — bypassQuiet is already true for them — because a
  // channel that waits for Monday is not an emergency channel.
  if (!bypassQuiet && await isOutsideOfficeHours(user.id, user.clientNumber, bc)) {
    return await record({
      ...req, user, channel: 'text', urgency,
      status: 'suppressed', summary: req.summary,
    }, 'outside_office_hours');
  }

  // ── system_marker rendering boundary (DEF-174/175/176) ──────────────
  //
  // `system_marker` provenance means `body` is an internal bracketed marker,
  // never owner prose. The provenance type had SAID "rendered downstream by
  // `answerSanitizer`" since DEF-140 — but nothing downstream ever did, so
  // the first producer to declare it would have delivered raw machine text
  // (Codex iteration-30 CRITICAL). `sanitizeAnswerInBrainVoice` looks the
  // marker up in the curated meanings (the vetted FACT), lets the
  // `markerVoice` LLM say it naturally, and turns a marker with NO curated
  // meaning into the neutral fallback. A rendering failure must not send the
  // original — the original IS internal text — so the fallback stands:
  // invariant #4, failing closed per #6.
  //
  // POSITION is the contract (Codex iteration-42 MEDIUM, completing
  // iteration-41's): BELOW every suppression gate — smoke, opt-in, pause,
  // both daily caps, content fingerprint (taken over the stable marker
  // payload above), dedup-key, per-kind rate limit, quiet hours, office
  // hours. A message any of those refuse spends no LLM call and hands no
  // payload facts to the provider. Only phone resolution, channel selection
  // and the transport itself sit below this point, and none of them can
  // suppress-by-policy — they can only fail, which is recorded as failure.
  if (req.provenance === 'system_marker' && req.body) {
    let rendered = NEUTRAL_MARKER_FALLBACK;
    try {
      const { sanitizeAnswerInBrainVoice } = await import('../knowledge/answerSanitizer');
      rendered = await sanitizeAnswerInBrainVoice(req.body, {
        userId: user.id, clientNumber: user.clientNumber, audience: 'owner',
      });
    } catch (e: any) {
      log.warn('system_marker rendering failed; neutral fallback delivered', {
        userId: user.id, kind: req.kind, error: e?.message,
      });
    }
    req = { ...req, body: rendered, summary: rendered.slice(0, 120) };
  }

  // ── Resolve target phone ────────────────────────────────────────────
  const targetPhone = bc.whatsappNumber || user.contactNumber || null;
  if (!targetPhone) {
    return await record({
      ...req, user, channel: 'text', urgency,
      status: 'failed', error: 'no_phone',
      summary: req.summary,
    }, 'no_phone');
  }

  // ── Channel resolution ──────────────────────────────────────────────
  // 'auto' picks based on urgency; explicit channels override.
  const channels = channel === 'auto' ? channelsForUrgency(urgency) : [channel];

  const channelsUsed: string[] = [];
  const waMessageIds: string[] = [];
  let lastError: string | null = null;

  for (const ch of channels) {
    try {
      const r = await dispatchChannel(ch, user.clientNumber, targetPhone, req);
      if (r.ok) {
        channelsUsed.push(ch);
        if (r.waMessageId) waMessageIds.push(r.waMessageId);
      } else {
        lastError = r.error ?? 'unknown';
        // Special case: business call not enrolled → fall back to call CTA.
        if (ch === 'call_business' && r.notEnrolled) {
          const cta = await dispatchChannel('call_cta', user.clientNumber, targetPhone, req);
          if (cta.ok) {
            channelsUsed.push('call_cta');
            if (cta.waMessageId) waMessageIds.push(cta.waMessageId);
            lastError = null;
          }
        }
      }
    } catch (err: any) {
      lastError = err.message;
      log.error('dispatch error', { channel: ch, err: err.message });
    }
  }

  // ── EMAIL FALLBACK — last-resort when WhatsApp is unreachable ──
  // Per Basit 2026-07-06: "ensure it will keep connected". Even with
  // auto-heal + watchdog + auto-reinit, there are still failure modes
  // (Meta outage, network partition, WA account temporarily locked)
  // where all WA channels fail. Rather than lose the message entirely,
  // route through email so critical bundles + Day Briefs still reach
  // the user. The tenant's outbound-email channel (Gmail / IMAP-SMTP
  // via sendUserEmail's auto-fallback) is our safety net.
  //
  // Gates:
  //   - All prior WA channels FAILED (channelsUsed.length === 0)
  //   - User has an email address on file
  //   - Not an admin_test / smoke run (metadata check)
  // Body is plain-text; the recipient's mail client renders it.
  if (channelsUsed.length === 0 && user.email && req.kind !== 'admin_test_brain') {
    try {
      const { sendUserEmail } = await import('../gmailService');
      const emailSubject = `[${req.kind}] ${req.summary}`.slice(0, 200);
      const emailBody = [
        `<div style="font-family: -apple-system, system-ui, sans-serif;">`,
        `<p><em>Delivered via email fallback — WhatsApp channel unavailable.</em></p>`,
        `<hr />`,
        `<div style="white-space: pre-wrap;">${escapeHtml(req.body)}</div>`,
        `</div>`,
      ].join('\n');
      const emailResult = await sendUserEmail(user.id, user.email, emailSubject, emailBody);
      if (emailResult.success) {
        channelsUsed.push('email');
        log.info('email fallback succeeded after WA failure', {
          userId: user.id, kind: req.kind, waError: lastError,
        });
        lastError = null;
      } else {
        log.warn('email fallback also failed', {
          userId: user.id, waError: lastError, emailError: emailResult.error,
        });
      }
    } catch (err: any) {
      log.warn('email fallback threw', { userId: user.id, error: err.message });
    }
  }

  const status: 'sent' | 'partial' | 'failed' =
    channelsUsed.length === channels.length ? 'sent'
    : channelsUsed.length > 0 ? 'partial'
    : 'failed';

  // ── DEF-296 — the ledger must never be breakable by a value WE chose ─────────────────────
  //
  // `channel` carries a CHECK constraint. This line put whatever was in `channelsUsed[0]` into
  // it, and when the email fallback set `['email']` — a value the constraint did not permit —
  // the audit INSERT threw and **no row was written**. 31 such failures on 2026-09-02.
  //
  // Losing the audit row is not a bookkeeping detail: the daily cap, the per-kind rate limiter
  // and dedup all read that table. With nothing written, `sentToday` never rose, so **the cap
  // stopped bounding anything the moment WhatsApp failed** — 30 notifications into his inbox in
  // three minutes against a cap of 20. The throttle failed exactly when the channel it protects
  // was already failing, which is the worst possible time.
  //
  // 'email' is now permitted (migration 20260903), so the real channel is recorded. This guard
  // is the other half: a channel name the constraint has never seen must degrade to a value it
  // accepts, never take the ledger down with it. Loud, because a coercion means code and schema
  // have drifted and somebody should reconcile them.
  const AUDIT_CHANNELS = ['text', 'voicenote', 'call_cta', 'call_business', 'auto', 'email'] as const;
  const rawChannel = channelsUsed.length > 1 ? 'auto' : (channelsUsed[0] as any) ?? 'text';
  const channelForAudit: (typeof AUDIT_CHANNELS)[number] =
    (AUDIT_CHANNELS as readonly string[]).includes(rawChannel) ? rawChannel : 'auto';
  if (channelForAudit !== rawChannel) {
    log.error('audit channel not permitted by the schema — recorded as auto', {
      rawChannel, kind: req.kind,
      note: 'code and the brain_user_messages channel CHECK have drifted; reconcile them',
    });
  }

  const result = await record({
    ...req, user,
    channel: channelForAudit,
    urgency, status, error: status === 'failed' ? lastError : null,
    waMessageIds, toPhone: maskPhone(targetPhone),
    summary: req.summary,
  }, status === 'failed' ? `send_failed: ${lastError}` : undefined);

  return {
    ...result,
    channelsUsed,
    waMessageIds,
  };
}

// ─── Channel dispatcher ─────────────────────────────────────────────────

interface DispatchResult { ok: boolean; waMessageId?: string; error?: string; notEnrolled?: boolean; }

async function dispatchChannel(
  ch: string,
  clientNumber: string,
  phone: string,
  req: BrainContactRequest,
): Promise<DispatchResult> {
  // OWNER RULING 2026-09-04 (DEF-320) — *"i want to see real number only anywher on UI and
  // communication"*. Every channel below reads `req.body`, so the scrub happens ONCE here rather
  // than at each `send*` call: the `@lid` class reached five occurrences by being closed one
  // surface at a time, and a per-channel scrub would be the sixth version of the same guard.
  //
  // Mutates the local `req` only — the audit row was already written from the pre-scrub body by
  // `record()` above, which is correct: the ledger should hold what the system produced, and he
  // should receive what he can act on.
  const { scrubSyntheticIdentities } = await import('../whatsapp/displayIdentity');
  if (req.body) req = { ...req, body: await scrubSyntheticIdentities(req.body, clientNumber) };
  switch (ch) {
    case 'text': {
      return await sendTenantWhatsAppText(clientNumber, phone, req.body, req.userId);
    }
    case 'voicenote': {
      const { textToVoiceNote } = await import('../voiceService');
      const audio = await textToVoiceNote(req.body);
      if (!audio) {
        log.warn('voicenote requested but TTS unavailable, falling back to text', {});
        return await sendTenantWhatsAppText(clientNumber, phone, req.body, req.userId);
      }
      return await sendTenantWhatsAppVoiceNote(clientNumber, phone, audio, req.body, req.userId);
    }
    case 'call_cta': {
      const cta = await sendCallNudgeViaNotifier(clientNumber, phone, req.body);
      if (cta.ok) return cta;
      const ctaBody = await composeLegacyCallCta(clientNumber, req.body);
      return await sendTenantWhatsAppText(clientNumber, phone, ctaBody, req.userId);
    }
    case 'call_business': {
      const r = await initiateBusinessCall(clientNumber, phone);
      return { ok: r.ok, waMessageId: r.callId, error: r.error, notEnrolled: r.notEnrolled };
    }
    default:
      return { ok: false, error: `unknown channel "${ch}"` };
  }
}

/**
 * Build a call-CTA body using the legacy webjs `connected_number` since
 * the Meta tenant notifier may be unconfigured. Falls back to a
 * generic "open MyOS" line if no number is stored anywhere.
 */
async function composeLegacyCallCta(clientNumber: string, preamble: string): Promise<string> {
  try {
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT connected_number FROM whatsapp_config WHERE client_number = $1`,
      clientNumber,
    );
    const num = rows?.[0]?.connected_number;
    if (num) return `${preamble.trim()}\n\n📞 Call back: ${num}`;
  } catch { /* ignore */ }
  return `${preamble.trim()}\n\nOpen MyOS to respond.`;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function channelsForUrgency(u: Urgency): Array<'text' | 'voicenote' | 'call_cta' | 'call_business'> {
  switch (u) {
    case 'low':
    case 'normal':   return ['text'];
    case 'high':     return ['text', 'voicenote'];
    case 'emergency':
      // Try business call first; if not enrolled the dispatcher above
      // auto-falls-back to call_cta so the user still gets a tap-to-call.
      return ['voicenote', 'call_business'];
  }
}

/**
 * Quiet hours stored as `{ quietStart: 'HH:MM', quietEnd: 'HH:MM' }` in
 * user.notification_preferences.brain_channel. Times are interpreted in
 * the USER's timezone: brain_channel.timezone if set, else the resolved
 * User.timezone chain (DST-aware via Intl). A range that crosses
 * midnight (e.g. 22:00 → 07:00) is supported.
 */

/**
 * DEF-120 — is it working hours for THIS user, right now?
 *
 * Owner, 2026-08-11: *"brain should send message only in office hour as per
 * region"*. He had just received an intervention notice at 06:11 and another at
 * 08:16. Quiet hours ended at 06:00 so both were legal, and both were wrong:
 * "not asleep" is not "at work", and an assistant that leads with a blocker
 * before the working day starts is one you learn to mute.
 *
 * Evaluated in the USER's timezone, so a tenant in Karachi and one in London
 * each get their own working day with no coordination between them.
 *
 * EMERGENCY IS EXEMPT, deliberately. The point of an emergency channel is that
 * it ignores the calendar; making it wait would quietly turn the one urgent
 * path into the same delayed path as everything else.
 */
async function isOutsideOfficeHours(userId: number, clientNumber: string, bc: any): Promise<boolean> {
  try {
    const { getBehaviorValue } = await import('../behaviorConfig');
    const ctx = { userId, clientNumber };
    const [startH, endH, daysMask] = await Promise.all([
      getBehaviorValue('notify.office_start_hour', ctx).catch(() => 9),
      getBehaviorValue('notify.office_end_hour', ctx).catch(() => 18),
      getBehaviorValue('notify.office_days_mask', ctx).catch(() => 62),
    ]);

    const { resolveUserTimezone, isValidTimezone } = await import('../userTimezoneService');
    const tz = isValidTimezone(bc?.timezone) ? bc.timezone : await resolveUserTimezone(userId);

    // Hour AND weekday from the same formatter call, so a message sent across a
    // midnight boundary cannot be judged on one day's date and another's hour.
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', hour12: false, weekday: 'short',
    }).formatToParts(new Date());
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '12');
    const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
    const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);

    if (dayIndex >= 0 && !((daysMask >> dayIndex) & 1)) return true;   // not a working day
    return hour < startH || hour >= endH;
  } catch {
    // Unknown means SEND. A broken clock lookup must not silence Brain
    // altogether — a message an hour early is a smaller failure than one that
    // never arrives.
    return false;
  }
}

async function isWithinQuietHours(bc: any, userId: number): Promise<boolean> {
  if (!bc?.quietStart || !bc?.quietEnd) return false;
  const { resolveUserTimezone, isValidTimezone } = await import('../userTimezoneService');
  const tz = isValidTimezone(bc.timezone) ? bc.timezone : await resolveUserTimezone(userId);
  const nowLocal = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
  const localMinutes = parseHHMM(nowLocal) ?? 0;
  const start = parseHHMM(bc.quietStart);
  const end = parseHHMM(bc.quietEnd);
  if (start === null || end === null) return false;
  if (start <= end) return localMinutes >= start && localMinutes < end;
  // wraps midnight
  return localMinutes >= start || localMinutes < end;
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s));
  if (!m) return null;
  const h = Number(m[1]); const mn = Number(m[2]);
  if (h < 0 || h > 23 || mn < 0 || mn > 59) return null;
  return h * 60 + mn;
}

/** Mask all but last 4 digits — for audit row display in admin UI. */
function maskPhone(p: string): string {
  const trimmed = p.replace(/^\+/, '');
  if (trimmed.length <= 4) return p;
  return `***${trimmed.slice(-4)}`;
}

// ─── Audit recorder ─────────────────────────────────────────────────────

async function record(
  o: BrainContactRequest & {
    user: { id: number; clientNumber: string };
    channel: string; urgency: Urgency;
    status: 'sent' | 'partial' | 'failed' | 'suppressed';
    error?: string | null;
    waMessageIds?: string[];
    toPhone?: string;
    summary: string;
  },
  reason?: string,
): Promise<BrainContactResult> {
  const row = await prisma.brainUserMessage.create({
    data: {
      clientNumber: o.user.clientNumber,
      userId: o.user.id,
      kind: o.kind,
      channel: o.channel,
      urgency: o.urgency,
      summary: o.summary.slice(0, 500),
      waMessageIds: o.waMessageIds ?? [],
      dedupKey: o.dedupKey ?? null,
      status: o.status,
      error: o.error ?? null,
      toPhone: o.toPhone ?? null,
      metadata: (o.metadata ?? {}) as any,
    },
  }).catch((err) => {
    log.error('audit insert failed', { err: err.message });
    return null;
  });

  // DEF-108 — the dispatch ledger must see this send.
  //
  // Production, 2026-08-10 14:57–15:00. The owner asked "can you read the last
  // 24hr messages you sent to anyone?" and Brain answered "Sir, I haven't sent
  // any messages in the last 24 hours." At that moment the database held 14
  // sends to him and 8 outbound WhatsApp messages to counterparts. He replied
  // "you are wrong, you sent messages to Hamna and Yousaf yesterday, i have
  // seen it" — and he was right.
  //
  // Brain was not lying. DEF-037 made "did I do X?" a LEDGER query rather than
  // a transcript read, which was the correct fix, and dispatchLedgerService
  // reads brain_action_artifacts. But nothing on this path ever wrote an
  // artifact: the table held 20 rows in its entire life, newest 2026-08-08, and
  // the only recent entries were `previewed` — which the ledger rightly
  // excludes, since TERMINAL_OK is ['succeeded','completed','sent'].
  //
  // So there were three records of "what Brain did" and they disagreed:
  // brain_user_messages (14), delegation_thread_events (8), and the one Brain
  // actually reads (0). The DEF-037 header predicted this exact shape — "it
  // genuinely could not see its own past" — and the answer is to FEED the
  // ledger, not to change what Brain trusts.
  //
  // Only real outcomes are recorded. A suppressed or rate-limited message is
  // not a send, and writing one as `succeeded` would be the fabrication the
  // ledger exists to make impossible.
  if (o.status === 'sent' || o.status === 'partial' || o.status === 'failed') {
    try {
      const { recordArtifact } = await import('../knowledge/brainActionArtifactService');
      await recordArtifact({
        clientNumber: o.user.clientNumber,
        userId: o.user.id,
        channel: 'whatsapp',
        actionType: 'notify_via_whatsapp',
        status: o.status === 'failed' ? 'failed' : 'succeeded',
        payload: {
          kind: o.kind,
          urgency: o.urgency,
          recipientPhone: o.toPhone ?? null,
          titleHint: o.summary.slice(0, 120),
        },
        result: { waMessageIds: o.waMessageIds ?? [], channel: o.channel },
        errorMessage: o.error ?? null,
        artifactExtId: o.waMessageIds?.[0] ?? null,
      });
    } catch (err: any) {
      // Never break a delivered send over its own bookkeeping — but say so,
      // because a silent miss here is precisely how the ledger went empty.
      log.error('dispatch ledger write failed — Brain will not remember this send', {
        kind: o.kind, err: err?.message,
      });
    }
  }

  // DEF-117 — the thread must contain what the owner was actually sent.
  //
  // The ledger above answers "did I send it?". It does not put the message in
  // the conversation, and the conversation is what resolves "did u ask this
  // from Hamna?" 34 minutes after a reminder went out. See
  // sessionHistoryService for the production trace.
  //
  // `sent` and `partial` only: on a partial the owner received it on at least
  // one channel. A failed or suppressed send never reached him, and recording
  // it as something Brain said would be a fabrication in the thread.
  if (o.status === 'sent' || o.status === 'partial') {
    try {
      const { appendBrainTurnToSession } = await import('../whatsapp/sessionHistoryService');
      await appendBrainTurnToSession(o.user.clientNumber, o.user.id, o.body);
    } catch (err: any) {
      // Same rule as the ledger: never break a delivered send over bookkeeping,
      // never let the miss be silent.
      log.error('thread history append failed — Brain will not see this message next turn', {
        kind: o.kind, err: err?.message,
      });
    }
  }

  return {
    sent: o.status === 'sent' || o.status === 'partial',
    reason,
    // DEF-304 — surfaced from the row that was just written, so the value the
    // caller branches on is the value the audit trail recorded.
    suppressedBy: (o.metadata as any)?.suppressedBy,
    channelsUsed: o.waMessageIds?.length ? [o.channel] : [],
    waMessageIds: o.waMessageIds ?? [],
    recordId: row ? String(row.id) : undefined,
  };
}

/** Escape HTML for the email fallback body — plain text goes into a
 *  pre-wrap div so newlines survive; this prevents accidental HTML
 *  injection when Brain's body contains angle brackets / ampersands. */
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ─── DEF-277 · C-3 increment 2 — a held notification leaves a receipt ────────
//
// CL-043, measured: four people's messages arrived in one morning; two were
// relayed and two were suppressed by the daily cap, silently. The owner had to
// ask *"it sent multple messages and brain only notify me 2 messages"* — the
// budget machinery was working and the silence around it was the defect. A
// professional assistant may hold notifications; it may not hold them without
// saying so. This digest is that receipt: ONE message per (user, day) naming
// how many were held and of what kinds, sent the first time the window's
// budget actually holds something back.
//
// Reversibility and retrievability are already true and are relied on, not
// re-implemented: every held push is a `brain_user_messages` row (status
// `suppressed`, now stamped with WHY), counterpart bodies stay readable via
// the relay record (DEF-270/273), and the model can quote any of it when the
// owner asks. This function adds the one missing piece — the owner learning
// that there is something to ask about.

/** The one kind exempt from the caps it reports on. Exported for tests and
 *  for the exemption check in `brainContactsUser`. */
export const SUPPRESSION_DIGEST_KIND = 'suppressed_pushes_digest';

/**
 * DEF-297 — the anti-spam mechanism spammed him fifteen times in one second.
 *
 * 2026-09-03 12:57:40–41. He asked who had messaged him and received **15 near-identical digests
 * inside two seconds**, each with a DIFFERENT total: 717, 725, 722, 713, 680, 676, 674, 721, 687,
 * 716, 719, 714, 732, 715, 668.
 *
 * `maybeSendSuppressionDigest` is fired **`void`-style on every budget hold**, so a burst of 37
 * held draft-asks in one tick starts 37 concurrent calls. Three guards already stand in their
 * way — a compose-time "already sent?" read, a constant `dedupKey`, and the per-kind 60s limiter
 * — and **all three are read-then-act**, so the burst defeated all three simultaneously: every
 * call read "none sent yet" before any of them had written. Each then made its own model call,
 * which is why the wording differs, and computed `held.length` at its own moment, which is why
 * the numbers differ.
 *
 * The missing guard is not a fourth check of the same kind. It is MUTUAL EXCLUSION. These calls
 * all originate in one process in the same instant, so an in-process claim collapses the burst to
 * one attempt; the existing DB checks continue to handle the across-restart and across-window
 * cases they were written for.
 *
 * Deliberately a claim rather than a queue: the others should DROP, not wait and then send. One
 * digest is the whole point of a digest.
 */
const digestInFlight = new Set<string>();

/**
 * Clear the in-flight digest claims. Tests drive the digest through `brainContactsUser`, which
 * fires it `void`-style, so an attempt from one test can still hold its claim when the next
 * begins — module state leaking across tests rather than a production concern (production
 * releases in `finally`). Same convention as `__resetWaIdentityCacheForTests`.
 */
export function __resetSuppressionDigestClaimsForTests(): void {
  digestInFlight.clear();
}

/** Exported for tests: the digest must be provable through the real outbound
 *  chokepoint, not a re-implementation. Never throws — a failed digest leaves
 *  the suppression exactly as it was (silent), which is the pre-DEF-277 state,
 *  never a broken send path. */
export async function maybeSendSuppressionDigest(
  user: { id: number; clientNumber: string },
): Promise<void> {
  // DEF-297 — claim FIRST, before any await. Every guard below is read-then-act, so a burst of
  // concurrent calls sails past all of them together; this is the only one that cannot be raced,
  // because the claim and its check happen in a single synchronous step.
  const claim = `${user.clientNumber}:${user.id}`;
  if (digestInFlight.has(claim)) return;
  digestInFlight.add(claim);
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const held = await prisma.brainUserMessage.findMany({
      where: {
        clientNumber: user.clientNumber,
        userId: user.id,
        createdAt: { gte: since },
        status: 'suppressed',
        kind: { not: SUPPRESSION_DIGEST_KIND },
        // Only BUDGET holds. A dedup-suppressed duplicate cost the owner
        // nothing and does not belong in a "you missed something" count.
        metadata: { path: ['suppressedBy'], equals: 'budget' },
      },
      select: { kind: true, summary: true },
    });
    if (held.length === 0) return;

    // Codex iteration-62 §3 (a) — the model call must not run once the
    // window's digest is already delivered. The hook fires on EVERY budget
    // hold, and before this check a 40-hold burst would spend ~39 compose
    // calls for the one digest dedup would deliver. Same read the dedup gate
    // performs later, done BEFORE composition; `sent`/`partial` only, so a
    // quiet-hours or office-hours hold still retries with a fresh compose.
    const alreadySent = await prisma.brainUserMessage.findFirst({
      where: {
        clientNumber: user.clientNumber,
        userId: user.id,
        kind: SUPPRESSION_DIGEST_KIND,
        createdAt: { gte: since },
        status: { in: ['sent', 'partial'] },
      },
      select: { id: true },
    });
    if (alreadySent) return;

    const byKind = new Map<string, number>();
    for (const h of held) byKind.set(h.kind, (byKind.get(h.kind) ?? 0) + 1);
    const counts = [...byKind.entries()].map(([k, n]) => `${k}: ${n}`).join(', ');
    const samples = held.slice(0, 3).map((h) => `- ${String(h.summary).slice(0, 100)}`).join('\n');
    const facts = `${held.length} notification(s) in the last 24h were HELD by the volume budget `
      + `rather than sent. Counts by kind: ${counts}. Sample summaries:\n${samples}`;

    // Wording belongs to the model (owner ruling 2026-08-19). The curated
    // fallback below carries the same FACTS and is used only when the model is
    // unreachable — the one case the ruling allows a fixed string.
    let body: string;
    try {
      const { callLLM } = await import('../llmRouter');
      const r = await callLLM(
        'You are Nexeo, writing ONE short WhatsApp message to your owner. Say plainly, in your '
        + 'own words: some notifications were held today because his volume budget filled; how '
        + 'many and of what kinds (keep the numbers exactly as given); and that nothing was '
        + 'dropped — everything held is kept and he can ask to see any of it. Under 400 '
        + 'characters, no markdown, no apology.',
        facts,
        { maxTokens: 300, timeoutMs: 12_000 },
      );
      body = String((r as any)?.text ?? '').trim();
      if (!body) throw new Error('empty completion');
    } catch {
      body = `Held today instead of sent (volume budget full): ${held.length} notification(s) — `
        + `${counts}. Nothing was dropped; everything held is kept, and you can ask to see any of it.`;
    }

    await brainContactsUser({
      userId: user.id,
      clientNumber: user.clientNumber,
      kind: SUPPRESSION_DIGEST_KIND,
      provenance: 'brain_prose',
      summary: `suppression digest: ${held.length} held in the last 24h`,
      body,
      urgency: 'low',
      // Codex iteration-62 §3 (b) — the key is CONSTANT, and the 24h dedup
      // window is what bounds it. The first version keyed on the calendar
      // date, which re-arms at midnight: a 23:00 digest could be followed by
      // an 01:00 digest re-counting the same rolling-24h holds. A constant
      // key + the rolling window make it once per rolling 24h by
      // construction. Quiet hours still hold it (dedup counts only
      // sent/partial, so a hold retries rather than burning the window).
      dedupKey: 'suppression-digest',
      dedupWindowMs: 24 * 60 * 60 * 1000,
      metadata: { heldCount: held.length, byKind: Object.fromEntries(byKind) },
    });
  } catch (e: any) {
    log.warn('suppression digest failed — held pushes stay silent this window', {
      userId: user.id, error: e?.message,
    });
  } finally {
    // Released in `finally` so a throw anywhere above cannot wedge the claim and silence every
    // future digest — the opposite failure, and a worse one than a duplicate.
    digestInFlight.delete(claim);
  }
}
