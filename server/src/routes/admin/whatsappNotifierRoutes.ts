import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import {
  getNotifier, saveNotifier, pingNotifier, sendViaNotifier,
  sendVoiceNoteViaNotifier, sendCallNudgeViaNotifier, initiateBusinessCall,
} from '../../services/notifications/whatsappNotifierService';
import prisma from '../../db/prisma';
import {
  mirrorNotifierCredentials,
  storeMetaWebhookSecret,
} from '../../services/whatsapp/whatsappNotifierConfigMirror';

/** Public base URL — derived from env, used to render the webhook callback URL
 *  in the admin UI so the operator can copy/paste it into Meta's webhook page. */
function publicBaseUrl(req: Request): string {
  return process.env.PUBLIC_BASE_URL
      || `${req.protocol}://${req.get('host')}`.replace(/^http:/, 'https:');
}

const router = Router();

// All routes require tenant admin (SA or AD)
function requireAdmin(req: Request, res: Response, next: Function) {
  const u = (req as any).user;
  if (!u?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  if (u.userType !== 'SA' && u.userType !== 'AD') return res.status(403).json({ error: 'admin only' });
  return next();
}

/** GET /api/v1/admin/whatsapp-notifier — read current config (tokens redacted).
 *  Also returns the inbound webhook state from `whatsapp_config` so the admin
 *  UI can show whether the webhook is wired (callback URL, has-secret flag,
 *  current provider). Operator copies the callbackUrl into Meta's webhook
 *  page; verifyToken is generated separately via POST /webhook-secret. */
router.get('/whatsapp-notifier', requireAdmin, async (req: Request, res: Response) => {
  const u = (req as any).user;
  const n = await getNotifier(u.clientNumber);

  // Inbound webhook state (separate table). Outbound notifier setup never
  // changes this provider; switching inbound transport is an explicit action.
  const cfg = await prisma.$queryRawUnsafe<Array<{
    provider: string | null;
    meta_webhook_secret: string | null;
  }>>(
    `SELECT provider, meta_webhook_secret FROM whatsapp_config WHERE client_number = $1 LIMIT 1`,
    u.clientNumber,
  ).catch(() => [] as any[]);

  const webhook = {
    callbackUrl: `${publicBaseUrl(req)}/api/v1/webhooks/whatsapp/${u.clientNumber}`,
    hasSecret: !!cfg[0]?.meta_webhook_secret,
    secretPreview: cfg[0]?.meta_webhook_secret
      ? `${cfg[0].meta_webhook_secret.slice(0, 6)}…${cfg[0].meta_webhook_secret.slice(-4)}`
      : null,
    provider: cfg[0]?.provider ?? null,
  };

  if (!n) return res.json({ configured: false, webhook });
  res.json({
    configured: true,
    provider: n.provider,
    displayNumber: n.displayNumber,
    phoneNumberId: n.phoneNumberId,
    appId: n.appId,
    wabaId: n.wabaId,
    isActive: n.isActive,
    callingEnabled: n.callingEnabled,
    verifiedAt: n.verifiedAt,
    lastSendAt: n.lastSendAt,
    lastError: n.lastError,
    lastCallAt: n.lastCallAt,
    lastCallError: n.lastCallError,
    hasToken: !!n.accessTokenEncrypted,
    webhook,
  });
});

/** PUT /api/v1/admin/whatsapp-notifier — save outbound credentials.
 *  Mirrors only Meta credential fields into `whatsapp_config`. It deliberately
 *  preserves the inbound provider/session: QR/Web.js inbound and Meta outbound
 *  are valid at the same time. Inbound transport is switched separately via
 *  the explicit /admin/whatsapp/config endpoint. */
router.put('/whatsapp-notifier', requireAdmin, async (req: Request, res: Response) => {
  const u = (req as any).user;
  const { displayNumber, phoneNumberId, accessToken, appId, wabaId } = req.body ?? {};
  if (!displayNumber || !phoneNumberId) {
    return res.status(400).json({ error: 'displayNumber and phoneNumberId required' });
  }
  // accessToken is optional on UPDATE (existing token kept) but required on first save
  if (!accessToken) {
    const existing = await getNotifier(u.clientNumber);
    if (!existing?.accessTokenEncrypted) {
      return res.status(400).json({ error: 'accessToken required on first save' });
    }
  }
  await saveNotifier(u.clientNumber, { displayNumber, phoneNumberId, accessToken, appId, wabaId });

  // Mirror credentials for a future/active Meta webhook, but do not mutate
  // provider, status, connected_number, QR state, or session state.
  try {
    await mirrorNotifierCredentials({
      clientNumber: u.clientNumber,
      phoneNumberId,
      accessToken,
      wabaId,
    });
  } catch (err: any) {
    // Mirror failure is non-fatal for outbound sending. Surface it so the
    // operator knows the shared Meta credential row is not current.
    return res.json({ ok: true, mirrorWarning: err.message });
  }
  res.json({ ok: true, inboundProviderPreserved: true });
});

/** POST /api/v1/admin/whatsapp-notifier/webhook-secret — generate + store a
 *  fresh verify token in whatsapp_config.meta_webhook_secret. Returns the
 *  plaintext ONCE so the operator can paste it into Meta's webhook page.
 *  Re-calling generates a new token (old one stops working immediately —
 *  the operator must update Meta's webhook config to match). */
router.post('/whatsapp-notifier/webhook-secret', requireAdmin, async (req: Request, res: Response) => {
  const u = (req as any).user;
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    await storeMetaWebhookSecret(u.clientNumber, secret);
    res.json({
      ok: true,
      verifyToken: secret,
      callbackUrl: `${publicBaseUrl(req)}/api/v1/webhooks/whatsapp/${u.clientNumber}`,
      inboundProviderPreserved: true,
      hint: 'Paste verifyToken into Meta\'s "Verify token" field. The handshake will work when it matches. To receive through Meta, explicitly select Meta as the inbound provider in WhatsApp configuration.',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /api/v1/admin/whatsapp-notifier/ping — verify credentials via Meta. */
router.post('/whatsapp-notifier/ping', requireAdmin, async (req: Request, res: Response) => {
  const u = (req as any).user;
  const r = await pingNotifier(u.clientNumber);
  res.json(r);
});

/** POST /api/v1/admin/whatsapp-notifier/test — send a test message to a phone. */
router.post('/whatsapp-notifier/test', requireAdmin, async (req: Request, res: Response) => {
  const u = (req as any).user;
  const { toPhone, body } = req.body ?? {};
  if (!toPhone) return res.status(400).json({ error: 'toPhone required' });
  const r = await sendViaNotifier(u.clientNumber, String(toPhone), String(body ?? 'MyOS notifier test message.'));
  res.json(r);
});

/** POST /api/v1/admin/whatsapp-notifier/disable — flip is_active=false. */
router.post('/whatsapp-notifier/disable', requireAdmin, async (req: Request, res: Response) => {
  const u = (req as any).user;
  await prisma.tenantWhatsappNotifier.updateMany({
    where: { clientNumber: u.clientNumber },
    data: { isActive: false },
  });
  res.json({ ok: true });
});

/**
 * POST /admin/whatsapp-notifier/test-voice — send a TTS voice note.
 * Generates an OGG/Opus voice note from the supplied text via Google TTS,
 * uploads it to Meta /media, and delivers as a voice bubble. Useful to
 * verify GOOGLE_APPLICATION_CREDENTIALS + Meta media path before wiring
 * Brain emergency triggers.
 */
router.post('/whatsapp-notifier/test-voice', requireAdmin, async (req: Request, res: Response) => {
  const u = (req as any).user;
  const { toPhone, body } = req.body ?? {};
  if (!toPhone) return res.status(400).json({ error: 'toPhone required' });
  const text = String(body ?? 'This is a Brain voice note test from MyOS.');
  const { textToVoiceNote } = await import('../../services/voiceService');
  const audio = await textToVoiceNote(text);
  if (!audio) return res.json({ ok: false, error: 'TTS unavailable (no GOOGLE_APPLICATION_CREDENTIALS or quota exhausted)' });
  const r = await sendVoiceNoteViaNotifier(u.clientNumber, String(toPhone), audio, 'audio/ogg');
  res.json(r);
});

/**
 * POST /admin/whatsapp-notifier/test-call-cta — send a tap-to-call nudge.
 * Renders a text message with the tenant display number on its own line
 * so WhatsApp's number-detection makes it tap-to-call. Works on every
 * tenant — no Calling API enrollment required.
 */
router.post('/whatsapp-notifier/test-call-cta', requireAdmin, async (req: Request, res: Response) => {
  const u = (req as any).user;
  const { toPhone, body } = req.body ?? {};
  if (!toPhone) return res.status(400).json({ error: 'toPhone required' });
  const r = await sendCallNudgeViaNotifier(
    u.clientNumber, String(toPhone),
    String(body ?? 'Brain wants to discuss something with you. Tap the number below to call back.'),
  );
  res.json(r);
});

/**
 * POST /admin/whatsapp-notifier/test-call — initiate WhatsApp Business
 * Calling API call. Returns notEnrolled=true with a clear message when
 * the tenant phone isn't yet approved by Meta — admin then knows to
 * apply for enrollment or rely on the call-CTA path instead.
 */
router.post('/whatsapp-notifier/test-call', requireAdmin, async (req: Request, res: Response) => {
  const u = (req as any).user;
  const { toPhone } = req.body ?? {};
  if (!toPhone) return res.status(400).json({ error: 'toPhone required' });
  const r = await initiateBusinessCall(u.clientNumber, String(toPhone));
  res.json(r);
});

/**
 * POST /admin/whatsapp-notifier/calling-enabled — admin toggles whether
 * Brain may use the WhatsApp Business Calling API. Should only flip ON
 * after Meta confirms the tenant phone is enrolled, otherwise emergency
 * paths waste a call attempt before falling back to call-CTA.
 */
router.post('/whatsapp-notifier/calling-enabled', requireAdmin, async (req: Request, res: Response) => {
  const u = (req as any).user;
  const enabled = !!req.body?.enabled;
  await prisma.tenantWhatsappNotifier.updateMany({
    where: { clientNumber: u.clientNumber },
    data: { callingEnabled: enabled },
  });
  res.json({ ok: true, callingEnabled: enabled });
});

/**
 * GET /admin/brain-outbound/recent — last N rows from brain_user_messages
 * for the admin's tenant, so the Verify panel can show what Brain has
 * actually been sending users (proactive pings, suppressed dedups,
 * failures). Defaults to 20 rows. Phone numbers come back masked
 * (last 4 digits) — the audit row already stores them masked.
 */
router.get('/brain-outbound/recent', requireAdmin, async (req: Request, res: Response) => {
  const u = (req as any).user;
  const limit = Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 100);
  const rows = await prisma.brainUserMessage.findMany({
    where: { clientNumber: u.clientNumber },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true, kind: true, channel: true, urgency: true,
      summary: true, status: true, error: true, toPhone: true,
      createdAt: true, dedupKey: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });
  res.json({
    rows: rows.map((r) => ({ ...r, id: String(r.id) })),
  });
});

/**
 * POST /admin/whatsapp-notifier/test-brain — send a Brain → user message
 * through the **unified** primitive (`brainContactsUser`). Exercises:
 *   - Meta tenant Notifier first (will fail until configured)
 *   - Legacy webjs fallback when Meta is unconfigured
 *   - Audit row in brain_user_messages
 *   - Dedup window (skip duplicates in 20 min)
 *
 * This is the path Brain actually uses for criticality alerts and any
 * other proactive ping. If this button works, criticality emails / open-
 * item nudges / standing-instruction fires will all reach the user.
 */
router.post('/whatsapp-notifier/test-brain', requireAdmin, async (req: Request, res: Response) => {
  const u = (req as any).user;
  const { toUserId, body, urgency, channel } = req.body ?? {};
  if (!toUserId) return res.status(400).json({ error: 'toUserId required' });
  const { brainContactsUser } = await import('../../services/notifications/brainOutboundService');
  const r = await brainContactsUser({
    userId: Number(toUserId),
    kind: 'admin_test_brain',
    summary: 'Admin → Brain → user end-to-end test',
    body: String(body ?? '🔴 Brain test (criticality channel): this came from a non-WhatsApp source.'),
    urgency: (urgency ?? 'normal') as any,
    // Optional explicit channel override for verify-panel tests that
    // need to exercise a specific path regardless of urgency mapping.
    // Accepts: 'text' | 'voicenote' | 'call_cta' | 'call_business' | 'auto'
    // If absent, channelsForUrgency() picks based on urgency.
    ...(channel ? { channel: String(channel) as any } : {}),
    dedupKey: `admin_test_${Date.now()}`,
    // The verify panel fires up to 6 cards back-to-back. The 60s
    // per-kind rate limit is meant for production criticality bundling,
    // not for admin probing — bypass so each card can land its own
    // outbound message + audit row instead of suppressing 5 of 6.
    bypassRateLimit: true,
  });
  res.json(r);
});

/**
 * POST /admin/nexeo-loop/notify — stage 5 of the autonomous loop.
 *
 * Owner ruling 2026-08-07: *"after every deploy i want you to evaluate the brain
 * capability if you have improved it significantly improved then notify me"*,
 * delivered *"through whatsapp"*.
 *
 * WHY A ROUTE AND NOT A SCRIPT: the first attempt was a standalone CLI calling
 * `brainContactsUser` directly. It worked exactly once and cost 45 seconds of
 * channel liveness — an out-of-process caller constructs its OWN webjs client
 * against the same LocalAuth session directory the running server holds, clears
 * what it thinks are stale chromium locks, and the live client fails its next
 * liveness probe (`probe_fail → bounded_reinit`, 2026-08-07 19:02:15). This is
 * the "sessions going deaf after restart" trap AGENTS.md §4 warns about. Only
 * the process that owns the WhatsApp client may send on it, so the loop asks
 * the server over loopback rather than reaching for the session itself.
 *
 * Distinct from `/whatsapp-notifier/test-brain`, which is a verify-panel probe
 * and hardcodes `kind: 'admin_test_brain'`. Deploy reports must carry their own
 * kind and summary, because `brain_user_messages` is the ledger that answers
 * "was the owner actually TOLD?" — filing real reports under a test kind would
 * corrupt the one record that question depends on.
 */
router.post('/nexeo-loop/notify', requireAdmin, async (req: Request, res: Response) => {
  const { toUserId, kind, summary, body, urgency, dedupKey } = req.body ?? {};
  if (!toUserId) return res.status(400).json({ error: 'toUserId required' });
  if (!summary || !body) return res.status(400).json({ error: 'summary and body are both required' });

  const { brainContactsUser } = await import('../../services/notifications/brainOutboundService');
  const r = await brainContactsUser({
    userId: Number(toUserId),
    kind: String(kind || 'nexeo_loop_report'),
    summary: String(summary),
    body: String(body),
    urgency: (urgency ?? 'normal') as any,
    // DEF-084 is an owner ruling, not a default: a deploy report is the worst
    // possible thing to deliver as synthesised speech — it cannot be skimmed,
    // searched or re-read, and a mishearing is silent.
    channel: 'text',
    dedupKey: dedupKey === null ? null : String(dedupKey ?? `nexeo_loop:${new Date().toISOString().slice(0, 10)}`),
  });
  res.json(r);
});

export default router;
