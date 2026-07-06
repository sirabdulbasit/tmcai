/**
 * WhatsApp Health — read-only endpoints backing the resilience
 * dashboard tab in Admin.
 *
 * Data source: connectionWatchdog's in-memory ring buffer of health
 * samples (updated every 60s per tenant). No DB writes — status/log
 * data lives elsewhere; this is the "how healthy is the wire"
 * surface admin can watch during an incident.
 */
import { Router, Request, Response } from 'express';
import { requireAuth, requireAdmin } from '../../middleware/auth';
import prisma from '../../db/prisma';
import { getHealthHistory, getHealthStats } from '../../services/whatsapp/connectionWatchdog';

const router = Router();
router.use(requireAuth);
router.use(requireAdmin);

// ─── GET /whatsapp-health — full snapshot for this tenant ────────
router.get('/whatsapp-health', async (req: Request, res: Response) => {
  const cn = req.user!.clientNumber;
  const [cfgRows, notifierRow] = await Promise.all([
    prisma.$queryRawUnsafe<any[]>(
      `SELECT provider, status, connected_number, connected_at,
              last_error, last_error_at,
              messages_today, messages_this_month, last_message_at
         FROM whatsapp_config WHERE client_number = $1`,
      cn,
    ).catch(() => []),
    prisma.$queryRawUnsafe<any[]>(
      `SELECT is_active, calling_enabled, last_send_at, last_error, last_call_at
         FROM tenant_whatsapp_notifier WHERE client_number = $1`,
      cn,
    ).catch(() => []),
  ]);
  const config = cfgRows[0] ?? null;
  const notifier = notifierRow[0] ?? null;

  const stats = getHealthStats(cn);
  const history = getHealthHistory(cn);

  res.json({
    tenant: cn,
    config,
    notifier,
    stats,
    history,
    generatedAt: new Date().toISOString(),
  });
});

export default router;
