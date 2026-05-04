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

export async function brainContactsUser(req: BrainContactRequest): Promise<BrainContactResult> {
  const urgency: Urgency = req.urgency ?? 'normal';
  const channel = req.channel ?? 'auto';
  const dedupWindowMs = req.dedupWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
  const bypassQuiet = req.bypassQuietHours ?? (urgency === 'emergency');

  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: {
      id: true, name: true, clientNumber: true,
      contactNumber: true, notificationPreferences: true,
    },
  });
  if (!user) {
    return { sent: false, reason: 'user_not_found', channelsUsed: [], waMessageIds: [] };
  }

  const prefs = (user.notificationPreferences as any) ?? {};
  const bc = prefs.brain_channel ?? {};

  // Order: cheap suppression checks (dedup, quiet) before phone resolution.
  // Saves a row + a Meta hit when the message wouldn't have gone anyway,
  // and ensures a duplicate emergency request doesn't spam audit rows
  // even on misconfigured users.

  // ── Dedup check ─────────────────────────────────────────────────────
  if (req.dedupKey) {
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
  const rec = await prisma.brainUserMessage.findFirst({
    where: {
      userId: user.id, kind: req.kind,
      createdAt: { gte: new Date(Date.now() - KIND_MIN_INTERVAL_MS) },
      status: { in: ['sent', 'partial'] },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true },
  }).catch(() => null);
  if (rec) {
    const ageSec = Math.round((Date.now() - rec.createdAt.getTime()) / 1000);
    log.info('rate-limited', { userId: user.id, kind: req.kind, ageSec });
    return await record({
      ...req, user, channel: 'text', urgency,
      status: 'suppressed', summary: req.summary,
    }, `rate_limited (kind sent ${ageSec}s ago)`);
  }

  // ── Quiet hours check ───────────────────────────────────────────────
  if (!bypassQuiet && isWithinQuietHours(bc)) {
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
 * the tenant's timezone (PKT for now). A range that crosses midnight
 * (e.g. 22:00 → 07:00) is supported.
 */
function isWithinQuietHours(bc: any): boolean {
  if (!bc?.quietStart || !bc?.quietEnd) return false;
  const now = new Date();
  // PKT offset (UTC+5). Cheap conversion — we don't need DST precision since
  // PKT doesn't observe it. Keep central if other tenants come online.
  const pktMinutes = ((now.getUTCHours() + 5) % 24) * 60 + now.getUTCMinutes();
  const start = parseHHMM(bc.quietStart);
  const end = parseHHMM(bc.quietEnd);
  if (start === null || end === null) return false;
  if (start <= end) return pktMinutes >= start && pktMinutes < end;
  // wraps midnight
  return pktMinutes >= start || pktMinutes < end;
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

  return {
    sent: o.status === 'sent' || o.status === 'partial',
    reason,
    channelsUsed: o.waMessageIds?.length ? [o.channel] : [],
    waMessageIds: o.waMessageIds ?? [],
    recordId: row ? String(row.id) : undefined,
  };
}
