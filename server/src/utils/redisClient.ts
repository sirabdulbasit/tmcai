import Redis from 'ioredis';
import { REDIS_CONFIG } from '../config/redis';

let client: Redis | null = null;

export function getRedis(): Redis {
  if (client) return client;
  client = new Redis(REDIS_CONFIG);
  client.on('error', (err) => {
    console.error('[Redis] connection error:', err.message);
  });
  client.on('connect', () => {
    console.log(`[Redis] connected to ${REDIS_CONFIG.host}:${REDIS_CONFIG.port}`);
  });
  return client;
}

export async function closeRedis(): Promise<void> {
  if (!client) return;
  await client.quit();
  client = null;
}

export async function ping(): Promise<boolean> {
  try {
    const r = getRedis();
    const reply = await r.ping();
    return reply === 'PONG';
  } catch {
    return false;
  }
}

export async function setNX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
  const r = getRedis();
  const result = await r.set(key, value, 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}

export async function get(key: string): Promise<string | null> {
  return getRedis().get(key);
}

export async function del(key: string): Promise<number> {
  return getRedis().del(key);
}

export async function exists(key: string): Promise<boolean> {
  const result = await getRedis().exists(key);
  return result === 1;
}

/**
 * Read-through cache. Returns the cached value if present; otherwise
 * computes it via `compute()`, stores under `key` with `ttlSeconds`,
 * and returns the fresh value. JSON-serialised internally.
 *
 * This is the primitive that was missing — the codebase used Redis
 * only for SETNX idempotency writes, so the keyspace_hits metric was
 * structurally near-zero. Use this on hot read paths (persona,
 * instructions list, calibration state, etc.) and the hit rate
 * becomes meaningful.
 *
 * Failures are graceful: if Redis is unreachable, we just call
 * `compute()` directly. Caller code never knows the cache misfired.
 */
export async function getOrCompute<T>(
  key: string,
  ttlSeconds: number,
  compute: () => Promise<T>,
): Promise<T> {
  try {
    const r = getRedis();
    const cached = await r.get(key);
    if (cached !== null) {
      try { return JSON.parse(cached) as T; } catch { /* fall through to recompute */ }
    }
    const fresh = await compute();
    try {
      await r.set(key, JSON.stringify(fresh), 'EX', Math.max(1, ttlSeconds));
    } catch { /* best effort — don't fail the read if write fails */ }
    return fresh;
  } catch {
    // Redis down — fall through to compute, never throw from cache.
    return compute();
  }
}

/** Invalidate a single cached key (or pattern with `*` glob). */
export async function invalidate(keyOrPattern: string): Promise<number> {
  try {
    const r = getRedis();
    if (!keyOrPattern.includes('*')) return r.del(keyOrPattern);
    // SCAN to support pattern deletes without blocking the server.
    const stream = r.scanStream({ match: keyOrPattern, count: 200 });
    let cleared = 0;
    for await (const keys of stream as any) {
      if (keys.length > 0) cleared += await r.del(...keys);
    }
    return cleared;
  } catch {
    return 0;
  }
}
