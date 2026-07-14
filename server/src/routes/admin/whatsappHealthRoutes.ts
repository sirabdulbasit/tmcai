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

// ─── GET /system-health — operational health snapshot (#8, audit
// 2026-07-14). Admin-gated; tenant-scoped except infra-level rows
// (job names / embedding status carry no tenant data). SuperAdmin
// sees self-heal rows across tenants; a tenant admin sees own+global.
// Never includes secrets or message contents. ─────────────────────
router.get('/system-health', async (req: Request, res: Response) => {
  const cn = req.user!.clientNumber;
  const isSA = Boolean((req.user as any)?.isSuperAdmin);

  const [jobs, repairs, dlqRows, stuckRows, healthTransitions] = await Promise.all([
    import('../../jobs/jobRunner').then((m) => m.getJobsHealth()).catch(() => []),
    import('../../services/selfheal/repairService').then((m) => m.getRecentRepairs(50)).catch(() => []),
    prisma.$queryRawUnsafe<any[]>(
      `SELECT COUNT(*)::int AS n FROM feed_events WHERE client_number = $1 AND status = 'dlq'`,
      cn,
    ).catch(() => [{ n: -1 }]),
    prisma.$queryRawUnsafe<any[]>(
      `SELECT status, COUNT(*)::int AS n FROM agent_actions
        WHERE client_number = $1 AND status IN ('stale','unconfirmed','dispatched','executing')
        GROUP BY status`,
      cn,
    ).catch(() => []),
    prisma.$queryRawUnsafe<any[]>(
      `SELECT source, level, message, recurrence_count, last_seen_at
         FROM system_logs
        WHERE category IN ('health_transition','job_failure','self_heal','embedding_degraded')
          AND (client_number = $1 OR client_number IS NULL)
          AND last_seen_at >= NOW() - INTERVAL '7 days'
        ORDER BY last_seen_at DESC LIMIT 50`,
      cn,
    ).catch(() => []),
  ]);

  const [connectors, embeddings, waStats] = await Promise.all([
    prisma.userConnector.findMany({
      where: { clientNumber: cn },
      select: {
        status: true, lastSyncAt: true, userId: true,
        connectorType: { select: { slug: true } },
      },
    }).then((rows) => rows.map((r: any) => ({
      slug: r.connectorType?.slug, userId: r.userId, status: r.status, lastSyncAt: r.lastSyncAt,
    }))).catch(() => [] as any[]),
    import('../../services/knowledge/embeddingGuard').then((m) => m.getEmbeddingHealth()).catch(() => []),
    Promise.resolve(getHealthStats(cn)),
  ]);

  res.json({
    tenant: cn,
    generatedAt: new Date().toISOString(),
    jobs,                       // job_runs ledger: last run, status, duration, failures
    selfHeal: isSA ? repairs : (repairs as any[]).filter((r) => !r.client_number || r.client_number === cn),
    embeddings,                 // per-service embedding provider status
    connectors,                 // this tenant's connector states + last sync
    whatsapp: waStats,          // wire health (uptime %, latency) — in-memory window
    dlqDepth: dlqRows[0]?.n ?? -1,
    unconfirmedActions: stuckRows,
    recentHealthEvents: healthTransitions, // persisted transitions, 7d
  });
});

export default router;
