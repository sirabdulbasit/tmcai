import './instrumentation';
import dotenv from 'dotenv';
dotenv.config();

import app from './app';
import { validateEnv, env } from './config/env';
import { startAutoRefresh } from './services/indexCacheService';
import { initScheduler } from './services/schedulerService';
import { cleanupExpiredContextMemories } from './services/memoryService';
import { runPersonalDriveSyncJob } from './jobs/personalDriveSyncJob';
import { startIndexEventProcessor } from './services/indexEventService';
import { runProactiveIntelligence } from './services/proactiveIntelligenceService';
import { registerAllHandlers } from './services/actions/handlers';
import { register as registerFeedAdapter } from './services/adapters/adapterRegistry';
import gmailFeedAdapter from './services/adapters/impl/gmailFeedAdapter';
import slackFeedAdapter from './services/adapters/impl/slackFeedAdapter';
import crmFeedAdapter from './services/adapters/impl/crmFeedAdapter';

validateEnv();
// HaseebOS v15 — register action handlers on boot
registerAllHandlers();
// HaseebOS v15 §3.2 F-1 — register feed adapters
registerFeedAdapter(gmailFeedAdapter);
registerFeedAdapter(slackFeedAdapter);
registerFeedAdapter(crmFeedAdapter);

app.listen(env.port, async () => {
  console.log(`TMCAI Server listening on port ${env.port}`);
  startAutoRefresh(env.indexRefreshIntervalMs);
  await initScheduler().catch(err => console.error('Scheduler init failed:', err.message));
  // Cleanup expired context memories every hour
  cleanupExpiredContextMemories().catch(() => {});
  setInterval(() => cleanupExpiredContextMemories().catch(() => {}), 60 * 60 * 1000);
  // Personal GDrive sync every 30 minutes (Phase 3.1)
  runPersonalDriveSyncJob().catch(() => {});
  setInterval(() => runPersonalDriveSyncJob().catch(() => {}), 30 * 60 * 1000);
  // Phase 5: Index event processor (polls every 10s)
  startIndexEventProcessor();
  // Phase 5: Proactive intelligence — hourly scan
  setInterval(() => runProactiveIntelligence().catch(() => {}), 60 * 60 * 1000);
  // Agent scheduler: initialize all scheduled agents
  import('./agents/agentScheduler').then(({ initializeAgentScheduler }) => {
    initializeAgentScheduler().then(() => console.log('[Agents] Scheduler initialized')).catch(() => {});
  }).catch(() => {});

  // WhatsApp: initialize all tenant connections (non-fatal on failure)
  if (process.env.ENABLE_WHATSAPP === 'true') {
    import('./services/whatsapp/WhatsAppManager').then(({ initializeAllTenants }) => {
      initializeAllTenants().then(() => console.log('[WhatsApp] All tenants initialized')).catch(() => {});
    }).catch(() => {});
  }
  // Smart log maintenance — hourly: escalate high-recurrence, auto-fix known patterns, cleanup old
  setInterval(async () => {
    try {
      const { escalateHighRecurrence, runAutoFix, cleanupOldLogs } = await import('./services/systemLogService');
      await escalateHighRecurrence();
      await runAutoFix('GLOBAL');
      await cleanupOldLogs(90);
    } catch {}
  }, 60 * 60 * 1000);

  // HaseebOS v15 — notification queue drain every 60s
  setInterval(async () => {
    try {
      const { drain } = await import('./services/notifications/notificationService');
      const r = await drain({ batchSize: 25, maxRetries: 3 });
      if (r.sent > 0 || r.failed > 0) {
        console.log(`[notifications] drain: sent=${r.sent} failed=${r.failed} deferred=${r.deferred}`);
      }
    } catch (err: any) {
      console.warn('[notifications] drain error:', err.message);
    }
  }, 60 * 1000);

  // HaseebOS v15 L2 — snooze timer every 60s: wake SNOOZED items when due
  setInterval(async () => {
    try {
      const { wakeSnoozed } = await import('./jobs/snoozeUnblocker');
      const r = await wakeSnoozed();
      if (r.unblocked > 0 || r.errors > 0) {
        console.log(`[snooze] scanned=${r.scanned} unblocked=${r.unblocked} errors=${r.errors}`);
      }
    } catch (err: any) {
      console.warn('[snooze] error:', err.message);
    }
  }, 60 * 1000);

  // HaseebOS v15 L1.4 — feed publish retry catch-up worker every 2 min
  setInterval(async () => {
    try {
      const { retryUnpublishedFeedEvents } = await import('./jobs/feedPublishRetry');
      const s = await retryUnpublishedFeedEvents(50);
      if (s.republished > 0 || s.errors > 0 || s.deadLettered > 0) {
        console.log(`[feedPubRetry] scanned=${s.scanned} republished=${s.republished} errors=${s.errors} dlq=${s.deadLettered}`);
      }
    } catch (err: any) {
      console.warn('[feedPubRetry] error:', err.message);
    }
  }, 2 * 60 * 1000);

  // HaseebOS v15 L1 — generic feed poller every 5 min (drives all adapters with
  // receive capability via adapterRegistry). The legacy gmailFeedPoller still
  // exports enrichBody() for VIP pull, but no longer runs on its own schedule.
  setInterval(async () => {
    try {
      const { pollAllTenants } = await import('./jobs/genericFeedPoller');
      const r = await pollAllTenants();
      const totalIngested = r.reduce((s, x) => s + x.ingested, 0);
      const totalErrors = r.reduce((s, x) => s + x.errors, 0);
      if (totalIngested > 0 || totalErrors > 0) {
        const bySource = r.reduce<Record<string, number>>((acc, x) => {
          acc[x.source] = (acc[x.source] ?? 0) + x.ingested;
          return acc;
        }, {});
        console.log(`[genericPoll] ingested=${totalIngested} errors=${totalErrors} bySource=${JSON.stringify(bySource)}`);
      }
    } catch (err: any) {
      console.warn('[genericPoll] error:', err.message);
    }
  }, 5 * 60 * 1000);

  // HaseebOS v15 — Notion reverse sync every 5 min (feature-flag gated per tenant)
  setInterval(async () => {
    try {
      const { reverseSyncAllTenants } = await import('./jobs/notionReverseSync');
      const r = await reverseSyncAllTenants();
      const updated = r.reduce((s, x) => s + x.updated, 0);
      const conflicts = r.reduce((s, x) => s + x.conflicts, 0);
      if (updated > 0 || conflicts > 0) {
        console.log(`[notionSync] updated=${updated} conflicts=${conflicts} tenants=${r.length}`);
      }
    } catch (err: any) {
      console.warn('[notionSync] error:', err.message);
    }
  }, 5 * 60 * 1000);

  // HaseebOS v15 — daily KPI snapshot at 06:00 PKT per tenant
  setInterval(async () => {
    const now = new Date();
    // PKT is UTC+5. 06:00 PKT = 01:00 UTC. Only fire within the first 5 min of the hour.
    if (now.getUTCHours() !== 1 || now.getUTCMinutes() >= 5) return;
    try {
      const prisma = (await import('./db/prisma')).default;
      const tenants = await prisma.tenant.findMany({ where: { isActive: true }, select: { clientNumber: true } });
      const { computeDailySnapshot } = await import('./services/steering/steeringWheelService');
      for (const t of tenants) {
        try {
          await computeDailySnapshot(t.clientNumber);
        } catch (err: any) {
          console.warn(`[steering] snapshot failed for ${t.clientNumber}:`, err.message);
        }
      }
      console.log(`[steering] daily snapshot complete for ${tenants.length} tenants`);

      // L4.5 — compose Morning Brief for every active user in each tenant.
      // Runs in the same 06:00 PKT window as the KPI snapshot so the brief
      // has the freshest data.
      for (const t of tenants) {
        try {
          const users = await prisma.user.findMany({
            where: { clientNumber: t.clientNumber, isActive: true } as any,
            select: { id: true },
          });
          const { composeBriefFor } = await import('./services/steering/morningBriefService');
          for (const u of users) {
            try { await composeBriefFor(t.clientNumber, u.id); }
            catch (err: any) { console.warn(`[morningBrief] ${t.clientNumber}/${u.id} failed:`, err.message); }
          }
        } catch (err: any) {
          console.warn(`[morningBrief] tenant ${t.clientNumber} error:`, err.message);
        }
      }
    } catch (err: any) {
      console.warn('[steering] snapshot loop error:', err.message);
    }
  }, 5 * 60 * 1000); // check every 5 min, fires once within the 06:00 PKT window
});
