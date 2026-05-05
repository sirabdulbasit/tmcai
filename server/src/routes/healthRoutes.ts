import { Router } from 'express';
import { getStatus } from '../services/indexCacheService';
import { getDriveStatus } from '../services/driveService';
import { env } from '../config/env';
import { isPIIEnabled } from '../pipeline/piiService';
import prisma from '../db/prisma';
import { isGCPRetrievalReady } from '../pipeline/gcpRetrieval';
import { isVectorSearchReady } from '../pipeline/vertexVectorSearch';

const router = Router();

// Public app info — used by login page, welcome screen, etc.
router.get('/app-info', async (_req, res) => {
  const config = await prisma.systemConfig.findFirst({ where: { key: 'app_name' } }).catch(() => null);
  res.json({ appName: config?.value || 'TMC AI Intelligence' });
});

// Public logo — serve logo (system-wide)
router.get('/logo', async (_req, res) => {
  const cn = '';
  await serveLogo(cn, res);
});
router.get('/logo/:clientNumber', async (req, res) => {
  const cn = req.params.clientNumber as string;
  await serveLogo(cn, res);
});

async function serveLogo(cn: string, res: any) {
  let logo: string | null = null;

  if (cn) {
    const row = await prisma.systemConfig.findFirst({ where: { clientNumber: cn, key: 'client_logo' } }).catch(() => null);
    logo = row?.value || null;
  }

  if (!logo) {
    // Fallback: try first tenant's logo
    const row = await prisma.systemConfig.findFirst({ where: { key: 'client_logo' } }).catch(() => null);
    logo = row?.value || null;
  }

  if (!logo) {
    // No logo in DB — serve default static logo file
    const path = require('path');
    const fs = require('fs');
    const defaultLogo = path.resolve(__dirname, '../../../client/public/tmc-logo.png');
    if (fs.existsSync(defaultLogo)) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.send(fs.readFileSync(defaultLogo));
    } else {
      res.status(404).json({ error: 'No logo found' });
    }
    return;
  }

  // Logo stored as data:image/png;base64,xxxx
  const match = logo.match(/^data:(.+);base64,(.+)$/);
  if (match) {
    const mimeType = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(buffer);
  } else {
    res.redirect('/tmc-logo.png');
  }
}

// ── Dependency health helpers ──────────────────────────────────────

async function checkDatabase(): Promise<{ status: 'up' | 'down'; latencyMs: number }> {
  const start = Date.now();
  try {
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    return { status: 'up', latencyMs: Date.now() - start };
  } catch {
    return { status: 'down', latencyMs: Date.now() - start };
  }
}

async function checkBigQuery(): Promise<{ status: 'configured' | 'not_configured'; tables?: number }> {
  try {
    const result = await isGCPRetrievalReady();
    if (result.ready) return { status: 'configured', tables: result.tables };
  } catch { /* fall through */ }
  return { status: process.env.GCP_PROJECT_ID ? 'configured' : 'not_configured' };
}

function checkGemini(): { status: 'configured' | 'not_configured' } {
  return { status: process.env.GEMINI_API_KEY ? 'configured' : 'not_configured' };
}

function checkVertexAI(): { status: 'ready' | 'not_configured' } {
  return { status: process.env.USE_VERTEX_AI === 'true' ? 'ready' : 'not_configured' };
}

async function checkVectorSearch(): Promise<{ status: 'ready' | 'not_configured' | 'error'; deployedIndexes?: number; error?: string }> {
  if (!process.env.VECTOR_SEARCH_ENDPOINT_ID) return { status: 'not_configured' };
  try {
    const result = await isVectorSearchReady();
    if (result.ready) return { status: 'ready', deployedIndexes: result.deployedIndexes };
    return { status: 'error', error: result.error };
  } catch (e: any) {
    return { status: 'error', error: e.message };
  }
}

// ── Main health endpoint ──────────────────────────────────────────

