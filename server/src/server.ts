// Force IPv4 for ALL outbound HTTP(S) on this host. The Ubuntu prod box
// has IPv6 disabled at the network layer but DNS still returns AAAA
// records — Node's default behaviour tries IPv6 first and ETIMEDOUTs on
// every Google API call (OAuth, token refresh, scribe, calendar sync).
//
// Layered progressively stronger fixes — empirically the dns.lookup
// monkey-patch is the one that actually catches gaxios / googleapis,
// which create their own https.Agent and bypass globalAgent.options:
//   1. dns.setDefaultResultOrder('ipv4first') — preference only.
//   2. https/http.globalAgent.options.family = 4 — covers default-agent
//      callers (node-fetch, undici-via-fetch, our own callers).
//   3. dns.lookup monkey-patch — force family: 4 on EVERY DNS lookup.
//      Catches libraries (gaxios used by googleapis) that build their
//      own Agent instances and don't see globalAgent.options.
//
// Hosts with working IPv6 are unaffected — family:4 just means "if you
// can resolve to v4, prefer it." On a dual-stack host this is
// indistinguishable from default behaviour.
import dns from 'dns';
import http from 'http';
import https from 'https';
dns.setDefaultResultOrder('ipv4first');
((https.globalAgent as unknown) as { options: { family?: number } }).options.family = 4;
((http.globalAgent as unknown) as { options: { family?: number } }).options.family = 4;

// dns.lookup monkey-patch — last line of defence so libraries that bring
// their own https.Agent (gaxios → googleapis) still resolve to IPv4.
const originalLookup = dns.lookup;
(dns as unknown as { lookup: typeof dns.lookup }).lookup = function patchedLookup(
  hostname: string,
  options: unknown,
  callback?: unknown,
): unknown {
  // The original signature is ((host, opts?, cb) | (host, cb)). Force
  // family: 4 regardless of how the caller invokes it.
  let actualOpts: dns.LookupOptions;
  let actualCb: (...args: unknown[]) => void;
  if (typeof options === 'function') {
    actualCb = options as (...args: unknown[]) => void;
    actualOpts = { family: 4 };
  } else if (typeof options === 'number') {
    actualCb = callback as (...args: unknown[]) => void;
    actualOpts = { family: 4 };
  } else {
    actualCb = callback as (...args: unknown[]) => void;
    actualOpts = { ...((options as object) ?? {}), family: 4 } as dns.LookupOptions;
  }
  return (originalLookup as unknown as (
    h: string, o: dns.LookupOptions, cb: (...args: unknown[]) => void,
  ) => unknown)(hostname, actualOpts, actualCb);
} as typeof dns.lookup;

import './instrumentation';
import dotenv from 'dotenv';
dotenv.config();

import app from './app';
import { validateEnv, env } from './config/env';
import { startAutoRefresh } from './services/indexCacheService';
import { initScheduler } from './services/schedulerService';
import { runPersonalDriveSyncJob } from './jobs/personalDriveSyncJob';
import { startIndexEventProcessor } from './services/indexEventService';
import { runProactiveIntelligence } from './services/proactiveIntelligenceService';
import { registerAllHandlers } from './services/actions/handlers';
import { register as registerFeedAdapter } from './services/adapters/adapterRegistry';
import gmailFeedAdapter from './services/adapters/impl/gmailFeedAdapter';
import slackFeedAdapter from './services/adapters/impl/slackFeedAdapter';
import crmFeedAdapter from './services/adapters/impl/crmFeedAdapter';
import outlookFeedAdapter from './services/adapters/impl/outlookFeedAdapter';
import outlookCalendarFeedAdapter from './services/adapters/impl/outlookCalendarFeedAdapter';
import onedriveFeedAdapter from './services/adapters/impl/onedriveFeedAdapter';
import msTeamsFeedAdapter from './services/adapters/impl/msTeamsFeedAdapter';
import imapSmtpFeedAdapter from './services/adapters/impl/imapSmtpFeedAdapter';

validateEnv();
// HaseebOS v15 — register action handlers on boot
registerAllHandlers();
// HaseebOS v15 §3.2 F-1 — register feed adapters
registerFeedAdapter(gmailFeedAdapter);
registerFeedAdapter(slackFeedAdapter);
registerFeedAdapter(crmFeedAdapter);
registerFeedAdapter(outlookFeedAdapter);
registerFeedAdapter(outlookCalendarFeedAdapter);
registerFeedAdapter(onedriveFeedAdapter);
registerFeedAdapter(msTeamsFeedAdapter);
registerFeedAdapter(imapSmtpFeedAdapter);

// L1 — track interval/timeout handles so SIGTERM can clear them cleanly.
// Every setInterval/setTimeout below that is assigned-for-cleanup gets
// pushed into `backgroundHandles` and is cleared by the shutdown hook.
// NOTE: the current implementation registers 15+ timers without capturing
// their handles; full cleanup requires converting them as part of the
// broader scheduler-extraction work (finding C3). This hook gets us the
// HTTP-server drain and DB disconnect today.
const backgroundHandles: Array<NodeJS.Timeout> = [];

// #4 (audit 2026-07-14): wrap a job body with the reliability runner —
// pg-advisory leader lock (replica-safe), persisted run state in
// job_runs, bounded retries by class, escalation to system_logs after
// 3 consecutive failures. Wraps the BODY only; interval wiring below
// is unchanged. Never throws.
const protectedJob = (name: string, jobClass: 'maintenance' | 'important' | 'critical', fn: () => Promise<unknown>): Promise<unknown> =>
  import('./jobs/jobRunner')
    .then(({ protectedTick }) => protectedTick(name, jobClass, fn))
    .catch((e) => console.warn(`job runner unavailable for ${name}:`, e?.message));

