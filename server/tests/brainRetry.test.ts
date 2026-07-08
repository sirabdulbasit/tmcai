import { describe, it, expect } from 'vitest';
import { askBrainWithRetry } from '../src/services/whatsapp/brainRetry';

// A2/A0 — WhatsApp error handling must retry the ONE central brain, never
// fall back to a degraded parallel pipeline. On total failure the user gets
// a bracketed system marker (per the no-hardcoded-fake-Brain rule), not a
// dumber answer.

describe('askBrainWithRetry', () => {
  it('returns the answer on first success without retrying', async () => {
    let calls = 0;
    const r = await askBrainWithRetry(async () => {
      calls++;
      return { answer: 'hello' };
    }, { retryDelayMs: 0 });
    expect(r.answer).toBe('hello');
    expect(r.degraded).toBe(false);
    expect(calls).toBe(1);
  });

  it('retries once after a failure and returns the retried answer', async () => {
    let calls = 0;
    const r = await askBrainWithRetry(async () => {
      calls++;
      if (calls === 1) throw new Error('LLM timeout');
      return { answer: 'recovered' };
    }, { retryDelayMs: 0 });
    expect(r.answer).toBe('recovered');
    expect(r.degraded).toBe(false);
    expect(calls).toBe(2);
  });

  it('returns a bracketed system marker when both attempts fail — never a degraded reply', async () => {
    let calls = 0;
    const r = await askBrainWithRetry(async () => {
      calls++;
      throw new Error('rate limited');
    }, { retryDelayMs: 0 });
    expect(calls).toBe(2);
    expect(r.degraded).toBe(true);
    // Bracketed status marker, includes the error, points at recovery
    expect(r.answer).toMatch(/^\[Brain unavailable — rate limited\./);
    expect(r.answer).toMatch(/\]$/);
  });
});
