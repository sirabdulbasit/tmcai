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
import { cleanupExpiredContextMemories } from './services/memoryService';
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

// L1 — track interval/timeout handles so SIGTERM can clear them cleanly.
// Every setInterval/setTimeout below that is assigned-for-cleanup gets
// pushed into `backgroundHandles` and is cleared by the shutdown hook.
// NOTE: the current implementation registers 15+ timers without capturing
// their handles; full cleanup requires converting them as part of the
// broader scheduler-extraction work (finding C3). This hook gets us the
// HTTP-server drain and DB disconnect today.
const backgroundHandles: Array<NodeJS.Timeout> = [];

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
  // Open-item follow-up worker — hourly. Scans DELEGATED items that
  // have been silent past their threshold (3d / 7d / 14d) and pings
  // the user via brainContactsUser. "Brain runs after you" piece.
  // First sweep fires 5 minutes after boot so the scheduler isn't
  // bombarded at startup.
  setTimeout(() => {
    import('./services/openItems/followupWorker')
      .then(({ runFollowupSweep }) => runFollowupSweep())
      .catch((err) => console.warn('Followup sweep failed:', err.message));
    setInterval(() => {
      import('./services/openItems/followupWorker')
        .then(({ runFollowupSweep }) => runFollowupSweep())
        .catch((err) => console.warn('Followup sweep failed:', err.message));
    }, 60 * 60 * 1000);
  }, 5 * 60 * 1000);

  // Brain prompt queue — producer sweep + expiry sweep + delegatee email,
  // all every 30 min.
  //   Producer:        scans new auto-created open items missing a
  //                    deadline / missing an owner / critical-with-pending-
  //                    deadline, enqueues the right WhatsApp prompt for
  //                    the user.
  //   Expiry:          auto-skips prompts past 48h TTL so a silent user
  //                    doesn't deadlock the queue forever.
  //   Delegatee email: items DELEGATED with a delegateeEmail but no
  //                    dueDate get an email from the user's Gmail asking
  //                    "by when?". Reply matched on threadId by the feed
  //                    ingestion handler updates dueDate automatically.
  setTimeout(() => {
    import('./services/brainPrompts/producerSweep')
      .then(({ runProducerSweep }) => runProducerSweep())
      .catch((err) => console.warn('Producer sweep failed:', err.message));
    import('./services/brainPrompts/brainPromptQueueService')
      .then(({ expireStalePrompts }) => expireStalePrompts())
      .catch((err) => console.warn('Expiry sweep failed:', err.message));
    import('./services/brainPrompts/delegateeEmailProducer')
      .then(({ runDelegateeEmailSweep }) => runDelegateeEmailSweep())
      .catch((err) => console.warn('Delegatee email sweep failed:', err.message));
    setInterval(() => {
      import('./services/brainPrompts/producerSweep')
        .then(({ runProducerSweep }) => runProducerSweep())
        .catch((err) => console.warn('Producer sweep failed:', err.message));
      import('./services/brainPrompts/brainPromptQueueService')
        .then(({ expireStalePrompts }) => expireStalePrompts())
        .catch((err) => console.warn('Expiry sweep failed:', err.message));
      import('./services/brainPrompts/delegateeEmailProducer')
        .then(({ runDelegateeEmailSweep }) => runDelegateeEmailSweep())
        .catch((err) => console.warn('Delegatee email sweep failed:', err.message));
    }, 30 * 60 * 1000);
  }, 6 * 60 * 1000);

  // Junk contact cleanup — daily at ~3am UTC (with first run ~10 min
  // after boot to seed coverage). Soft-archives entity_person pages
  // whose email matches the same isLikelyAutomated() filter that gates
  // new auto-discovery: no-reply / mailer-daemon / postmaster /
  // newsletter@ / marketing@ / tracking-token prefixes. Reversible —
  // status flips 'active' → 'archived', not deleted. Real humans never
  // get touched (filter is conservative; support@ / help@ excluded).
  setTimeout(() => {
    import('./jobs/junkContactCleanupJob')
      .then(({ runJunkContactCleanup }) => runJunkContactCleanup())
      .catch((err) => console.warn('Junk contact cleanup failed:', err.message));
    setInterval(() => {
      import('./jobs/junkContactCleanupJob')
        .then(({ runJunkContactCleanup }) => runJunkContactCleanup())
        .catch((err) => console.warn('Junk contact cleanup failed:', err.message));
    }, 24 * 60 * 60 * 1000);
  }, 10 * 60 * 1000);

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
  // Smart log maintenance — hourly: escalate high-recurrence, auto-fix known patterns, cleanup old
  setInterval(async () => {
    try {
      const { escalateHighRecurrence, runAutoFix, cleanupOldLogs } = await import('./services/systemLogService');
      await escalateHighRecurrence();
      await runAutoFix('GLOBAL');
      await cleanupOldLogs(90);
    } catch {}
  }, 60 * 60 * 1000);

  // Memory consolidation — nightly. Archives low-value episodic pages
  // (email_message / sender_topic / observation / answer / gap) after
  // their aging policy is met. Conservative — only sets status='archived',
  // never deletes. First run waits 6h after boot to avoid restart churn.
  const memoryConsolidationHandle = setTimeout(() => {
    const tick = async () => {
      try {
        const { runConsolidationAllTenants } = await import('./services/knowledge/memoryConsolidationService');
        await runConsolidationAllTenants();
      } catch (err: any) {
        console.warn('[memory-consolidation] tick failed:', err.message);
      }
    };
    void tick();
    const handle = setInterval(tick, 24 * 60 * 60 * 1000);
    backgroundHandles.push(handle);
  }, 6 * 60 * 60 * 1000);
  backgroundHandles.push(memoryConsolidationHandle);

  // MyOS — attachment_doc backfill worker (Batch 2):
  //   drains historical Gmail events whose attachments pre-date the
  //   attachment-wiki hook. Per-user cursor in system_config, resumable,
  //   idempotent, self-terminating once a user is fully caught up.
  //   New users connecting AFTER activation get attachments live via
  //   the ingest hook and are skipped by this worker.
  import('./jobs/attachmentBackfillWorker').then(({ startAttachmentBackfillWorker }) => {
    startAttachmentBackfillWorker();
  }).catch((e) => console.warn('[attachmentBackfill] start failed:', e.message));

  // Phase F — Wiki lint (hourly): orphans, stale pages, open gaps,
  // contradictions, missing entity pages. Files a Wiki Lint Report page
  // per user so the MD can skim what Brain has flagged.
  import('./jobs/wikiLintWorker').then(({ startWikiLintWorker }) => {
    startWikiLintWorker();
  }).catch((e) => console.warn('[wikiLint] start failed:', e.message));

  // Brain Cognitive Engine — every 30 min, produce observations + a
  // mind_state per user. This is the "thinking on top of feed + wiki"
  // loop: open loops, stale threads, new contacts, rising topics,
  // frequency shifts. Brain's continuous awareness of what's happening.
  import('./jobs/brainCognitiveWorker').then(({ startBrainCognitiveWorker }) => {
    startBrainCognitiveWorker();
  }).catch((e) => console.warn('[brainCognitive] start failed:', e.message));

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

  // MyOS — delegation follow-up scheduler every 30 min: nudge delegatees
  // whose 7-day window has passed without a response. Escalates after 3
  // attempts without response instead of nagging forever.
  setInterval(async () => {
    try {
      const { runDelegationFollowUp } = await import('./jobs/delegationFollowUpJob');
      const s = await runDelegationFollowUp();
      if (s.sent > 0 || s.escalated > 0 || s.errors > 0) {
        console.log(`[delegationFollowUp] scanned=${s.scanned} sent=${s.sent} escalated=${s.escalated} errors=${s.errors}`);
      }
    } catch (err: any) {
      console.warn('[delegationFollowUp] error:', err.message);
    }
  }, 30 * 60 * 1000);

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

  // MyOS — critical-bundle WhatsApp sweep every 90s. Lives here, not in
  // /brief/attention, so opening the Day Brief in two tabs (or any other
  // double-fetch) doesn't cause duplicate WhatsApp pushes. The sweep
  // itself is idempotent via in-flight set + lastSent fingerprint cache.
  setInterval(async () => {
    try {
      const { sweepCriticalBundles } = await import('./services/triage/criticalityNotifier');
      const s = await sweepCriticalBundles();
      if (s.sent > 0 || s.errors > 0) {
        console.log(`[criticalBundleSweep] users=${s.users} sent=${s.sent} skipped=${s.skipped} errors=${s.errors}`);
      }
    } catch (err: any) {
      console.warn('[criticalBundleSweep] error:', err.message);
    }
  }, 90 * 1000);

  // MyOS — open-items backlog cleanup every 60min. Walks the backlog and
  // applies the same quality gate that gates auto-creates, plus a
  // stale-no-engagement sweep and duplicate collapse. Critical items
  // are never touched. This is the "Brain handles it itself" half of
  // bulk archive — runaway backlogs (2K+ open items) get pulled back
  // to a usable size autonomously.
  setTimeout(() => {
    void (async () => {
      try {
        const { runOpenItemsBacklogCleanup } = await import('./jobs/openItemsBacklogCleanupJob');
        const s = await runOpenItemsBacklogCleanup();
        if (s.archivedByGate + s.archivedStale + s.archivedDuplicate > 0) {
          console.log(`[openItemsBacklog] scanned=${s.scanned} gate=${s.archivedByGate} stale=${s.archivedStale} dup=${s.archivedDuplicate} errors=${s.errors}`);
        }
      } catch (err: any) {
        console.warn('[openItemsBacklog] error:', err.message);
      }
    })();
  }, 2 * 60 * 1000); // first run 2 min after boot
  setInterval(async () => {
    try {
      const { runOpenItemsBacklogCleanup } = await import('./jobs/openItemsBacklogCleanupJob');
      const s = await runOpenItemsBacklogCleanup();
      if (s.archivedByGate + s.archivedStale + s.archivedDuplicate > 0) {
        console.log(`[openItemsBacklog] scanned=${s.scanned} gate=${s.archivedByGate} stale=${s.archivedStale} dup=${s.archivedDuplicate} errors=${s.errors}`);
      }
    } catch (err: any) {
      console.warn('[openItemsBacklog] error:', err.message);
    }
  }, 60 * 60 * 1000);

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

  // HaseebOS v15 L1 — generic feed poller every 2 min (drives all adapters
  // with receive capability via adapterRegistry). Worst-case latency for a
  // new email landing in My Attention is therefore ~2 min server-side plus
  // the client's 2-min auto-refresh on Day Brief. The legacy gmailFeedPoller
  // still exports enrichBody() for VIP pull, but no longer runs on its own
  // schedule.
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
  }, 2 * 60 * 1000);

  // ── Queue/archive maintenance ─────────────────────────────────
  // Two scheduled jobs that keep feed_events trimmed to a 30-day
  // rolling active queue while ensuring scribe (wiki_pages
  // email_message) holds the permanent archive. Both run for every
  // active user automatically — new users get picked up on the next
  // tick without any manual intervention. Per user instruction
  // (2026-05-07): "who will run these scripts? and when?" — answer:
  // the server, on this schedule, for everyone.

  // 1. Scribe backfill — every 6 hours. Catches any feed_events that
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

  // 2. feed_events pruner — every 24 hours. Removes rows that are
  //    older than 30 days OR have a terminal decision_log entry,
  //    PROVIDED a scribe sibling exists (no data loss). Runs in
  //    --apply mode unattended; the safety check is the scribe
  //    sibling + the dry-run period the operator already validated.
  setInterval(async () => {
    try {
      const { pruneUserFeedEvents, forEachActiveUser } =
        await import('./services/maintenance/queueArchiveMaintenanceService');
      const results = await forEachActiveUser((cn, uid) =>
        pruneUserFeedEvents(cn, uid, { apply: true }),
      );
      const totalDeleted = results.reduce((s, r) => s + (r.result?.deleted ?? 0), 0);
      const totalBlocked = results.reduce((s, r) => s + (r.result?.blockedNoScribe ?? 0), 0);
      if (totalDeleted > 0 || totalBlocked > 0) {
        console.log(`[feed-pruner] users=${results.length} deleted=${totalDeleted} blocked-no-scribe=${totalBlocked}`);
      }
    } catch (err: any) {
      console.warn('[feed-pruner] error:', err.message);
    }
  }, 24 * 60 * 60 * 1000);

  // MyOS — Google Calendar poller every 10 min. Pulls next 48h of events
  // for every user with an active Google integration so the Meetings tile
  // and the triage pipeline see fresh calendar data.
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
  }, 10 * 60 * 1000);

  // MyOS — Notion mirror every 10 min. Pushes postgres-backed wiki pages to
  // Notion for users with a connected Notion connector. Graceful no-op when
  // no connector is present.
  setInterval(async () => {
    try {
      const { mirrorAllTenants } = await import('./jobs/notionMirrorSync');
      await mirrorAllTenants();
    } catch (err: any) {
      console.warn('[notionMirror] error:', err.message);
    }
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
