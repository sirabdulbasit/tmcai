import { Router, Request, Response } from 'express';
import {
  getNotifier, saveNotifier, pingNotifier, sendViaNotifier,
  sendVoiceNoteViaNotifier, sendCallNudgeViaNotifier, initiateBusinessCall,
} from '../../services/notifications/whatsappNotifierService';
import prisma from '../../db/prisma';

const router = Router();

// All routes require tenant admin (SA or AD)
function requireAdmin(req: Request, res: Response, next: Function) {
  const u = (req as any).user;
  if (!u?.clientNumber) return res.status(401).json({ error: 'unauthenticated' });
  if (u.userType !== 'SA' && u.userType !== 'AD') return res.status(403).json({ error: 'admin only' });
  return next();
}

/** GET /api/v1/admin/whatsapp-notifier — read current config (tokens redacted). */
router.get('/whatsapp-notifier', requireAdmin, async (req: Request, res: Response) => {
  const u = (req as any).user;
  const n = await getNotifier(u.clientNumber);
  if (!n) return res.json({ configured: false });
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
  });
});

/** PUT /api/v1/admin/whatsapp-notifier — save (encrypts token). */
router.put('/whatsapp-notifier', requireAdmin, async (req: Request, res: Response) => {
  const u = (req as any).user;
  const { displayNumber, phoneNumberId, accessToken, appId, wabaId } = req.body ?? {};
  if (!displayNumber || !phoneNumberId || !accessToken) {
    return res.status(400).json({ error: 'displayNumber, phoneNumberId, accessToken required' });
  }
  await saveNotifier(u.clientNumber, { displayNumber, phoneNumberId, accessToken, appId, wabaId });
  res.json({ ok: true });
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
  const { toUserId, body, urgency } = req.body ?? {};
  if (!toUserId) return res.status(400).json({ error: 'toUserId required' });
  const { brainContactsUser } = await import('../../services/notifications/brainOutboundService');
  const r = await brainContactsUser({
    userId: Number(toUserId),
    kind: 'admin_test_brain',
    summary: 'Admin → Brain → user end-to-end test',
    body: String(body ?? '🔴 Brain test (criticality channel): this came from a non-WhatsApp source.'),
    urgency: (urgency ?? 'normal') as any,
    dedupKey: `admin_test_${Date.now()}`,
  });
  res.json(r);
});

export default router;