const server = app.listen(env.port, async () => {
  console.log(`TMCAI Server listening on port ${env.port}`);
  startAutoRefresh(env.indexRefreshIntervalMs);
  // Tier 1 #7 — install/update canonical system gate rules. Idempotent,
  // safe on every boot. Runs before the scheduler so any cron that hits
  // the gate engine sees the seeded rules.
  await import('./services/triage/systemRuleSeeder')
    .then(({ seedSystemRules }) => seedSystemRules())
    .catch(err => console.error('System rule seed failed:', err.message));
  // Clear any scribe rows stuck in scribeStatus='running' from a previous
  // crash/restart. Without this, the connector card shows a permanent
  // "SCRIBING…" badge and the Scribe button stays hidden, blocking recovery.
  await import('./services/knowledge/scribeRecovery')
    .then(({ recoverStuckScribes }) => recoverStuckScribes())
    .catch(err => console.error('Scribe recovery failed:', err.message));

  // Backfill whatsapp_connections from users.contact_number for any user
  // who saved their number before the auto-bind hook shipped. Without a
  // matching whatsapp_connections row, the tenant WhatsApp inbound
  // handler silently drops their messages.
  await import('./services/whatsapp/connectionSync')
    .then(({ backfillAllWhatsAppConnections }) => backfillAllWhatsAppConnections())
    .catch(err => console.error('WhatsApp connection backfill failed:', err.message));

  // Re-run tenant bootstrap on every boot — seeds connector defaults
  // for any tenant created before this code shipped, and fills in any
  // new defaults added since the tenant was created. Idempotent.
  await import('./services/tenantBootstrap')
    .then(({ bootstrapAllTenants }) => bootstrapAllTenants())
    .catch(err => console.error('Tenant bootstrap sweep failed:', err.message));
  // Risk Radar — install/update canonical system risk rules. Same idempotent
  // pattern as gate rules; safe on every boot.
  await import('./services/brain/riskRulesSeeder')
    .then(({ seedSystemRiskRules }) => seedSystemRiskRules())
    .catch(err => console.error('Risk rule seed failed:', err.message));
  await initScheduler().catch(err => console.error('Scheduler init failed:', err.message));
  // #6 (2026-07-14): boot missed-run scan. Logs any priority job whose
  // last successful completion exceeds 2× its cadence. The CATCH-UP
  // itself is each job's first post-boot tick (all priority jobs fire
  // within minutes of boot and carry durable dedup keys / current-
  // relevance checks, so "run the normal tick now" is the safe bounded
  // replay — historical notifications are never re-sent). Policies per
  // job: docs/background_jobs_inventory.md.
  setTimeout(() => {
    import('./jobs/jobRunner').then(({ evaluateMissedRuns }) => evaluateMissedRuns([
      { name: 'day_brief_dispatch', cadenceMs: 60_000, policy: 'run_once_if_missed' },
      { name: 'central_action_governor', cadenceMs: 5 * 60_000, policy: 'run_once_if_missed' },
      { name: 'preactive_engine', cadenceMs: 15 * 60_000, policy: 'run_once_if_missed' },
      { name: 'agent_action_reaper', cadenceMs: 5 * 60_000, policy: 'run_once_if_missed' },
      { name: 'feed_publish_retry', cadenceMs: 2 * 60_000, policy: 'run_once_if_missed' },
      { name: 'connector_health_sweep', cadenceMs: 5 * 60_000, policy: 'run_once_if_missed' },
      { name: 'kpi_snapshot_morning_brief', cadenceMs: 24 * 60 * 60_000, policy: 'run_once_if_missed' },
    ])).catch((e) => console.warn('[jobRunner] missed-run scan failed:', e?.message));
  }, 30_000);
  // Central cleanup governor — the only scheduler for autonomous data
  // pruning/retention. Domain workers remain independently testable but do
  // not own timers. The protected runner supplies a cross-replica durable
  // lock, persisted run state, retries, and escalation. A five-minute tick
  // lets the governor enforce each task's own hourly/daily cadence.
  const cleanupGovernorHandle = setTimeout(() => {
    const tick = () => protectedJob('central_cleanup_governor', 'maintenance', async () => {
      const { runCentralCleanupGovernor } = await import('./jobs/centralCleanupGovernor');
      const report = await runCentralCleanupGovernor();
      if (report.failed > 0) {
        throw new Error(`Central cleanup failed tasks: ${report.outcomes
          .filter((outcome) => outcome.status === 'failed')
          .map((outcome) => outcome.id)
          .join(', ')}`);
      }
    });
    void tick();
    const handle = setInterval(tick, 5 * 60 * 1000);
    backgroundHandles.push(handle);
  }, 2 * 60 * 1000);
  backgroundHandles.push(cleanupGovernorHandle);
  // Central Action Lifecycle Governor — the only scheduler for Action Center
  // prompting, deadline acquisition, concerned-party follow-up, commitment
  // renewal, and owner escalation. Specialist workers remain independently
  // testable but no longer own competing timers/policies.
  const actionGovernorHandle = setTimeout(() => {
    const tick = () => protectedJob('central_action_governor', 'critical', async () => {
      const { runCentralActionGovernor } = await import('./jobs/centralActionGovernor');
      const report = await runCentralActionGovernor();
      if (report.failed > 0) {
        throw new Error(`Central action lifecycle failed tasks: ${report.outcomes
          .filter((outcome) => outcome.status === 'failed')
          .map((outcome) => outcome.id)
          .join(', ')}`);
      }
    });
    void tick();
    const handle = setInterval(tick, 5 * 60 * 1000);
    backgroundHandles.push(handle);
  }, 3 * 60 * 1000);
  backgroundHandles.push(actionGovernorHandle);
  // Demo-user expiry sweep — every hour. Flips is_active=false on
  // users whose users.expires_at has passed. First sweep fires 60s
  // after boot so a stale demo doesn't sit live until the first hour
  // mark. Per Basit 2026-06-10.
  setTimeout(() => {
    import('./jobs/demoExpirySuspendJob')
      .then(({ runDemoExpirySweep }) => runDemoExpirySweep())
      .catch((err) => console.warn('Demo expiry sweep failed:', err.message));
    setInterval(() => {
      protectedJob('demo_expiry_sweep', 'important', async () => {
        const { runDemoExpirySweep } = await import('./jobs/demoExpirySuspendJob');
        await runDemoExpirySweep();
      });
    }, 60 * 60 * 1000);
  }, 60 * 1000);

  // Phase 2 Self-Learning — Gap Detection sweep every 24h. First
  // run 5 min after boot so the system has time to settle. The job
  // mines patterns from accumulated Phase 1 interaction logs +
  // feedback to propose product gaps for admin review.
  setTimeout(() => {
    import('./jobs/gapDetectionJob')
      .then(({ runGapDetectionForAllTenants }) => runGapDetectionForAllTenants())
      .catch((err) => console.warn('Gap detection sweep failed:', err.message));
    setInterval(() => {
      import('./jobs/gapDetectionJob')
        .then(({ runGapDetectionForAllTenants }) => runGapDetectionForAllTenants())
        .catch((err) => console.warn('Gap detection sweep failed:', err.message));
    }, 24 * 60 * 60 * 1000);
  }, 5 * 60 * 1000);
  // Personal GDrive sync every 30 minutes (Phase 3.1)
  runPersonalDriveSyncJob().catch((e) => console.warn('[personalDriveSync] failed:', e?.message));
  setInterval(() => protectedJob('personal_drive_sync', 'important', () => runPersonalDriveSyncJob()), 30 * 60 * 1000);
  // Phase 5: Index event processor (polls every 10s)
  startIndexEventProcessor();
  // Phase 5: Proactive intelligence — hourly scan
  setInterval(() => protectedJob('proactive_intelligence', 'important', () => runProactiveIntelligence()), 60 * 60 * 1000);
  // Agent scheduler: initialize all scheduled agents
  import('./agents/agentScheduler').then(({ initializeAgentScheduler }) => {
    initializeAgentScheduler().then(() => console.log('[Agents] Scheduler initialized')).catch(() => {});
  }).catch(() => {});

  // WhatsApp: initialize all tenant connections (non-fatal on failure)
  if (process.env.ENABLE_WHATSAPP === 'true') {
    import('./services/whatsapp/WhatsAppManager').then(({ initializeAllTenants }) => {
      initializeAllTenants().then(() => console.log('[WhatsApp] All tenants initialized')).catch(() => {});
    }).catch(() => {});

    // Heartbeat watchdog — every 5 minutes, probe each tenant marked as
    // connected and self-heal silent dropouts (Chromium hung, browser
    // detached, host slept). Catches the class of failures that don't
    // fire `client.on('disconnected')`. Pairs with the email alert that
    // already fires on hard disconnects.
    import('./services/whatsapp/connectionWatchdog').then(({ startConnectionWatchdog }) => {
      startConnectionWatchdog();
      console.log('[WhatsApp] Connection watchdog started');
    }).catch(() => {});
  }

  // WhatsApp (Personal): resume any previously-paired user sessions so the
  // MD doesn't re-scan after a server restart. Whatsapp-web.js LocalAuth
  // persists the browser session on disk; this call just re-creates the
  // Client instance and reconnects silently.
  if (process.env.ENABLE_WHATSAPP_PERSONAL !== 'false') {
    import('./services/whatsapp/UserWebjsProvider').then(({ resumeAllSessions }) => {
      resumeAllSessions().then(() => console.log('[WhatsApp Personal] User sessions resumed')).catch(() => {});
    }).catch(() => {});
  }
  // Smart log health — escalation and repair remain operational self-healing,
  // while log retention is owned by the central cleanup governor.
  setInterval(() => {
    protectedJob('system_log_maintenance', 'important', async () => {
      const { escalateHighRecurrence, runAutoFix } = await import('./services/systemLogService');
      await escalateHighRecurrence();
      await runAutoFix('GLOBAL');
    });
  }, 60 * 60 * 1000);

  // Self-heal pass — hourly (#5, audit 2026-07-14). Allowlisted,
  // precondition-checked, verify-after, attempt-capped repairs only
  // (stale connector metadata, stuck scribe markers, bounded DLQ
  // replay). Audit trail in self_heal_log; exhaustion escalates to
  // system_logs for a human. First pass 15 min after boot.
  setTimeout(() => {
    const heal = () => protectedJob('self_heal_pass', 'important', async () => {
      const { runSelfHealPass } = await import('./services/selfheal/repairService');
      // OPT-003: evict expired fusion-cache entries on the same pass. A cache
      // that never evicts is a second copy of the data growing forever, which
      // is exactly how llm_spend reached 80% of the database (OPT-001).
      // MEM-001: keep memory reachable. Embedding used to depend on whichever
      // writer remembered to call it, so when the model was retired the whole
      // pipeline stopped and 3,167 pages became unreachable without a sound.
      const { sweepWikiEmbeddings } = await import('./services/knowledge/wikiEmbeddingService');
      const emb = await sweepWikiEmbeddings(200);
      if (emb.attempted > 0) console.log(`[wikiEmbed] ${emb.embedded}/${emb.attempted} embedded${emb.degraded ? ' — PROVIDER DEGRADED' : ''}`);

      const { sweepFusionCache } = await import('./services/triage/criticalityEngineService');
      const swept = await sweepFusionCache();
      if (swept.deleted > 0) console.log(`[fusionCache] evicted ${swept.deleted} stale entries`);
      const r = await runSelfHealPass();
      const healed = Object.entries(r).flatMap(([id, os]) => os.filter((o) => o === 'healed').map(() => id));
      if (healed.length > 0) console.log(`[selfHeal] healed: ${healed.join(', ')}`);
    });
    heal();
    setInterval(heal, 60 * 60 * 1000);
  }, 15 * 60 * 1000);

  // Step 5 (owner ruling 2026-08-07) — Brain reports its own findings instead
  // of waiting to be asked. "i don't want to send screenshots of my whatsapp
  // again and again."
  //
  // Hourly, because that is the resolution the digest needs to fire in the
  // right local hour; severe alerts are deduped to at most one per user per
  // hour inside the notifier, so this cadence does not become a firehose.
  //
  // Deliberately NOT folded into the self-heal pass: healing and telling are
  // different concerns with different failure modes, and a repair rule that
  // could not send must still repair.
  setTimeout(() => {
    const notifyPass = () => protectedJob('finding_notify_pass', 'important', async () => {
      const { runFindingNotifyPass } = await import('./services/selfheal/findingNotifier');
      const { getBehaviorValue } = await import('./services/behaviorConfig');
      const hour = await getBehaviorValue('notify.digest_hour_local', {}).catch(() => 8);
      const r = await runFindingNotifyPass(hour);
      if (r.alerts || r.digests) {
        console.log(`[findingNotify] alerts=${r.alerts} digests=${r.digests}`);
      }
    });
    notifyPass();
    setInterval(notifyPass, 60 * 60 * 1000);
  }, 20 * 60 * 1000);

  // MyOS — attachment_doc backfill worker (Batch 2):
  //   drains historical Gmail events whose attachments pre-date the
  //   attachment-wiki hook. Per-user cursor in system_config, resumable,
  //   idempotent, self-terminating once a user is fully caught up.
  //   New users connecting AFTER activation get attachments live via
  //   the ingest hook and are skipped by this worker.
  import('./jobs/attachmentBackfillWorker').then(({ startAttachmentBackfillWorker }) => {
    startAttachmentBackfillWorker();
  }).catch((e) => console.warn('[attachmentBackfill] start failed:', e.message));

  // Stale-connector proactive ping. Detects sync_stale connectors and
  // surfaces a Brain message asking the user to reconnect.
  import('./jobs/staleConnectorPing').then(({ scheduleStaleConnectorPing }) => {
    scheduleStaleConnectorPing();
  }).catch((e) => console.warn('[staleConnectorPing] start failed:', e.message));

  // Phase F — Wiki lint (hourly): orphans, stale pages, open gaps,
  // contradictions, missing entity pages. Files a Wiki Lint Report page
  // per user so the MD can skim what Brain has flagged.
  import('./jobs/wikiLintWorker').then(({ startWikiLintWorker }) => {
    startWikiLintWorker();
  }).catch((e) => console.warn('[wikiLint] start failed:', e.message));

  // Quality Sprint 5c finish — Reflection worker (every 6h): scans
  // recent WhatsApp turns per active user, proposes INFERRED user
  // preferences as memories awaiting confirmation in Settings UI.
  // Auditable, never silently applied.
  import('./jobs/reflectionJob').then(({ startReflectionWorker }) => {
    startReflectionWorker();
  }).catch((e) => console.warn('[reflection] start failed:', e.message));

  // Brain Cognitive Engine — every 30 min, produce observations + a
  // mind_state per user. This is the "thinking on top of feed + wiki"
  // loop: open loops, stale threads, new contacts, rising topics,
  // frequency shifts. Brain's continuous awareness of what's happening.
  import('./jobs/brainCognitiveWorker').then(({ startBrainCognitiveWorker }) => {
    startBrainCognitiveWorker();
  }).catch((e) => console.warn('[brainCognitive] start failed:', e.message));

  // Obsidian vault export (2026-07-14, Phase 1) — mirror each user's
  // brain (contacts + wiki pages) into a "Nexeo Vault" folder in THEIR
  // OWN Google Drive as plain markdown, for Obsidian. Incremental
  // (hash-skip); silently waits for users who haven't granted
  // drive.file yet. Hourly; first run 10 min after boot.
  setTimeout(() => {
    const vault = () => protectedJob('obsidian_vault_export', 'important', async () => {
      const { exportVaultForAllUsers } = await import('./services/knowledge/obsidianVaultService');
      await exportVaultForAllUsers();
    });
    vault();
    setInterval(vault, 60 * 60 * 1000);
  }, 10 * 60 * 1000);

  // Preactive engine (2026-07-14) — anticipation, not reaction: meeting
  // prep before each meeting with attendees + deadline nudges for open
  // items due within 24h. Every send is deduped (per event / per item
  // per day) so the 15-min cadence is safe. First tick after 2 min so
  // boot isn't burdened.
  setTimeout(() => {
    const tick = () => protectedJob('preactive_engine', 'critical', async () => {
      const { runPreactiveForAllUsers } = await import('./services/brain/preactiveEngine');
      await runPreactiveForAllUsers();
    });
    tick();
    setInterval(tick, 15 * 60 * 1000);
  }, 2 * 60 * 1000);

  // HaseebOS v15 — notification queue drain every 60s. THE outbound
  // dispatcher: leader-locked so replicas can never double-send.
  setInterval(() => {
    protectedJob('notification_drain', 'critical', async () => {
      const { drain } = await import('./services/notifications/notificationService');
      const r = await drain({ batchSize: 25, maxRetries: 3 });
      if (r.sent > 0 || r.failed > 0) {
        console.log(`[notifications] drain: sent=${r.sent} failed=${r.failed} deferred=${r.deferred}`);
      }
    });
  }, 60 * 1000);

  // MyOS wiki lint — nightly 03:00 PKT (22:00 UTC previous day) per user
  setInterval(async () => {
    const now = new Date();
    // PKT is UTC+5. 03:00 PKT = 22:00 UTC. Fire once within the first 5 min.
    if (now.getUTCHours() !== 22 || now.getUTCMinutes() >= 5) return;
    try {
      const prisma = (await import('./db/prisma')).default;
      const { mineWikiHealth } = await import('./services/wiki/wikiLintService');
      const { enqueue: enqueueNotification } = await import('./services/notifications/notificationService');
      const tenants = await prisma.tenant.findMany({ where: { isActive: true }, select: { clientNumber: true } });
      for (const t of tenants) {
        const users = await prisma.user.findMany({
          where: { clientNumber: t.clientNumber, isActive: true } as any,
          select: { id: true },
        });
        for (const u of users) {
          try {
            const findings = await mineWikiHealth(t.clientNumber, u.id);
            if (findings.suggestions.length > 0) {
              await enqueueNotification({
                clientNumber: t.clientNumber,
                recipientId: u.id,
                channel: 'in_app',
                payload: {
                  kind: 'wiki_lint',
                  subject: `Wiki health: ${findings.pageCount} pages, ${findings.suggestions.length} suggestions`,
                  body: findings.suggestions.join('\n'),
                  findings,
                },
              }).catch(() => {});
            }
          } catch (err: any) {
            console.warn(`[wikiLint] ${t.clientNumber}/${u.id} failed:`, err.message);
          }
        }
      }
    } catch (err: any) {
      console.warn('[wikiLint] loop error:', err.message);
    }
  }, 5 * 60 * 1000);

  // MyOS — daily FACL folder scribe. Re-walks every user's designated
  // Gdrive folder, re-summarizes docs that changed, and refreshes the
  // sender-aware org knowledge in wiki_pages (pageType='org_doc').
  // Fires once every 24h at the first tick after boot, then every 24h.
  // Uses an interval, not cron, for simplicity; idle if no user has a
  // faclFolderId set.
  setTimeout(() => {
    void (async () => {
      try {
        const { runDailyFaclScribe } = await import('./services/knowledge/folderScribeService');
        const results = await runDailyFaclScribe();
        if (results.length > 0) {
          console.log(`[faclScribe] daily: ${results.length} users scribed, ${results.reduce((s, r) => s + r.updated, 0)} docs updated`);
        }
      } catch (err: any) {
        console.warn('[faclScribe] daily error:', err.message);
      }
    })();
  }, 5 * 60 * 1000); // first run 5 min after boot
  setInterval(async () => {
    try {
      const { runDailyFaclScribe } = await import('./services/knowledge/folderScribeService');
      const results = await runDailyFaclScribe();
      if (results.length > 0) {
        console.log(`[faclScribe] daily: ${results.length} users scribed, ${results.reduce((s, r) => s + r.updated, 0)} docs updated`);
      }
    } catch (err: any) {
      console.warn('[faclScribe] daily error:', err.message);
    }
  }, 24 * 60 * 60 * 1000);

  // D2 — trust promotion daily: propose (never auto-apply) raising the
  // automation level for action types the user consistently approves.
  setInterval(async () => {
    try {
      const { proposeTrustPromotions } = await import('./jobs/trustPromotionJob');
      await proposeTrustPromotions();
    } catch (err: any) {
      console.warn('[trustPromotion] error:', err.message);
    }
  }, 24 * 60 * 60 * 1000);

  // B1 — dispatched-action reaper every 5 min: AgentAction rows published
  // to the ADK worker that never received a confirmation move to 'stale'
  // (outcome unknown) — they must NEVER silently read as done.
  setInterval(() => {
    protectedJob('agent_action_reaper', 'critical', async () => {
      const { reapStaleAgentActions, reconcileStuckExecuting } = await import('./jobs/agentActionReaper');
      const r = await reapStaleAgentActions();
      if (r.reaped > 0) console.log(`[agentActionReaper] reaped=${r.reaped} dispatched→stale`);
      const rec = await reconcileStuckExecuting();
      if (rec.scanned > 0) console.log(`[agentActionReaper] reconciled executing: recovered=${rec.recovered} failed=${rec.failed} staled=${rec.staled}`);
    });
  }, 5 * 60 * 1000);

  // HaseebOS v15 L2 — snooze timer every 60s: wake SNOOZED items when due
  setInterval(() => {
    protectedJob('snooze_unblocker', 'important', async () => {
      const { wakeSnoozed } = await import('./jobs/snoozeUnblocker');
      const r = await wakeSnoozed();
      if (r.unblocked > 0 || r.errors > 0) {
        console.log(`[snooze] scanned=${r.scanned} unblocked=${r.unblocked} errors=${r.errors}`);
      }
    });
  }, 60 * 1000);

  // MyOS — critical-bundle WhatsApp sweep every 90s. Lives here, not in
  // /brief/attention, so opening the Day Brief in two tabs (or any other
  // double-fetch) doesn't cause duplicate WhatsApp pushes. The sweep
  // itself is idempotent via in-flight set + lastSent fingerprint cache.
  setInterval(() => {
    protectedJob('critical_bundle_sweep', 'critical', async () => {
      const { sweepCriticalBundles } = await import('./services/triage/criticalityNotifier');
      const s = await sweepCriticalBundles();
      if (s.sent > 0 || s.errors > 0) {
        console.log(`[criticalBundleSweep] users=${s.users} sent=${s.sent} skipped=${s.skipped} errors=${s.errors}`);
      }
    });
  }, 90 * 1000);

  // MyOS — connector health sweep every 5 min. Catches the OAuth-
  // Testing-mode 7-day expiry case (Gmail/Calendar/Drive go silent
  // simultaneously, status='connected' lies, no error logged) before
  // it costs the user days of empty Day Brief. Flips status to
  // sync_stale on connectors past their cadence threshold and fires
  // one Brain WhatsApp ping per occurrence (deduped). See memory:
  // project_oauth_stale_sync_failure.md.
  setInterval(() => {
    protectedJob('connector_health_sweep', 'important', async () => {
      const { detectStaleConnectors, sweepStaleErrorMetadata } = await import('./services/connectorHealthService');
      const [staleResult, metaResult] = await Promise.all([
        detectStaleConnectors(),
        // Belt-and-suspenders: scrub stale-error metadata from any
        // status='connected' row that still carries old lastRefreshError
        // breadcrumbs. Without this, a buggy caller (or manual SQL) that
        // flips status without clearing metadata leaves the BrokenConnector
        // banner showing the row as broken. See memory:
        // feedback_connector_status_is_truth.md.
        sweepStaleErrorMetadata(),
      ]);
      if (staleResult.flipped > 0 || metaResult.cleaned > 0) {
        console.log(`[connectorHealth] stale: scanned=${staleResult.scanned} flipped=${staleResult.flipped} | meta-sweep: scanned=${metaResult.scanned} cleaned=${metaResult.cleaned}`);
      }
    });
  }, 5 * 60 * 1000);

  // 2026-05-16 — Day Brief dispatch. Fires each opted-in user's
  // daily brief on WhatsApp at their configured local time
  // (brain_channel.dayBriefTime + .timezone). Ticks every minute;
  // each user fires once per local-day. Composer + WA renderer
  // shared with /brain/ask so web and WhatsApp see the same brain.
  setInterval(() => {
    protectedJob('day_brief_dispatch', 'critical', async () => {
      const { runDayBriefDispatch } = await import('./jobs/dayBriefDispatchJob');
      const s = await runDayBriefDispatch();
      if (s.fired + s.errors > 0) {
        console.log(`[dayBriefDispatch] scanned=${s.scanned} fired=${s.fired} skipped=${s.skipped} errors=${s.errors}`);
      }
    });
  }, 60 * 1000);

  // 2026-05-15 — WA ingest health audit. Reconciles webjs's view of
  // each chat against feed_events + whatsapp_outbound_messages and
  // emits a structured warning when coverage drops below 80%.
  // Per user: "make sure this should not happen again" — Aziz
  // Masood thread had only 1 of ~5 inbound captured and zero
  // outbound. This job makes that gap loud instead of silent.
  setTimeout(() => {
    void (async () => {
      try {
        const { runWaIngestHealthAudit } = await import('./jobs/waIngestHealthAudit');
        const s = await runWaIngestHealthAudit();
        console.log(`[waIngestAudit] users=${s.usersAudited} chats=${s.chatsAudited} gaps=${s.gapsFound} errors=${s.errors}`);
      } catch (err: any) {
        console.warn('[waIngestAudit] error:', err.message);
      }
    })();
  }, 10 * 60 * 1000); // first run 10 min after boot
  setInterval(async () => {
    try {
      const { runWaIngestHealthAudit } = await import('./jobs/waIngestHealthAudit');
      const s = await runWaIngestHealthAudit();
      console.log(`[waIngestAudit] users=${s.usersAudited} chats=${s.chatsAudited} gaps=${s.gapsFound} errors=${s.errors}`);
    } catch (err: any) {
      console.warn('[waIngestAudit] error:', err.message);
    }
  }, 24 * 60 * 60 * 1000); // daily

  // 2026-05-16 — WA outbound reconciliation (Path 3 of 3 in the
  // defense-in-depth model). Walks recent chats per connected user
  // every 10 min and writes any outbound rows missed by the
  // message_create listener or the on-inbound back-catch-up. With
  // all three paths running, an outbound has to slip past ALL of
  // them to be silently lost — improbable. The daily ingest audit
  // catches anything that somehow does.
  setTimeout(() => {
    void (async () => {
      try {
        const { runWaOutboundReconciliation } = await import('./jobs/waOutboundReconciliation');
        const s = await runWaOutboundReconciliation();
        if (s.outboundWritten > 0 || s.errors > 0) {
          console.log(`[waOutboundRecon] users=${s.usersScanned} chats=${s.chatsScanned} written=${s.outboundWritten} errors=${s.errors}`);
        }
      } catch (err: any) {
        console.warn('[waOutboundRecon] error:', err.message);
      }
    })();
  }, 7 * 60 * 1000); // first run 7 min after boot
  setInterval(() => {
    protectedJob('wa_outbound_reconciliation', 'important', async () => {
      const { runWaOutboundReconciliation } = await import('./jobs/waOutboundReconciliation');
      const s = await runWaOutboundReconciliation();
      if (s.outboundWritten > 0 || s.errors > 0) {
        console.log(`[waOutboundRecon] users=${s.usersScanned} chats=${s.chatsScanned} written=${s.outboundWritten} errors=${s.errors}`);
      }
    });
  }, 10 * 60 * 1000); // every 10 min

  // HaseebOS v15 L1.4 — feed publish retry catch-up worker every 2 min
  setInterval(() => {
    protectedJob('feed_publish_retry', 'important', async () => {
      const { retryUnpublishedFeedEvents } = await import('./jobs/feedPublishRetry');
      const s = await retryUnpublishedFeedEvents(50);
      if (s.republished > 0 || s.errors > 0 || s.deadLettered > 0) {
        console.log(`[feedPubRetry] scanned=${s.scanned} republished=${s.republished} errors=${s.errors} dlq=${s.deadLettered}`);
      }
    });
  }, 2 * 60 * 1000);

  // HaseebOS v15 L1 — generic feed poller every 2 min (drives all adapters
  // with receive capability via adapterRegistry). Worst-case latency for a
  // new email landing in My Attention is therefore ~2 min server-side plus
  // the client's 2-min auto-refresh on Day Brief. The legacy gmailFeedPoller
  // still exports enrichBody() for VIP pull, but no longer runs on its own
  // schedule.
  setInterval(() => {
    protectedJob('generic_feed_poller', 'important', async () => {
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
    });
  }, 2 * 60 * 1000);

  // ── Queue/archive durability ──────────────────────────────────
  // Scribe backfill is a recovery/copy concern, so it retains its six-hour
  // operational schedule. Destructive feed pruning is governed exclusively
  // by centralCleanupGovernor and only runs after this durable copy exists.

  // Scribe backfill — every 6 hours. Catches any feed_events that
  //    didn't get a scribe sibling at ingest time (Gmail OAuth was
  //    invalid_grant when ingestEmailBody ran, etc.). Idempotent;
  //    the cost is one count + one find per row that already has a
  //    scribe sibling. Sequential across users so we don't DoS the DB.
  setInterval(async () => {
    try {
      const { backfillUserScribe, forEachActiveUser } =
        await import('./services/maintenance/queueArchiveMaintenanceService');
      const results = await forEachActiveUser((cn, uid) => backfillUserScribe(cn, uid));
      const totalCreated = results.reduce((s, r) => s + (r.result?.created ?? 0), 0);
      const totalErrors = results.reduce((s, r) => s + (r.result?.errors ?? 0), 0) +
        results.filter((r) => r.error).length;
      if (totalCreated > 0 || totalErrors > 0) {
        console.log(`[scribe-backfill] users=${results.length} created=${totalCreated} errors=${totalErrors}`);
      }
    } catch (err: any) {
      console.warn('[scribe-backfill] error:', err.message);
    }
  }, 6 * 60 * 60 * 1000);

  // MyOS — Google Calendar poller every 2 min (was 10 min). Tightened
  // for near-realtime Day Brief freshness; Calendar API quota is
  // generous and we only pull a 48h window. True realtime needs
  // events.watch() push — a separate feature.
  setInterval(async () => {
    try {
      const { pollAllActiveCalendarUsers } = await import('./jobs/gcalFeedPoller');
      const r = await pollAllActiveCalendarUsers();
      const ingested = r.reduce((s, x) => s + x.ingested, 0);
      const errors = r.reduce((s, x) => s + x.errors, 0);
      if (ingested > 0 || errors > 0) {
        console.log(`[gcalPoll] users=${r.length} ingested=${ingested} errors=${errors}`);
      }
    } catch (err: any) {
      console.warn('[gcalPoll] error:', err.message);
    }
  }, 2 * 60 * 1000);

  // MyOS — Gmail read-state sync every 2 min (was 5 min). Tightened
  // so Day Brief reflects "I just read this in Gmail" within a couple
  // minutes. Cheap — pulls IDs only.
  setInterval(async () => {
    try {
      const { syncAllActiveGmailUsers } = await import('./jobs/gmailReadStateSyncJob');
      const r = await syncAllActiveGmailUsers();
      const updated = r.reduce((s, x) => s + x.updated, 0);
      const errors = r.reduce((s, x) => s + x.errors, 0);
      if (updated > 0 || errors > 0) {
        console.log(`[gmailReadSync] users=${r.length} updated=${updated} errors=${errors}`);
      }
    } catch (err: any) {
      console.warn('[gmailReadSync] error:', err.message);
    }
  }, 2 * 60 * 1000);

  // MyOS — Google Tasks poller every 5 min (was 15 min). Tasks have no
  // push API at all — poll is the only path — so we pull more often.
  // Quota is tiny per call; well within Tasks API limits.
  setInterval(async () => {
    try {
      const { pollAllActiveTasksUsers } = await import('./jobs/gtasksFeedPoller');
      const r = await pollAllActiveTasksUsers();
      const ingested = r.reduce((s, x) => s + x.ingested, 0);
      const errors = r.reduce((s, x) => s + x.errors, 0);
      if (ingested > 0 || errors > 0) {
        console.log(`[gtasksPoll] users=${r.length} ingested=${ingested} errors=${errors}`);
      }
    } catch (err: any) {
      console.warn('[gtasksPoll] error:', err.message);
    }
  }, 5 * 60 * 1000);

  // MyOS — WhatsApp freshness heartbeat every 2 min. WebJS is event-
  // driven (no poll cycle), so without this the userConnector.lastSyncAt
  // for whatsapp_personal stayed at the last incoming message — could
  // be days stale even on a healthy connection. The heartbeat stamps
  // lastSyncAt for every user whose live webjs client is in the
  // CONNECTED state, so Day Brief's "Last synced X ago" reflects
  // channel liveness, not last-message-arrival.
  setInterval(async () => {
    try {
      const { heartbeatAllConnected } = await import('./services/whatsapp/UserWebjsProvider');
      await heartbeatAllConnected();
    } catch (err: any) {
      console.warn('[wa-heartbeat] error:', err.message);
    }
  }, 2 * 60 * 1000);

  // MyOS — Google Chat poller every 5 min (was 20 min). Same poll-only
  // constraint as Tasks for the user-OAuth scope (no push notifications
  // for personal chat). 5 min keeps the conversation feel without
  // hammering the API.
  setInterval(async () => {
    try {
      const { pollAllActiveChatUsers } = await import('./jobs/gchatFeedPoller');
      const r = await pollAllActiveChatUsers();
      const ingested = r.reduce((s, x) => s + x.ingested, 0);
      const errors = r.reduce((s, x) => s + x.errors, 0);
      if (ingested > 0 || errors > 0) {
        console.log(`[gchatPoll] users=${r.length} ingested=${ingested} errors=${errors}`);
      }
    } catch (err: any) {
      console.warn('[gchatPoll] error:', err.message);
    }
  }, 5 * 60 * 1000);

  // MyOS — Notion mirror every 10 min. Pushes postgres-backed wiki pages to
  // Notion for users with a connected Notion connector. Graceful no-op when
  // no connector is present.
  setInterval(() => {
    protectedJob('notion_mirror_sync', 'important', async () => {
      const { mirrorAllTenants } = await import('./jobs/notionMirrorSync');
      await mirrorAllTenants();
    });
  }, 10 * 60 * 1000);

  // MyOS — Reflection agent every 6 hours. Aggregates decisions / delegations
  // / ignores / autonomous actions into human-readable pattern_insights that
  // surface on Day Brief's "Noticed overnight" section.
  setInterval(async () => {
    try {
      const { reflectAllUsers } = await import('./services/reflection/reflectionService');
      const rs = await reflectAllUsers();
      const written = rs.reduce((s, r) => s + r.insightsWritten, 0);
      if (written > 0) console.log(`[reflection] users=${rs.length} insights_written=${written}`);
    } catch (err: any) {
      console.warn('[reflection] error:', err.message);
    }
  }, 6 * 60 * 60 * 1000);

  // MyOS Knowledge — Wiki Linter every hour: classify each wiki_page as
  // active / stale / orphan / contradicted + reconcile link counts.
  setInterval(async () => {
    try {
      const { lintAllWikiPages } = await import('./services/knowledge/wikiLinterService');
      const r = await lintAllWikiPages();
      if (r.scanned > 0 && (r.marked_stale > 0 || r.marked_orphan > 0 || r.marked_contradicted > 0 || r.marked_active > 0)) {
        console.log(`[wikiLinter] scanned=${r.scanned} active=${r.marked_active} stale=${r.marked_stale} orphan=${r.marked_orphan} contradicted=${r.marked_contradicted} ${r.durationMs}ms`);
      }
    } catch (err: any) {
      console.warn('[wikiLinter] error:', err.message);
    }
  }, 60 * 60 * 1000);

  // MyOS — Rule Miner every 15 min: walks decision_logs + delegation_logs
  // aggregates, auto-creates shadow_rules as patterns reach DRAFT/SHADOW
  // thresholds. Cheap (one raw aggregate query + per-row upsert).
  setInterval(async () => {
    try {
      const { mineRulesForAllTenants } = await import('./services/triage/ruleMiner');
      const r = await mineRulesForAllTenants();
      if (r.scanned > 0 || r.drafts > 0 || r.shadows > 0 || r.errors > 0) {
        console.log(`[ruleMiner] scanned=${r.scanned} newDrafts=${r.drafts} newShadows=${r.shadows} unchanged=${r.unchanged} errors=${r.errors} ${r.durationMs}ms`);
      }
    } catch (err: any) {
      console.warn('[ruleMiner] error:', err.message);
    }
  }, 15 * 60 * 1000);

  // HaseebOS v15 — Notion reverse sync every 5 min (feature-flag gated per tenant)
  setInterval(() => {
    protectedJob('notion_reverse_sync', 'important', async () => {
      const { reverseSyncAllTenants } = await import('./jobs/notionReverseSync');
      const r = await reverseSyncAllTenants();
      const updated = r.reduce((s, x) => s + x.updated, 0);
      const conflicts = r.reduce((s, x) => s + x.conflicts, 0);
      if (updated > 0 || conflicts > 0) {
        console.log(`[notionSync] updated=${updated} conflicts=${conflicts} tenants=${r.length}`);
      }
    });
  }, 5 * 60 * 1000);

  // HaseebOS v15 — daily KPI snapshot at 06:00 PKT per tenant
  setInterval(async () => {
    const now = new Date();
    // PKT is UTC+5. 06:00 PKT = 01:00 UTC. Only fire within the first 5 min of the hour.
    if (now.getUTCHours() !== 1 || now.getUTCMinutes() >= 5) return;
    await protectedJob('kpi_snapshot_morning_brief', 'critical', async () => {
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
    });
  }, 5 * 60 * 1000); // check every 5 min, fires once within the 06:00 PKT window
});

