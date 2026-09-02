/**
 * Retention for the two tables that were growing without a bound, found by re-measuring the
 * 2026-08-31 size audits on 2026-09-02.
 *
 * Both audits named `llm_spend` as the database problem (561 MB, 69% of 811 MB). That was fixed
 * before these tests existed and the database is now 304 MB — so the audits' headline is stale,
 * and re-measuring surfaced two different things that neither audit flagged:
 *
 *  - the nightly `wiki_lint` notification stored its full findings object — every stale page of
 *    7,415 — as a 1.65 MB payload to deliver a 225-byte message, ~655 kB/day forever;
 *  - `gate_rule_firings` had 107,542 rows, 19 MB, no retention, and had never been vacuumed.
 *
 * The rule these tests exist to hold: **a retention window must be justified by what a reader
 * can actually ask for, never by taste.**
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const execRaw = vi.fn();
vi.mock('../src/db/prisma', () => ({
  default: { $executeRawUnsafe: (...a: any[]) => execRaw(...a) },
}));

import {
  sweepGateRuleFiringRetention, GATE_FIRING_RETENTION_DAYS,
} from '../src/services/triage/ruleEngineService';

beforeEach(() => { vi.clearAllMocks(); });

describe('gate_rule_firings retention', () => {
  it('keeps at least as long as the only reader can request', () => {
    // gateRulesRoutes /metrics: Math.min(parseInt(days ?? '30'), 90). If retention dropped below
    // that cap, the endpoint could ask for a window we had already deleted and silently
    // under-report — a wrong number is worse than a big table.
    expect(GATE_FIRING_RETENTION_DAYS).toBeGreaterThanOrEqual(90);
  });

  it('deletes by a cutoff computed from the retention window', async () => {
    execRaw.mockResolvedValue(120);
    const r = await sweepGateRuleFiringRetention(90);
    expect(r.deletedRows).toBe(120);
    const cutoffArg = execRaw.mock.calls[0][1] as Date;
    const ageDays = (Date.now() - cutoffArg.getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(89);
    expect(ageDays).toBeLessThan(91);
  });

  it('deletes in bounded batches, never one unbounded statement', async () => {
    // This table is written synchronously on the triage path; a long delete transaction there
    // would stall inbound message handling.
    execRaw.mockResolvedValue(10_000);
    await sweepGateRuleFiringRetention(90);
    expect(execRaw.mock.calls[0][0]).toContain('LIMIT');
    expect(execRaw.mock.calls.length).toBeGreaterThan(1);
  });

  it('stops as soon as a batch comes back short', async () => {
    execRaw.mockResolvedValueOnce(10_000).mockResolvedValueOnce(43);
    const r = await sweepGateRuleFiringRetention(90);
    expect(r.deletedRows).toBe(10_043);
    expect(execRaw.mock.calls.length).toBe(2);
  });

  it('cannot loop forever even if every batch comes back full', async () => {
    execRaw.mockResolvedValue(10_000);
    const r = await sweepGateRuleFiringRetention(90);
    expect(execRaw.mock.calls.length).toBeLessThanOrEqual(20);
    expect(r.deletedRows).toBe(200_000);
  });

  it('scopes the delete to the retention column, not to a tenant', async () => {
    // Deliberate: this is a global operational sweep, and filtering it per tenant would leave
    // every other tenant's backlog growing unattended.
    execRaw.mockResolvedValue(0);
    await sweepGateRuleFiringRetention(90);
    expect(execRaw.mock.calls[0][0]).toContain('fired_at <');
  });
});

describe('the wiki_lint notification payload', () => {
  it('stores counts and never the per-page arrays', () => {
    // The regression this guards is a size defect with no functional symptom: the notification
    // looked perfect and quietly added 655 kB/day. Asserted on the source because the producer
    // is an inline interval in server.ts.
    const { readFileSync } = require('node:fs') as typeof import('node:fs');
    const { join } = require('node:path') as typeof import('node:path');
    const src = readFileSync(join(__dirname, '..', 'src', 'server.ts'), 'utf-8');
    const at = src.indexOf("kind: 'wiki_lint'");
    expect(at).toBeGreaterThan(0);
    const payload = src.slice(at, src.indexOf('}).catch', at));
    // strip comments — the comment here necessarily discusses the banned shape (BLD-009)
    const code = payload.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(code).toContain('summary:');
    expect(code).toContain('pageCount');
    // the whole findings object must not be spread in
    expect(code).not.toMatch(/^\s*findings,\s*$/m);
  });
});
