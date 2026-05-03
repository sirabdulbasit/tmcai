// ═════════════════════════════════════════════════════════════════════════════
// whatsappAdminRoutes.ts — Admin WhatsApp configuration and management
// All routes require requireAuth + requireAdmin
// ═════════════════════════════════════════════════════════════════════════════

import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../../middleware/auth';
import prisma from '../../db/prisma';
import {
  getProvider, saveWhatsAppConfig, clearProviderCache,
  sendWhatsAppMessage, approveQueuedMessage, rejectQueuedMessage,
} from '../../services/whatsapp/WhatsAppManager';
import createLogger from '../../utils/logger';

const log = createLogger('whatsapp:admin');
const router = Router();
router.use(requireAuth);
router.use(requireAdmin);

// Helper: get target clientNumber — SA can override via ?cn= query param, AD uses own tenant
function getTargetClient(req: Request): string {
  const override = req.query.cn as string;
  if (override && req.user?.isSuperAdmin) return override;
  return req.user!.clientNumber as string;
}

// ─── GET /config — current config (sensitive fields masked) ───────────────────
//
// Historical bug: this query used to reference `max_tokens_chat` (column never
// existed) which made the whole SELECT throw — the React loader treated the
// 500 as `{configured:false}` and silently rendered an empty form even when a
// real device was paired. Limits/max-tokens were removed from the admin UI;
// the column reference is gone here too. `max_tokens_data` is still in the
// table schema as a backstop but no longer surfaced.
router.get('/config', async (req: Request, res: Response) => {
  const cn = getTargetClient(req);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT provider, meta_phone_number_id, meta_business_id, status, connected_number, connected_at,
            daily_limit, monthly_limit, messages_today, messages_this_month,
            last_message_at, last_error, last_error_at, connected_number as company_number
     FROM whatsapp_config WHERE client_number = $1`, cn,
  ) as any[];

  if (!rows.length) {
    res.json({ configured: false });
    return;
  }
  // Never return raw tokens — mask them
  res.json({ configured: true, ...rows[0] });
});

// ─── POST /config — save/update config ────────────────────────────────────────
router.post('/config', async (req: Request, res: Response) => {
  const cn = getTargetClient(req);

  // Validate company number format if provided
  if (req.body.companyNumber) {
    const clean = req.body.companyNumber.replace(/[\s-]/g, '');
    if (!/^\+\d{10,15}$/.test(clean)) {
      res.status(400).json({ error: 'Invalid company WhatsApp number. Use E.164 format: +[country code][number] e.g. +923001234567' });
      return;
    }
    req.body.companyNumber = clean; // normalize
  }

  // Validate Meta credentials if Meta provider selected
  if (req.body.provider === 'meta') {
    if (!req.body.metaPhoneNumberId) {
      res.status(400).json({ error: 'Meta Phone Number ID is required for Meta Cloud API provider' });
      return;
    }
  }

  try {
    await saveWhatsAppConfig(cn, req.body);
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── POST /connect — initialize connection ────────────────────────────────────
router.post('/connect', async (req: Request, res: Response) => {
  const cn = getTargetClient(req);
  try {
    clearProviderCache(cn);
    const provider = await getProvider(cn);
    await provider.initialize(cn);
    const status = await provider.getStatus(cn);
    res.json(status);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /qr — get current QR code (webjs only, poll every 3s) ───────────────
router.get('/qr', async (req: Request, res: Response) => {
  const cn = getTargetClient(req);
  try {
    const provider = await getProvider(cn);
    const qr = await provider.getQRCode(cn);
    const status = await provider.getStatus(cn);
    res.json({ qrCode: qr, status: status.status, connectedNumber: status.connectedNumber });
  } catch (err: any) {
    res.json({ qrCode: null, status: 'error', error: err.message });
  }
});

// ─── GET /status — full connection status ─────────────────────────────────────
router.get('/status', async (req: Request, res: Response) => {
  const cn = getTargetClient(req);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT provider, status, connected_number, connected_at, daily_limit, monthly_limit,
            messages_today, messages_this_month, last_message_at, last_error, last_error_at
     FROM whatsapp_config WHERE client_number = $1`, cn,
  ) as any[];

  if (!rows.length) {
    res.json({ status: 'not_configured' });
    return;
  }
  res.json(rows[0]);
});

// ─── POST /test-connection — validate connection (no message sent) ────────────
//
// Self-heals when the DB says `connected` but the in-process whatsapp-web.js
// client Map is empty (typical after a nodemon restart): re-runs
// `provider.initialize()` to re-load LocalAuth from disk and polls for
// `ready` for up to 8s before reporting back. Same auto-recovery
// pattern the send path uses, surfaced here so the admin's Test
// Connection button doesn't lie about a paired session being dead.
router.post('/test-connection', async (req: Request, res: Response) => {
  const cn = getTargetClient(req);
  try {
    const provider = await getProvider(cn);
    let result = await provider.testConnection(cn);

    if (!result.success && /not initialized|not connected/i.test(result.error ?? '')) {
      // Check whether the DB believes we should be connected. If not,
      // an admin needs to scan QR — don't silently re-init.
      const rows = await prisma.$queryRawUnsafe<any[]>(
        `SELECT status FROM whatsapp_config WHERE client_number = $1`, cn,
      );
      if (rows[0]?.status === 'connected') {
        log.info('test-connection: re-initializing from LocalAuth', { clientNumber: cn });
        await provider.initialize(cn);
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
          result = await provider.testConnection(cn);
          if (result.success) break;
          await new Promise((r) => setTimeout(r, 800));
        }
      }
    }

    res.json(result);
  } catch (err: any) {
    res.json({ success: false, error: err.message });
  }
});

