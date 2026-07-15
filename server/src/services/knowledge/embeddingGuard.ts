/**
 * embeddingGuard — shared policy for embedding-provider fallback
 * (hardening audit 2026-07-14, item #7).
 *
 * All three embedding services (wiki pages, chunks, open items) had a
 * copy-pasted silent fallback: Gemini unavailable → deterministic
 * hash-based stub vectors written to the SAME columns as real ones.
 * Two services tag vectors with a model and filter at retrieval; the
 * chunks table has NO model column, so stub and real vectors could be
 * cosine-compared silently, returning garbage-ranked results with no
 * signal anywhere.
 *
 * Policy:
 *   - Stubs are allowed ONLY outside production (NODE_ENV) or when the
 *     operator explicitly opts in (EMBEDDINGS_ALLOW_STUB=1, e.g. an
 *     offline demo box).
 *   - In production, a provider failure means: no vector is written,
 *     retrieval degrades to non-vector paths, a structured degradation
 *     event is recorded (system_logs, deduped by recurrence), and the
 *     admin health endpoint shows the component as degraded. After
 *     DEGRADED_ALERT_AFTER_MIN of continuous degradation, the event
 *     escalates to level=error (alerting surface).
 *   - Recovery is stamped when a real embedding next succeeds; pages
 *     with NULL embeddings are picked up by the existing nightly
 *     backfill (cron:chunk_vector_backfill + wiki backfill), so
 *     re-embedding needs no new machinery and cannot duplicate rows
 *     (embedding writes are per-row UPDATEs keyed by id).
 */
import createLogger from '../../utils/logger';

const log = createLogger('embedding-guard');

const DEGRADED_ALERT_AFTER_MIN = 30;

export function stubsAllowed(): boolean {
  if (process.env.EMBEDDINGS_ALLOW_STUB === '1') return true;
  return process.env.NODE_ENV !== 'production';
}

interface DegradationState {
  degradedSince: Date;
  lastError: string;
  failures: number;
  escalated: boolean;
}

const state = new Map<string, DegradationState>();

// #9 rework: degradation state is DURABLE (ops_health_state, migration
// 20260714_ops_hardening). A restart must not flip a degraded provider
// back to healthy-looking — hydrate once per process before reads, and
// only a REAL provider success (recordEmbeddingRecovery is called
// exclusively from real-model success paths; the stub path returns
// before it) resolves the persisted row.
let hydrated = false;
async function hydrateFromDb(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const prisma = (await import('../../db/prisma')).default;
    const rows = await prisma.$queryRawUnsafe<any[]>(
      `SELECT component, status, detail, since FROM ops_health_state WHERE component LIKE 'embedding:%'`,
    );
    for (const r of rows) {
      if (r.status !== 'degraded') continue;
      const svc = String(r.component).slice('embedding:'.length);
      if (!state.has(svc)) {
        state.set(svc, {
          degradedSince: r.since ? new Date(r.since) : new Date(),
          lastError: r.detail ?? 'persisted degradation (pre-restart)',
          failures: 1, escalated: false,
        });
      }
    }
  } catch (e: any) {
    log.warn('embedding health hydrate failed — treating persisted state as unknown', { error: e?.message });
  }
}

async function persistState(service: string, status: 'healthy' | 'degraded', detail: string | null, since: Date | null): Promise<void> {
  try {
    const prisma = (await import('../../db/prisma')).default;
    await prisma.$executeRawUnsafe(
      `INSERT INTO ops_health_state (component, status, detail, since, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (component) DO UPDATE SET status = $2, detail = $3, since = $4, updated_at = NOW()`,
      `embedding:${service}`, status, detail, since,
    );
  } catch (e: any) {
    log.warn('embedding health persist failed (state remains in-memory)', { service, error: e?.message });
  }
}

/** Record a real-provider failure for a service ('wiki' | 'chunks' |
 *  'open_items'). Safe to call on every failure — logging is deduped. */
export async function recordEmbeddingDegradation(service: string, error: string): Promise<void> {
  await hydrateFromDb();
  const s = state.get(service) ?? { degradedSince: new Date(), lastError: error, failures: 0, escalated: false };
  s.failures += 1;
  s.lastError = error.slice(0, 300);
  state.set(service, s);
  await persistState(service, 'degraded', s.lastError, s.degradedSince);

  const degradedMin = (Date.now() - s.degradedSince.getTime()) / 60_000;
  const escalate = degradedMin >= DEGRADED_ALERT_AFTER_MIN && !s.escalated;
  if (escalate) s.escalated = true;

  try {
    const { log: sysLog } = await import('../systemLogService');
    await sysLog({
      level: escalate ? 'error' : 'warning',
      category: 'embedding_degraded',
      source: `embedding:${service}`,
      message: `real embedding provider unavailable for "${service}" (${s.failures} failures since ${s.degradedSince.toISOString()}): ${s.lastError}`,
    } as any);
  } catch { /* in-memory state still drives the health endpoint */ }

  if (s.failures === 1 || escalate) {
    log.warn('embedding provider degraded — vectors NOT being written', { service, failures: s.failures, escalated: s.escalated });
  }
}

/** Stamp recovery when a REAL embedding succeeds after degradation.
 *  (Stub successes never reach this — the stub path returns before the
 *  recovery call in all three services.) */
export function recordEmbeddingRecovery(service: string): void {
  const s = state.get(service);
  if (!s) return;
  state.delete(service);
  void persistState(service, 'healthy', null, null);
  log.info('embedding provider recovered — nightly backfill will re-embed NULL/unknown vectors', {
    service, downMinutes: Math.round((Date.now() - s.degradedSince.getTime()) / 60_000), failures: s.failures,
  });
}

export interface EmbeddingHealth {
  service: string;
  status: 'ok' | 'degraded';
  degradedSince?: string;
  failures?: number;
  lastError?: string;
  stubsAllowed: boolean;
}

/** Snapshot for /admin/system-health. Hydrates persisted state first —
 *  a restart shows 'degraded' from the durable row, never a false
 *  'healthy' from an empty in-memory map. */
export async function getEmbeddingHealth(services: string[] = ['wiki', 'chunks', 'open_items']): Promise<EmbeddingHealth[]> {
  await hydrateFromDb();
  return services.map((svc) => {
    const s = state.get(svc);
    return s
      ? { service: svc, status: 'degraded' as const, degradedSince: s.degradedSince.toISOString(), failures: s.failures, lastError: s.lastError, stubsAllowed: stubsAllowed() }
      : { service: svc, status: 'ok' as const, stubsAllowed: stubsAllowed() };
  });
}

/** Test hook. */
export function resetEmbeddingGuard(): void {
  state.clear();
  hydrated = false;
}
