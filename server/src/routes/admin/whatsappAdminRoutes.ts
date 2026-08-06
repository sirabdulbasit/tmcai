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

// ─── GET /diagnose-lid — DEF-075: why an @lid counterpart never resolves ─────
//
// Read-only. Sends nothing, writes nothing.
//
// 2026-08-06 10:16: Hamna's reply arrived as `255043747987458@lid` and
// collapsed to the synthetic phone `+255043747987458`, matching no thread
// (`wa:+923134199294`). Fifth recurrence of the @lid class.
//
// `waIdentity.lidToPhone` already calls the right API — `getContactLidAndPhone`,
// typed as returning `{ lid, pn }[]` — and produced nothing usable. The call
// site swallows the error, so the logs cannot tell these apart:
//
//   A. the API threw        → upstream broken again, as in recurrence #4
//   B. returned []          → cannot map a contact outside the address book;
//                             no resolver-side fix will ever work and the
//                             thread must carry the LID instead
//   C. row with empty `pn`  → our parsing, and a small fix
//
// Three causes, three different responses. Guessing between them is how this
// class reached five recurrences, so this asks the live client instead.
//
// Runs IN-PROCESS on purpose: the client lives in an in-memory map, so a
// standalone script finds nothing (and the box has no npm registry access).
router.get('/diagnose-lid', async (req: Request, res: Response) => {
  const cn = getTargetClient(req);
  const lid = String(req.query.lid ?? '').trim();
  const phone = String(req.query.phone ?? '').replace(/[^0-9]/g, '');
  if (!lid.endsWith('@lid')) {
    return res.status(400).json({ error: 'pass ?lid=<digits>@lid (and optionally &phone=<digits>)' });
  }
  try {
    const { getRawClientForDiagnostics } = await import('../../services/whatsapp/WebjsProvider');
    const client = getRawClientForDiagnostics(cn);
    if (!client) {
      return res.status(409).json({ error: 'no live webjs client for this tenant' });
    }

    const out: Record<string, unknown> = {
      clientNumber: cn,
      lid,
      apiPresent: typeof client.getContactLidAndPhone === 'function',
    };

    // The decisive call: LID → phone.
    try {
      const byLid = await client.getContactLidAndPhone([lid]);
      out.lidLookup = byLid;
      out.outcome = !Array.isArray(byLid) || byLid.length === 0
        ? 'B_EMPTY — the API cannot map this contact; no resolver fix will work'
        : !byLid[0]?.pn
          ? 'C_NO_PN — a row came back but `pn` is empty; parsing or field name'
          : 'RESOLVES — the mapping exists, so lidToPhone should have worked; the bug is ours';
    } catch (e: any) {
      out.lidLookup = { threw: e?.message ?? String(e) };
      out.outcome = 'A_THREW — upstream API broken, same as @lid recurrence #4';
    }

    // Reverse direction. A send-time mapping would depend on this.
    if (phone) {
      try {
        out.phoneLookup = await client.getContactLidAndPhone([`${phone}@c.us`]);
      } catch (e: any) {
        out.phoneLookup = { threw: e?.message ?? String(e) };
      }
    }

    // What the contact object itself knows — the first limb that failed.
    try {
      const c = await client.getContactById(lid);
      out.contact = {
        id: c?.id?._serialized, number: c?.number, isMyContact: c?.isMyContact,
        pushname: c?.pushname, name: c?.name, lid: (c as any)?.lid,
      };
    } catch (e: any) {
      out.contact = { threw: e?.message ?? String(e) };
    }

    res.json(out);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /diagnose-modules — why media + typing throw `r: r` ─────────────────
//
// Read-only probe of WhatsApp Web's internal module names on the LIVE page.
// whatsapp-web.js calls window.require('WAWebCollections') etc; Meta renames
// those between builds, and every failure surfaces as the same opaque `r: r`
// (media download, typing/recording state, reactions). This names the modules
// that actually moved — and suggests renamed candidates — so the fix targets
// facts instead of guesses. Sends nothing; mutates nothing.
router.get('/diagnose-modules', async (req: Request, res: Response) => {
  const cn = getTargetClient(req);
  try {
    const { getRawClientForDiagnostics } = await import('../../services/whatsapp/WebjsProvider');
    const client = getRawClientForDiagnostics(cn);
    if (!client) {
      return res.status(409).json({
        error: 'no live webjs client for this tenant — connect it first, then re-run',
      });
    }
    const { probeWebjsModules } = await import('../../services/whatsapp/webjsModuleProbe');
    const result = await probeWebjsModules(client);
    res.json({ clientNumber: cn, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /diagnose-call — does createWid reject the @lid domain? ─────────────
//
// The surface probe found every module and method healthy, so `r: r` must be
// thrown by a real ARGUMENT. Prime suspect: chats arrive as <digits>@lid and
// WidFactory.createWid may reject that domain — which would break
// typing/recording exactly on @lid chats while leaving message.reply() (no
// Wid construction) working, matching the archive precisely.
//
// The @lid candidate is derived server-side from the auto-learned alias rows
// in whatsapp_connections, so there is nothing to look up by hand. PURE:
// constructing a Wid sends nothing, emits no presence, fetches no media.
router.get('/diagnose-call', async (req: Request, res: Response) => {
  const cn = getTargetClient(req);
  try {
    const { getRawClientForDiagnostics } = await import('../../services/whatsapp/WebjsProvider');
    const client = getRawClientForDiagnostics(cn);
    if (!client) {
      return res.status(409).json({ error: 'no live webjs client for this tenant' });
    }
    // Synthetic alias rows hold the @lid digits; real rows hold the phone.
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT phone_number, display_name FROM whatsapp_connections
        WHERE client_number = $1 AND status = 'active' ORDER BY id DESC LIMIT 20`,
      cn,
    ).catch(() => [] as any[]);
    const digits = (v: string) => String(v ?? '').replace(/[^\d]/g, '');
    const synthetic = rows.find((r) => /^auto-learned/i.test(String(r.display_name ?? '')));
    const real = rows.find((r) => r !== synthetic && digits(r.phone_number).length >= 10);
    const lidId = (req.query.lidId as string) || (synthetic ? `${digits(synthetic.phone_number)}@lid` : null);
    const phoneId = (req.query.phoneId as string) || (real ? `${digits(real.phone_number)}@c.us` : null);

    const { probeWebjsCallArguments } = await import('../../services/whatsapp/webjsModuleProbe');
    const result = await probeWebjsCallArguments(client, { lidId, phoneId });
    res.json({ clientNumber: cn, probed: { lidId, phoneId }, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /diagnose-media — which STEP of the voice download throws ───────────
//
// Existence probes are exhausted: every module and method the media path uses
// is present on this build. So the fault is a runtime value, and the only way
// to see it is to replay downloadMedia's own sequence on a real voice message
// with each step caught separately — attributing the minified `r` to one line.
// Send a voice note to Nexeo first, then call this. Downloads media (a read);
// sends nothing.
router.get('/diagnose-media', async (req: Request, res: Response) => {
  const cn = getTargetClient(req);
  try {
    const { getRawClientForDiagnostics } = await import('../../services/whatsapp/WebjsProvider');
    const client = getRawClientForDiagnostics(cn);
    if (!client) return res.status(409).json({ error: 'no live webjs client for this tenant' });
    const { probeMediaSteps } = await import('../../services/whatsapp/webjsModuleProbe');
    const result = await probeMediaSteps(client);
    res.json({ clientNumber: cn, ...result });
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

// ─── POST /reset-pairing — change WhatsApp number / unpair completely ─────────
//
// What this does (in order):
//   1. client.logout()  → tells WhatsApp to unlink this device from the
//      paired phone. Without this, the old phone keeps showing the entry
//      under Linked Devices and can re-grab the session.
//   2. client.destroy() → kills the in-memory webjs client + Chromium.
//   3. rm -rf the LocalAuth session folder on disk. WITHOUT THIS, the
//      next initialize() finds the saved session and silently reconnects
//      to the OLD account — no QR is ever shown. This is THE bug that
//      forced the user to SSH and delete the folder manually.
//   4. Clear DB columns so the admin UI knows it needs a fresh pair.
//   5. Re-initialize the provider → fresh QR appears on next /qr poll.
//
// Idempotent: safe to call even when not currently paired.
router.post('/reset-pairing', async (req: Request, res: Response) => {
  const cn = getTargetClient(req);
  const fs = await import('fs');
  const path = await import('path');
  try {
    // Step 1: destroy the live client (best-effort — tolerate
    // "already disconnected" case). The UI flow tells the admin to log
    // out from the phone's Linked Devices BEFORE pressing this button,
    // so the WhatsApp-side session is already invalidated; here we just
    // tear down the local Chromium / webjs Client so the next initialize
    // starts clean.
    try {
      const provider = await getProvider(cn);
      await provider.disconnect(cn);
      clearProviderCache(cn);
    } catch (e: any) {
      log.warn('reset-pairing: provider tear-down errored, continuing', { cn, error: e.message });
    }

    // Step 3: delete LocalAuth session folder so next initialize()
    // shows a fresh QR instead of silently re-pairing to the old account.
    const sessionPath = process.env.WHATSAPP_SESSION_PATH || './whatsapp-sessions';
    // E2: cn is request-supplied — validate before using it in a path we rm -rf.
    const { tenantSessionKey } = await import('../../services/whatsapp/waSessionKey');
    const sessionDir = path.join(sessionPath, `session-${tenantSessionKey(cn)}`);
    try {
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        log.info('reset-pairing: session dir deleted', { cn, sessionDir });
      }
    } catch (e: any) {
      log.warn('reset-pairing: session dir delete failed', { cn, sessionDir, error: e.message });
    }

    // Step 4: clear DB so the admin UI surfaces "needs pairing" state.
    await prisma.$executeRawUnsafe(
      `UPDATE whatsapp_config
         SET status            = 'disconnected',
             connected_number  = NULL,
             qr_code           = NULL,
             qr_expires_at     = NULL,
             connected_at      = NULL,
             last_error        = 'reset for re-pair (admin)',
             last_error_at     = NOW(),
             updated_at        = NOW()
       WHERE client_number = $1`, cn,
    );

    // Step 5: re-initialize so a fresh QR is generated for the next /qr poll.
    const freshProvider = await getProvider(cn);
    await freshProvider.initialize(cn);

    res.json({ success: true, message: 'Pairing reset — scan the new QR code with the phone you want to use.' });
  } catch (err: any) {
    log.error('reset-pairing failed', { cn, error: err.message });
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

// ─── DELETE /messages/:id — remove a single row from the log ─────────────────
//
// Tenant-scoped: an admin can only delete rows belonging to their own
// tenant. Returns deleted-count so the UI can toast "Deleted" only on
// actual delete (vs silent no-op if the id doesn't exist or belongs
// to a different tenant).
router.delete('/messages/:id', async (req: Request, res: Response) => {
  const cn = getTargetClient(req);
  const id = parseInt(req.params.id as string, 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'invalid id' });
    return;
  }
  const result: any = await prisma.$executeRawUnsafe(
    `DELETE FROM whatsapp_messages WHERE id = $1 AND client_number = $2`, id, cn,
  );
  log.info('admin deleted whatsapp_messages row', {
    cn, id, adminId: req.user?.id, deletedRows: Number(result) || 0,
  });
  res.json({ success: true, deleted: Number(result) || 0 });
});

// ─── DELETE /messages — clear the entire log for this tenant ─────────────────
//
// Destructive. Tenant-scoped (only this tenant's rows). The UI uses a
// typed-phrase confirmation (type CLEAR) so it can't be triggered by
// an accidental click. Returns the deleted-count so the admin sees
// proof of action.
router.delete('/messages', async (req: Request, res: Response) => {
  const cn = getTargetClient(req);
  const result: any = await prisma.$executeRawUnsafe(
    `DELETE FROM whatsapp_messages WHERE client_number = $1`, cn,
  );
  log.warn('admin cleared whatsapp_messages log', {
    cn, adminId: req.user?.id, deletedRows: Number(result) || 0,
  });
  res.json({ success: true, deleted: Number(result) || 0 });
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
