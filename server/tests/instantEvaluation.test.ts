import { describe, it, expect, vi, beforeEach } from 'vitest';
import { maybeTriggerInstantEvaluation, resetDebounce, DEBOUNCE_MS } from '../src/services/feed/instantEvaluation';

// D4 — proactivity was batch-on-cron: an inbound event sat until the next
// daily radar tick, undercutting the "brain reacts when something happens"
// feel. Ingestion now triggers a DEBOUNCED per-user radar run — the radar's
// own rules/LLM judge significance (never an ingest-side keyword filter),
// the debounce caps cost, and quiet hours/dedup are enforced downstream by
// the D3 outreach path (prompt queue).

describe('maybeTriggerInstantEvaluation', () => {
  beforeEach(() => resetDebounce());

  it('runs the radar on first ingest for a user', async () => {
    const run = vi.fn(async () => ({}));
    const r = await maybeTriggerInstantEvaluation('tmc', 2, { run });
    expect(run).toHaveBeenCalledWith('tmc', 2);
    expect(r.triggered).toBe(true);
  });

  it('debounces repeat ingests inside the window', async () => {
    const run = vi.fn(async () => ({}));
    await maybeTriggerInstantEvaluation('tmc', 2, { run });
    const r2 = await maybeTriggerInstantEvaluation('tmc', 2, { run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(r2.triggered).toBe(false);
  });

  it('debounce is per user — another user still triggers', async () => {
    const run = vi.fn(async () => ({}));
    await maybeTriggerInstantEvaluation('tmc', 2, { run });
    const r = await maybeTriggerInstantEvaluation('tmc', 3, { run });
    expect(r.triggered).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('triggers again after the window elapses', async () => {
    const run = vi.fn(async () => ({}));
    const t0 = Date.now();
    await maybeTriggerInstantEvaluation('tmc', 2, { run, now: t0 });
    const r = await maybeTriggerInstantEvaluation('tmc', 2, { run, now: t0 + DEBOUNCE_MS + 1 });
    expect(r.triggered).toBe(true);
  });

  it('never throws — radar failure is contained', async () => {
    const run = vi.fn(async () => { throw new Error('radar down'); });
    const r = await maybeTriggerInstantEvaluation('tmc', 2, { run });
    expect(r.triggered).toBe(false);
  });
});
