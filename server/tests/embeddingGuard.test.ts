import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hardening audit 2026-07-14, item #7 — stub embeddings are a
// dev/test convenience, never a silent production fallback.

const sysLogCalls: any[] = [];
vi.mock('../src/services/systemLogService', () => ({
  log: vi.fn(async (e: any) => { sysLogCalls.push(e); }),
}));

import {
  stubsAllowed,
  recordEmbeddingDegradation,
  recordEmbeddingRecovery,
  getEmbeddingHealth,
  resetEmbeddingGuard,
} from '../src/services/knowledge/embeddingGuard';

const origEnv = { NODE_ENV: process.env.NODE_ENV, ALLOW: process.env.EMBEDDINGS_ALLOW_STUB };

beforeEach(() => { resetEmbeddingGuard(); sysLogCalls.length = 0; });
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

    const health = getEmbeddingHealth();
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
    await recordEmbeddingDegradation('open_items', 'x');
    recordEmbeddingRecovery('open_items');
    expect(getEmbeddingHealth().find((h) => h.service === 'open_items')!.status).toBe('ok');
  });

  it('recovery without prior degradation is a no-op', () => {
    expect(() => recordEmbeddingRecovery('wiki')).not.toThrow();
  });
});
