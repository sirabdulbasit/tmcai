/**
 * DEF-344 — the email-item-derivation sweep runs under the reliability runner.
 *
 * The 10-08 incident class (`comm-ingestion-stalled`): the sweep was scheduled
 * by a raw setTimeout/setInterval with the body called naked — no overlap
 * guard, no timeout, every error swallowed by `.catch(() => undefined)`, and
 * no DEF-335 wedge breaker, so a single hung tick could halt emails→items
 * FOREVER with nothing in any log but silence. DEF-335's breaker never fired
 * across eight deploys for exactly this reason: it protects protectedTick
 * jobs, and this job was not one (named as the next increment in DEF-335's
 * own row; delivered here).
 *
 * Under test:
 *  - the first tick and every interval tick route through protectedTick with
 *    the pinned job name and class (lease, job_runs receipt, timeout, wedge
 *    breaker, failure escalation all come with it);
 *  - no naked `runEmailItemDerivation().catch(...)` call survives in the
 *    scheduler, so the runner cannot be bypassed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const state = vi.hoisted(() => ({
  ticks: [] as Array<{ name: string; jobClass: string }>,
  logs: [] as Array<{ level: string; msg: string }>,
}));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => {
    const mk = (level: string) => (msg: string) => state.logs.push({ level, msg });
    return { info: mk('info'), warn: mk('warn'), error: mk('error'), debug: mk('debug') };
  },
}));
vi.mock('../src/jobs/jobRunner', () => ({
  // Capture the registration; never run the real sweep in a unit test.
  protectedTick: async (name: string, jobClass: string, _fn: () => Promise<unknown>) => {
    state.ticks.push({ name, jobClass });
    return 'ok';
  },
}));
vi.mock('../src/db/prisma', () => ({ __esModule: true, default: {}, prisma: {} }));

import { scheduleEmailItemDerivation } from '../src/jobs/emailItemDerivationJob';

describe('DEF-344 — derivation sweep is breaker-covered', () => {
  beforeEach(() => { state.ticks = []; state.logs = []; vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('first tick and every interval tick go through protectedTick with the pinned name and class', async () => {
    scheduleEmailItemDerivation();
    expect(state.ticks).toHaveLength(0); // nothing before the boot delay
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(state.ticks).toEqual([{ name: 'email_item_derivation', jobClass: 'important' }]);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(state.ticks).toHaveLength(2); // the interval re-arms through the same runner
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(state.ticks).toHaveLength(3);
  });

  it('no naked sweep call survives in the scheduler — the runner cannot be bypassed', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/jobs/emailItemDerivationJob.ts'), 'utf8');
    const schedule = src.slice(src.indexOf('export function scheduleEmailItemDerivation'));
    expect(schedule).toContain("protectedTick('email_item_derivation', 'important'");
    expect(schedule).not.toMatch(/runEmailItemDerivation\(\)\.catch/);
  });
});