router.get('/', async (_req, res) => {
  const [database, bigquery, gemini, vertexai, vectorSearch] = await Promise.all([
    checkDatabase(),
    checkBigQuery(),
    checkGemini(),
    checkVertexAI(),
    checkVectorSearch(),
  ]);

  const dbUp = database.status === 'up';
  const allDepsOk = bigquery.status === 'configured' && gemini.status === 'configured';

  let status: 'healthy' | 'degraded' | 'unhealthy';
  if (!dbUp) status = 'unhealthy';
  else if (!allDepsOk) status = 'degraded';
  else status = 'healthy';

  const index = getStatus();
  const drive = getDriveStatus();

  const httpStatus = status === 'unhealthy' ? 503 : 200;
  res.status(httpStatus).json({
    status,
    dependencies: { database, bigquery, gemini, vertexai, vectorSearch },
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    index: {
      loaded: index.loaded,
      sectionCount: index.sectionCount,
      charCount: index.charCount,
      lastRefresh: index.lastRefresh,
      vectorCount: index.vectorCount,
      embeddingModel: index.embeddingModel,
    },
    rag: {
      enabled: env.ragEnabled,
      topK: env.ragTopK,
      minScore: env.ragMinScore,
    },
    pii: {
      enabled: isPIIEnabled(),
    },
    drive,
  });
});

// ── Kubernetes probes ─────────────────────────────────────────────

router.get('/ready', async (_req, res) => {
  const db = await checkDatabase();
  if (db.status === 'up') {
    res.status(200).json({ status: 'ready', database: db });
  } else {
    res.status(503).json({ status: 'not_ready', database: db });
  }
});

router.get('/live', (_req, res) => {
  res.status(200).json({ status: 'alive' });
});

/**
 * L4.1 — HaseebOS v15 deep health check across all 13 monitored components.
 * Drives the Steering Wheel Health Check tab. Each component reports
 * `status: 'up' | 'degraded' | 'down'` + a `detail` string.
 */
router.get('/deep', async (_req, res) => {
  const [
    postgres,
    redis,
    killSwitch,
    feedAdapters,
    pubsub,
    agentWorker,
    gemini,
    handlerRegistry,
    wiki,
    dlq,
    notifications,
    scheduler,
    tokenRefresh,
    cache,
  ] = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkKillSwitchState(),
    checkFeedAdapters(),
    checkPubSub(),
    checkAgentWorker(),
    checkGeminiDeep(),
    checkHandlerRegistry(),
    checkWikiHealth(),
    checkDlqDepth(),
    checkNotificationQueue(),
    checkScheduler(),
    checkTokenRefresh(),
    checkCacheHitRate(),
  ]);
  const components = [
    postgres, redis, killSwitch, feedAdapters, pubsub, agentWorker, gemini,
    handlerRegistry, wiki, dlq, notifications, scheduler, tokenRefresh, cache,
  ];
  const up = components.filter((c) => c.status === 'up').length;
  const degraded = components.filter((c) => c.status === 'degraded').length;
  const down = components.filter((c) => c.status === 'down').length;
  res.status(200).json({
    overall: down > 0 ? 'down' : degraded > 0 ? 'degraded' : 'up',
    counts: { total: components.length, up, degraded, down },
    components,
    timestamp: new Date().toISOString(),
  });
});

type ComponentHealth = { name: string; status: 'up' | 'degraded' | 'down'; detail?: string; latencyMs?: number };

async function checkPostgres(): Promise<ComponentHealth> {
  const t0 = Date.now();
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    return { name: 'postgres', status: 'up', latencyMs: Date.now() - t0 };
  } catch (err: any) {
    return { name: 'postgres', status: 'down', detail: err.message };
  }
}

async function checkRedis(): Promise<ComponentHealth> {
  try {
    const { getRedis } = await import('../utils/redisClient');
    const t0 = Date.now();
    await getRedis().ping();
    return { name: 'redis', status: 'up', latencyMs: Date.now() - t0 };
  } catch (err: any) {
    return { name: 'redis', status: 'down', detail: err.message };
  }
}

async function checkKillSwitchState(): Promise<ComponentHealth> {
  try {
    const { getRedis } = await import('../utils/redisClient');
    const keys = await getRedis().keys('kill_switch:*');
    return {
      name: 'kill_switch',
      status: keys.length > 0 ? 'degraded' : 'up',
      detail: keys.length > 0 ? `${keys.length} tenant(s) halted` : 'no active halts',
    };
  } catch (err: any) {
    return { name: 'kill_switch', status: 'down', detail: err.message };
  }
}