// L1 — Graceful shutdown. Cloud Run sends SIGTERM and waits 10s before
// SIGKILL. We stop accepting new connections, let in-flight requests drain,
// clear scheduler intervals we hold handles for, and disconnect Prisma so
// the DB pool shuts down cleanly.
async function gracefulShutdown(signal: string) {
  console.log(`[shutdown] received ${signal}, draining...`);

  // Stop accepting new connections; in-flight requests finish.
  server.close(() => console.log('[shutdown] HTTP server closed'));

  // Clear any scheduler intervals whose handles we have captured.
  for (const h of backgroundHandles) clearInterval(h);

  // Destroy the WhatsApp Web.js clients BEFORE exiting — otherwise
  // the headless Chromium gets SIGKILL'd by the OS, which leaves
  // LocalAuth's session store half-written on disk. That's the
  // "keeps needing a new QR scan after every restart" symptom.
  try {
    const { destroyAllClients } = await import('./services/whatsapp/WebjsProvider');
    await destroyAllClients();
    console.log('[shutdown] whatsapp (tenant) clients destroyed');
  } catch (err: any) {
    console.warn('[shutdown] whatsapp tenant destroy error:', err.message);
  }
  try {
    const { destroyAllUserSessions } = await import('./services/whatsapp/UserWebjsProvider');
    await destroyAllUserSessions();
    console.log('[shutdown] whatsapp (user) sessions destroyed');
  } catch (err: any) {
    console.warn('[shutdown] whatsapp user destroy error:', err.message);
  }

  // Release DB pool. Dynamic import to avoid circular issues.
  try {
    const prisma = (await import('./db/prisma')).default;
    await prisma.$disconnect();
    console.log('[shutdown] prisma disconnected');
  } catch (err: any) {
    console.warn('[shutdown] prisma disconnect error:', err.message);
  }

  // Hard-kill fallback after 8s so we never exceed the 10s SIGKILL window.
  setTimeout(() => {
    console.warn('[shutdown] forced exit after timeout');
    process.exit(0);
  }, 8000).unref();
}

process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
process.on('SIGINT',  () => { void gracefulShutdown('SIGINT'); });

// Observability: don't let a stray rejection crash the process silently.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
