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
 *     userId, kind: 'critical_bundle', urgency: 'high',
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

const log = createLogger('brain-outbound');

export type Urgency = 'low' | 'normal' | 'high' | 'emergency';

export interface BrainContactRequest {
  userId: number;
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
  channel?: 'text' | 'voicenote' | 'call_cta' | 'call_business' | 'auto';
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

  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      id: true, name: true, email: true, clientNumber: true, isActive: true,
      contactNumber: true, notificationPreferences: true,
    },
  });
  if (!user) {
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
      userId: user.id,
      createdAt: { gte: since24h },
      status: { in: ['sent', 'partial'] },
    },
  }).catch(() => 0);
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
  if (DIAGNOSTIC_KINDS.has(req.kind)) {
    const { getBehaviorValue } = await import('../behaviorConfig');
    const pct = await getBehaviorValue('notify.diagnostic_budget_pct', {
      userId: user.id, clientNumber: user.clientNumber,
    }).catch(() => 25);
    const diagnosticCap = Math.max(1, Math.floor((dailyCap * pct) / 100));
    const diagnosticsToday = await prisma.brainUserMessage.count({
      where: {
        userId: user.id,
        createdAt: { gte: since24h },
        status: { in: ['sent', 'partial'] },
        kind: { in: [...DIAGNOSTIC_KINDS] },
      },
    }).catch(() => 0);
    if (diagnosticsToday >= diagnosticCap) {
      log.warn('diagnostic_budget_exceeded', {
        userId: user.id, kind: req.kind, diagnosticsToday, diagnosticCap, dailyCap,
      });
      return await record({
        ...req, user, channel: 'text', urgency,
        status: 'suppressed', summary: req.summary,
      }, `diagnostic_budget_exceeded (${diagnosticsToday}/${diagnosticCap} of ${dailyCap})`);
    }
  }

  if (sentToday >= dailyCap) {
    log.warn('daily_cap_exceeded', { userId: user.id, sentToday, dailyCap });
    return await record({
      ...req, user, channel: 'text', urgency,
      status: 'suppressed', summary: req.summary,
    }, `daily_cap_exceeded (${sentToday}/${dailyCap} in last 24h)`);
  }

  // ── Content-fingerprint dedup ──────────────────────────────────────
  // Dedup by SHA-256 of the body text within the last hour. Catches
  // identical-content sends that slipped past the dedupKey/race guards.
  // bypassRateLimit DOES bypass this for admin verify panel; it's the
  // only legitimate case where the same body should be allowed twice.
  if (!req.bypassRateLimit && req.body) {
    const cHash = contentHash(req.body);
    const sinceContent = new Date(Date.now() - CONTENT_DEDUP_WINDOW_MS);
    const dup = await prisma.brainUserMessage.findFirst({
      where: {
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
  const rec = !req.bypassRateLimit ? await prisma.brainUserMessage.findFirst({
    where: {
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

  const channelForAudit: 'text' | 'voicenote' | 'call_cta' | 'call_business' | 'auto' =
    channelsUsed.length > 1 ? 'auto' :
    (channelsUsed[0] as any) ?? 'text';

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

  return {
    sent: o.status === 'sent' || o.status === 'partial',
    reason,
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