// ─── POST /test — send test message ──────────────────────────────────────────
router.post('/test', async (req: Request, res: Response) => {
  const cn = getTargetClient(req);
  const { testNumber } = req.body;
  if (!testNumber) {
    res.status(400).json({ error: 'testNumber is required' });
    return;
  }
  // `whatsapp_messages.user_id` is NOT NULL in the schema — pass the
  // authenticated admin's id so the log insert doesn't violate the
  // constraint. SuperAdmin + tenant-switched admin both satisfy this.
  const authenticatedUserId = (req as any).user?.id;
  const result = await sendWhatsAppMessage({
    clientNumber: cn,
    userId: authenticatedUserId,
    to: testNumber,
    message: 'This is a test message from TMCAI. WhatsApp is configured correctly. — Sent via TMCAI Admin Panel',
  });
  res.json(result);
});

// ─── POST /disconnect — disconnect WhatsApp ──────────────────────────────────
router.post('/disconnect', async (req: Request, res: Response) => {
  const cn = getTargetClient(req);
  try {
    const provider = await getProvider(cn);
    await provider.disconnect(cn);
    clearProviderCache(cn);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /limits — update daily/monthly limits ───────────────────────────────
router.put('/limits', async (req: Request, res: Response) => {
  const cn = getTargetClient(req);
  const { dailyLimit, monthlyLimit } = req.body;
  await prisma.$executeRawUnsafe(
    `UPDATE whatsapp_config SET daily_limit = COALESCE($1, daily_limit), monthly_limit = COALESCE($2, monthly_limit), updated_at = NOW() WHERE client_number = $3`,
    dailyLimit || null, monthlyLimit || null, cn,
  );
  res.json({ success: true });
});

// ─── GET /messages — message log ─────────────────────────────────────────────
router.get('/messages', async (req: Request, res: Response) => {
  const cn = getTargetClient(req);
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = parseInt(req.query.offset as string) || 0;
  const direction = req.query.direction as string;
  const status = req.query.status as string;

  let where = `WHERE client_number = $1`;
  const params: any[] = [cn];
  let idx = 2;
  if (direction) { where += ` AND direction = $${idx++}`; params.push(direction); }
  if (status) { where += ` AND status = $${idx++}`; params.push(status); }

  const messages = await prisma.$queryRawUnsafe(
    `SELECT id, direction, from_number, to_number, content, message_type, status, requires_approval, approved_by, wa_message_id, agent_id, error_message, created_at
     FROM whatsapp_messages ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`, ...params,
  );
  res.json({ messages });
});

// ─── POST /messages/:id/approve — approve pending message ────────────────────
router.post('/messages/:id/approve', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  const result = await approveQueuedMessage(id, req.user!.id);
  res.json(result);
});

// ─── POST /messages/:id/reject — reject pending message ──────────────────────
router.post('/messages/:id/reject', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  await rejectQueuedMessage(id, req.user!.id);
  res.json({ success: true });
});

// ─── GET /sessions — active WhatsApp sessions ────────────────────────────────
router.get('/sessions', async (req: Request, res: Response) => {
  const cn = getTargetClient(req);
  const sessions = await prisma.$queryRawUnsafe(
    `SELECT ws.id, ws.user_id, u.name as user_name, ws.last_message_at,
            jsonb_array_length(ws.conversation_history) as message_count, ws.created_at
     FROM whatsapp_sessions ws JOIN users u ON u.id = ws.user_id
     WHERE ws.client_number = $1 AND ws.closed_at IS NULL
     AND ws.last_message_at > NOW() - INTERVAL '24 hours'
     ORDER BY ws.last_message_at DESC`, cn,
  );
  res.json({ sessions });
});

// ─── DELETE /sessions/:id — end a session ────────────────────────────────────
router.delete('/sessions/:id', async (req: Request, res: Response) => {
  const id = parseInt(req.params.id as string, 10);
  await prisma.$executeRawUnsafe(
    `UPDATE whatsapp_sessions SET closed_at = NOW() WHERE id = $1`, id,
  );
  res.json({ success: true });
});

// ─── POST /user-connect — register a user's WhatsApp number ──────────────────
router.post('/user-connect', async (req: Request, res: Response) => {
  const cn = getTargetClient(req);
  const { userId, phoneNumber, displayName } = req.body;
  if (!userId || !phoneNumber) {
    res.status(400).json({ error: 'userId and phoneNumber required' });
    return;
  }
  // Validate E.164 format: + followed by 10-15 digits
  const cleanNumber = phoneNumber.replace(/[\s-]/g, '');
  if (!/^\+\d{10,15}$/.test(cleanNumber)) {
    res.status(400).json({ error: 'Invalid phone number format. Use E.164: +[country code][number] e.g. +923001234567' });
    return;
  }

  await prisma.$executeRawUnsafe(
    `INSERT INTO whatsapp_connections (user_id, client_number, phone_number, display_name, opt_in, opt_in_at, status, connected_at, updated_at)
     VALUES ($1, $2, $3, $4, TRUE, NOW(), 'active', NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET phone_number = $3, display_name = $4, client_number = $2, status = 'active', opt_in = TRUE, opt_in_at = NOW(), updated_at = NOW()`,
    userId, cn, phoneNumber, displayName || null,
  );
  res.json({ success: true });
});

export default router;