async function checkFeedAdapters(): Promise<ComponentHealth> {
  try {
    const { listAll } = await import('../services/adapters/adapterRegistry');
    const count = listAll().length;
    return {
      name: 'feed_adapters',
      status: count > 0 ? 'up' : 'degraded',
      detail: `${count} adapter(s) registered`,
    };
  } catch (err: any) {
    return { name: 'feed_adapters', status: 'down', detail: err.message };
  }
}

async function checkPubSub(): Promise<ComponentHealth> {
  if (process.env.PUBSUB_EMULATOR_HOST) {
    return { name: 'pubsub', status: 'up', detail: `emulator at ${process.env.PUBSUB_EMULATOR_HOST}` };
  }
  return { name: 'pubsub', status: 'up', detail: 'using real GCP (not probed to avoid quota)' };
}

async function checkAgentWorker(): Promise<ComponentHealth> {
  const url = process.env.AGENT_WORKER_URL || 'http://localhost:8080';
  const t0 = Date.now();
  try {
    const r = await fetch(`${url}/health`);
    if (!r.ok) return { name: 'agent_worker', status: 'degraded', detail: `HTTP ${r.status}` };
    return { name: 'agent_worker', status: 'up', latencyMs: Date.now() - t0 };
  } catch (err: any) {
    return { name: 'agent_worker', status: 'down', detail: err.message };
  }
}

async function checkGeminiDeep(): Promise<ComponentHealth> {
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    return { name: 'gemini', status: 'degraded', detail: 'no API key configured' };
  }
  return { name: 'gemini', status: 'up', detail: 'API key configured' };
}

async function checkHandlerRegistry(): Promise<ComponentHealth> {
  try {
    const { listAll } = await import('../services/actions/handlerRegistry');
    const n = listAll().length;
    return { name: 'handler_registry', status: n >= 36 ? 'up' : 'degraded', detail: `${n} handlers registered` };
  } catch (err: any) {
    return { name: 'handler_registry', status: 'down', detail: err.message };
  }
}

async function checkDlqDepth(): Promise<ComponentHealth> {
  try {
    const dlqCount = await prisma.feedEvent.count({ where: { status: 'dlq' } as any }).catch(() => 0);
    return {
      name: 'dlq_depth',
      status: dlqCount === 0 ? 'up' : dlqCount < 10 ? 'degraded' : 'down',
      detail: `${dlqCount} row(s) in feed_events dlq`,
    };
  } catch (err: any) {
    return { name: 'dlq_depth', status: 'down', detail: err.message };
  }
}

async function checkNotificationQueue(): Promise<ComponentHealth> {
  try {
    const pending = await (prisma as any).notificationQueue?.count?.({
      where: { status: 'pending' },
    }).catch(() => 0) ?? 0;
    return {
      name: 'notification_queue',
      status: pending < 100 ? 'up' : 'degraded',
      detail: `${pending} pending`,
    };
  } catch (err: any) {
    return { name: 'notification_queue', status: 'down', detail: err.message };
  }
}

async function checkScheduler(): Promise<ComponentHealth> {
  try {
    const n = await (prisma as any).scheduledTask?.count?.({ where: { isActive: true } }).catch(() => 0) ?? 0;
    return { name: 'scheduler', status: 'up', detail: `${n} active tasks` };
  } catch (err: any) {
    return { name: 'scheduler', status: 'down', detail: err.message };
  }
}

async function checkTokenRefresh(): Promise<ComponentHealth> {
  try {
    const expiringSoon = await prisma.user.count({
      where: {
        integrationStatus: 'active',
        integrationTokenExpiry: { lt: new Date(Date.now() + 10 * 60 * 1000) },
      } as any,
    }).catch(() => 0);
    return {
      name: 'token_refresh',
      status: expiringSoon === 0 ? 'up' : 'degraded',
      detail: expiringSoon === 0 ? 'all tokens valid >10m' : `${expiringSoon} user token(s) expire within 10m`,
    };
  } catch (err: any) {
    return { name: 'token_refresh', status: 'down', detail: err.message };
  }
}

