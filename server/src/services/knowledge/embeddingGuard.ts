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

/** Record a real-provider failure for a service ('wiki' | 'chunks' |
 *  'open_items'). Safe to call on every failure — logging is deduped. */
export async function recordEmbeddingDegradation(service: string, error: string): Promise<void> {
  const s = state.get(service) ?? { degradedSince: new Date(), lastError: error, failures: 0, escalated: false };
  s.failures += 1;
  s.lastError = error.slice(0, 300);
  state.set(service, s);

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

/** Stamp recovery when a real embedding succeeds after degradation. */
export function recordEmbeddingRecovery(service: string): void {
  const s = state.get(service);
  if (!s) return;
  state.delete(service);
  log.info('embedding provider recovered — nightly backfill will re-embed NULL vectors', {
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

/** Snapshot for /admin/system-health. */
export function getEmbeddingHealth(services: string[] = ['wiki', 'chunks', 'open_items']): EmbeddingHealth[] {
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
}
