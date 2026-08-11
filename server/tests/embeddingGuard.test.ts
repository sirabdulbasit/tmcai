import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hardening audit 2026-07-14, item #7 — stub embeddings are a
// dev/test convenience, never a silent production fallback.

const sysLogCalls: any[] = [];
vi.mock('../src/services/systemLogService', () => ({
  log: vi.fn(async (e: any) => { sysLogCalls.push(e); }),
}));

// Durable state fake (#9): ops_health_state rows survive "restarts"
// (resetEmbeddingGuard wipes memory; this map is the database).
const healthRows = new Map<string, { status: string; detail: string | null; since: Date | null }>();
vi.mock('../src/db/prisma', () => ({
  default: {
    $queryRawUnsafe: vi.fn(async (sql: string) => {
      if (sql.includes('FROM ops_health_state')) {
        return [...healthRows.entries()].map(([component, r]) => ({ component, ...r }));
      }
      return [];
    }),
    $executeRawUnsafe: vi.fn(async (_sql: string, ...a: any[]) => {
      healthRows.set(a[0], { status: a[1], detail: a[2], since: a[3] });
      return 1;
    }),
  },
}));

import {
  stubsAllowed,
  recordEmbeddingDegradation,
  recordEmbeddingRecovery,
  getEmbeddingHealth,
  resetEmbeddingGuard,
} from '../src/services/knowledge/embeddingGuard';

const origEnv = { NODE_ENV: process.env.NODE_ENV, ALLOW: process.env.EMBEDDINGS_ALLOW_STUB };

beforeEach(() => { resetEmbeddingGuard(); sysLogCalls.length = 0; healthRows.clear(); });
afterEach(() => {
  process.env.NODE_ENV = origEnv.NODE_ENV;
  if (origEnv.ALLOW === undefined) delete process.env.EMBEDDINGS_ALLOW_STUB;
  else process.env.EMBEDDINGS_ALLOW_STUB = origEnv.ALLOW;
});

describe('stubsAllowed', () => {
  it('development/test may use stubs', () => {
    process.env.NODE_ENV = 'test';
    delete process.env.EMBEDDINGS_ALLOW_STUB;
    expect(stubsAllowed()).toBe(true);
  });

  it('production forbids stubs by default', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.EMBEDDINGS_ALLOW_STUB;
    expect(stubsAllowed()).toBe(false);
  });

  it('production may opt in EXPLICITLY only', () => {
    process.env.NODE_ENV = 'production';
    process.env.EMBEDDINGS_ALLOW_STUB = '1';
    expect(stubsAllowed()).toBe(true);
  });
});

describe('degradation tracking', () => {
  it('records a structured health event and shows degraded in health', async () => {
    await recordEmbeddingDegradation('chunks', 'HTTP 503');
    expect(sysLogCalls).toHaveLength(1);
    expect(sysLogCalls[0].category).toBe('embedding_degraded');
    expect(sysLogCalls[0].level).toBe('warning');

    const health = await getEmbeddingHealth();
    const chunks = health.find((h) => h.service === 'chunks')!;
    expect(chunks.status).toBe('degraded');
    expect(chunks.failures).toBe(1);
    expect(chunks.lastError).toContain('503');
    expect(health.find((h) => h.service === 'wiki')!.status).toBe('ok');
  });

  it('escalates to level=error after the persistence threshold', async () => {
    vi.useFakeTimers();
    try {
      await recordEmbeddingDegradation('wiki', 'down');
      expect(sysLogCalls[0].level).toBe('warning');
      vi.advanceTimersByTime(31 * 60_000); // past DEGRADED_ALERT_AFTER_MIN
      await recordEmbeddingDegradation('wiki', 'still down');
      expect(sysLogCalls[1].level).toBe('error');
      // …but only once per outage.
      await recordEmbeddingDegradation('wiki', 'still down');
      expect(sysLogCalls[2].level).toBe('warning');
    } finally { vi.useRealTimers(); }
  });

  it('recovery clears the degraded state', async () => {
    // MEM-005: sample service changed 'open_items' → 'chunks'. The open-item
    // embedding path was retired (its table was dropped on 2026-05-18), so it
    // is no longer in the default health set and nothing can ever report it.
    // The assertion itself is unchanged — this test is about the
    // degrade → recover transition, not about which services exist.
    await recordEmbeddingDegradation('chunks', 'x');
    recordEmbeddingRecovery('chunks');
    expect((await getEmbeddingHealth()).find((h) => h.service === 'chunks')!.status).toBe('ok');
  });

  it('recovery without prior degradation is a no-op', () => {
    expect(() => recordEmbeddingRecovery('wiki')).not.toThrow();
  });
});

describe('durable degradation state (#9) — survives restarts', () => {
  it('restart preserves degraded state from the persisted row', async () => {
    await recordEmbeddingDegradation('chunks', 'HTTP 503');
    resetEmbeddingGuard(); // simulate process restart (memory wiped)
    const health = await getEmbeddingHealth();
    expect(health.find((h) => h.service === 'chunks')!.status).toBe('degraded');
  });

  it('a REAL provider success resolves it durably', async () => {
    await recordEmbeddingDegradation('chunks', 'down');
    recordEmbeddingRecovery('chunks'); // called only from real-model paths
    await new Promise((r) => setTimeout(r, 0)); // let the async persist land
    resetEmbeddingGuard();
    const health = await getEmbeddingHealth();
    expect(health.find((h) => h.service === 'chunks')!.status).toBe('ok');
  });
});