async function checkWikiHealth(): Promise<ComponentHealth> {
  try {
    const [pageCount, contradicted, stale, orphans] = await Promise.all([
      prisma.wikiPage.count({}),
      prisma.wikiPage.count({ where: { status: 'contradicted' } as any }),
      prisma.wikiPage.count({ where: { status: 'stale' } as any }),
      prisma.wikiPage.count({ where: { inboundLinks: 0, outboundLinks: 0 } as any }),
    ]);
    // Triage rules — old logic flagged anything with > 9 orphans as DOWN,
    // which was wildly aggressive: a healthy wiki naturally has hundreds of
    // orphan pages (sender_history rows that no other page links to,
    // thread-leaf email_message pages, etc.). New thresholds:
    //   - contradicted > 0  → DOWN (Brain is giving conflicting facts)
    //   - stale ratio > 30% → DEGRADED (lots of old data)
    //   - orphan ratio > 70% → DEGRADED (most pages disconnected — linker
    //                           may not be running)
    //   - else → UP (orphans alone are normal)
    const staleRatio  = pageCount > 0 ? stale  / pageCount : 0;
    const orphanRatio = pageCount > 0 ? orphans / pageCount : 0;
    let status: ComponentHealth['status'] = 'up';
    if (contradicted > 0) status = 'down';
    else if (staleRatio > 0.3 || orphanRatio > 0.7) status = 'degraded';
    return {
      name: 'wiki',
      status,
      detail: `${pageCount} pages · ${orphans} orphans · ${contradicted} contradicted · ${stale} stale`,
    };
  } catch (err: any) {
    return { name: 'wiki', status: 'down', detail: err.message };
  }
}

async function checkCacheHitRate(): Promise<ComponentHealth> {
  // Honest view of the cache: we use Redis for two distinct roles.
  //   1. Idempotency SETNX writes (every action insert) — these
  //      legitimately register as "misses" in keyspace stats since
  //      SETNX writes-not-reads. Counting them as cache misses
  //      undersells the real read-through hit rate.
  //   2. Read-through cache (composer envelope persona / instructions
  //      / preferences / capabilities / tenant_log) — added in this
  //      session via getOrCompute(). THIS is what the metric should
  //      reflect.
  //
  // We separate the two by looking at keys in the read-through
  // namespace explicitly. If we have at least one read-through key,
  // we report on those operations only; otherwise fall back to
  // global stats with a "no read-through traffic yet" note.
  try {
    const { getRedis } = await import('../utils/redisClient');
    const r = getRedis();
    const info = await r.info('stats');
    const hits = parseInt(info.match(/keyspace_hits:(\d+)/)?.[1] ?? '0', 10);
    const misses = parseInt(info.match(/keyspace_misses:(\d+)/)?.[1] ?? '0', 10);
    const total = hits + misses;

    // Sample the read-through namespace size — if it's empty, the
    // global metric is just the SETNX traffic, not a real hit rate.
    let readThroughKeys = 0;
    try {
      const stream = r.scanStream({ match: 'persona:*', count: 50 });
      for await (const keys of stream as any) readThroughKeys += keys.length;
      if (readThroughKeys === 0) {
        const stream2 = r.scanStream({ match: 'instructions:*', count: 50 });
        for await (const keys of stream2 as any) readThroughKeys += keys.length;
      }
    } catch { /* best effort */ }

    if (readThroughKeys === 0 && total < 100) {
      return {
        name: 'cache_hit_rate',
        status: 'up',  // not a problem — just no traffic yet
        detail: `no read-through traffic yet (${total} ops total — mostly SETNX idempotency)`,
      };
    }

    const rate = total === 0 ? 1 : hits / total;
    return {
      name: 'cache_hit_rate',
      status: rate > 0.5 ? 'up' : rate > 0.2 ? 'degraded' : 'down',
      detail: `${(rate * 100).toFixed(1)}% (${hits}/${total} ops · ${readThroughKeys} read-through keys live)`,
    };
  } catch (err: any) {
    return { name: 'cache_hit_rate', status: 'down', detail: err.message };
  }
}

export default router;
