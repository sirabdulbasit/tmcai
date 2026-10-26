/**
 * DEF-354 — the schedule dispatcher (spec §2.5). Pins:
 *
 *  - a slot is CLAIMED once: two ticks (or two replicas) at the same instant
 *    start one run, and a claimed slot is not retried when the start fails
 *    (vm retried every 60 s forever);
 *  - a slot before activated_at is never owed — even if the planner were to
 *    offer it, the claim's `activated_at <= $slot` guard refuses it (vm
 *    activation regression: turned on at 10:34, the 06:00 slot must not run);
 *  - a PAUSED integration is never dispatched, including one paused between the
 *    dispatcher's read and its claim;
 *  - the concurrency budget leaves a due slot unclaimed (owed next tick);
 *  - the only cross-tenant read is wrapped in runWithoutTenant, and each run
 *    starts in its own tenant scope.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeFakeDb } from './def354IntegrationFakeDb';

const h = vi.hoisted(() => ({
  db: null as any,
  startRun: vi.fn(),
  isDue: vi.fn(),
  maxConcurrent: 2,
  scopes: [] as Array<{ fn: string; scope: unknown }>,
}));

vi.mock('../src/utils/logger', () => ({
  __esModule: true,
  default: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));
vi.mock('../src/db/prisma', () => {
  const p = new Proxy({}, { get: (_t, k) => h.db.prisma[k] });
  return { __esModule: true, default: p, prisma: p };
});
vi.mock('../src/db/tenantContext', () => ({
  runWithoutTenant: async (fn: () => Promise<unknown>) => { h.scopes.push({ fn: 'without', scope: null }); return fn(); },
  runInTenantScope: async (scope: unknown, fn: () => Promise<unknown>) => { h.scopes.push({ fn: 'in', scope }); return fn(); },
}));
vi.mock('../src/services/behaviorConfig', () => ({ getBehaviorValue: async () => h.maxConcurrent }));
vi.mock('../src/services/userTimezoneService', () => ({
  isValidTimezone: () => true,
  resolveUserTimezone: async () => 'Asia/Karachi',
}));
vi.mock('../src/services/integrations/engine/planner', () => ({
  isDue: (...a: any[]) => h.isDue(...a),
  nextScheduledRun: () => new Date('2026-10-27T01:00:00Z'),
}));
vi.mock('../src/services/integrations/engine/runJobs', () => ({ startRun: (...a: any[]) => h.startRun(...a) }));

import { dispatchDueIntegrations } from '../src/services/integrations/schedule/dispatcher';
import { RunBusyError, SCHEDULER_ACTOR } from '../src/services/integrations/types';

const NOW = new Date('2026-10-26T06:00:30Z');
const SLOT = new Date('2026-10-26T06:00:00Z');

/** A faithful-enough isDue: the slot is owed when it is past, not before
 *  activation, and not already claimed. */
function honestIsDue(_s: unknown, now: Date, lastSlotAt: Date | null, activatedAt: Date | null): Date | null {
  if (now < SLOT) return null;
  if (!activatedAt || activatedAt > SLOT) return null;
  if (lastSlotAt && lastSlotAt >= SLOT) return null;
  return SLOT;
}

function seed(over: Record<string, unknown> = {}, cn = 'TMC-0001') {
  return h.db.insert('integrationSync', {
    clientNumber: cn, name: `I-${Math.random()}`, status: 'ACTIVE', frequency: 'daily', runTime: '06:00',
    timezone: 'UTC', activatedAt: new Date('2026-10-25T00:00:00Z'), approvedVersionId: 'v1', ...over,
  });
}

let runSeq = 0;
beforeEach(() => {
  h.db = makeFakeDb();
  h.maxConcurrent = 2;
  h.scopes.length = 0;
  h.isDue.mockReset().mockImplementation(honestIsDue);
  h.startRun.mockReset().mockImplementation(async (cn: string, id: string) => {
    h.db.insert('integrationRun', { clientNumber: cn, integrationId: id, status: 'RUNNING', trigger: 'scheduled' });
    return { runId: `run-${++runSeq}` };
  });
});

describe('DEF-354 dispatcher — slot claim', () => {
  it('claims the due slot once: a second tick at the same instant starts nothing', async () => {
    const row = seed();
    expect(await dispatchDueIntegrations(NOW)).toEqual({ claimed: 1, started: 1, skipped: 0 });
    expect(h.startRun).toHaveBeenCalledWith('TMC-0001', row.id, { dryRun: false, trigger: 'scheduled', triggeredBy: SCHEDULER_ACTOR });
    expect(row.lastSlotAt).toEqual(SLOT);
    expect(row.nextRunAt).toEqual(new Date('2026-10-27T01:00:00Z'));

    expect(await dispatchDueIntegrations(NOW)).toEqual({ claimed: 0, started: 0, skipped: 0 });
    expect(h.startRun).toHaveBeenCalledTimes(1);
  });

  it('two racing ticks (planner says due to both) still start one run', async () => {
    seed();
    h.isDue.mockImplementation(() => SLOT); // both ticks read before either claimed
    const [a, b] = await Promise.all([dispatchDueIntegrations(NOW), dispatchDueIntegrations(NOW)]);
    expect(a.claimed + b.claimed).toBe(1);
    expect(h.startRun).toHaveBeenCalledTimes(1);
  });

  it('a slot whose start failed is consumed, not retried next tick', async () => {
    seed();
    h.startRun.mockRejectedValueOnce(new Error('sheet exploded'));
    expect(await dispatchDueIntegrations(NOW)).toEqual({ claimed: 1, started: 0, skipped: 1 });
    expect(await dispatchDueIntegrations(new Date(NOW.getTime() + 60_000))).toEqual({ claimed: 0, started: 0, skipped: 0 });
  });

  it('a manual run in progress (RunBusyError) skips the slot', async () => {
    seed();
    h.startRun.mockRejectedValueOnce(new RunBusyError('x'));
    expect(await dispatchDueIntegrations(NOW)).toEqual({ claimed: 1, started: 0, skipped: 1 });
  });
});

describe('DEF-354 dispatcher — never a slot before activation', () => {
  it('turned on at 06:30, the 06:00 slot is not owed', async () => {
    const row = seed({ activatedAt: new Date('2026-10-26T06:30:00Z') });
    expect(await dispatchDueIntegrations(new Date('2026-10-26T06:31:00Z'))).toEqual({ claimed: 0, started: 0, skipped: 0 });
    expect(row.lastSlotAt).toBeNull();
    expect(h.startRun).not.toHaveBeenCalled();
  });

  it('even if the planner offered it, the claim guard refuses a pre-activation slot', async () => {
    const row = seed({ activatedAt: new Date('2026-10-26T06:30:00Z') });
    h.isDue.mockImplementation(() => SLOT); // a lax planner
    const r = await dispatchDueIntegrations(new Date('2026-10-26T06:31:00Z'));
    expect(r.claimed).toBe(0);
    expect(row.lastSlotAt).toBeNull();
    expect(h.startRun).not.toHaveBeenCalled();
    expect(h.db.raw.some((q: any) => q.sql.includes('activated_at <='))).toBe(true);
  });
});

describe('DEF-354 dispatcher — paused and draft rows', () => {
  it('a PAUSED integration is not dispatched', async () => {
    seed({ status: 'PAUSED' });
    seed({ status: 'DRAFT', activatedAt: null, approvedVersionId: null });
    expect(await dispatchDueIntegrations(NOW)).toEqual({ claimed: 0, started: 0, skipped: 0 });
    expect(h.isDue).not.toHaveBeenCalled();
    expect(h.startRun).not.toHaveBeenCalled();
  });

  it('paused between the read and the claim ⇒ the claim refuses it', async () => {
    const row = seed();
    h.isDue.mockImplementation(() => { row.status = 'PAUSED'; return SLOT; });
    const r = await dispatchDueIntegrations(NOW);
    expect(r).toEqual({ claimed: 0, started: 0, skipped: 1 });
    expect(h.startRun).not.toHaveBeenCalled();
  });
});

describe('DEF-354 dispatcher — budget and tenancy', () => {
  it('the concurrency budget leaves due slots unclaimed for the next tick', async () => {
    h.maxConcurrent = 1;
    const a = seed();
    const b = seed({}, 'TMC-0002');
    const r = await dispatchDueIntegrations(NOW);
    expect(r).toEqual({ claimed: 1, started: 1, skipped: 1 });
    const unclaimed = [a, b].find((x) => x.lastSlotAt == null);
    expect(unclaimed).toBeDefined();
  });

  it('cross-tenant read is explicit; each run starts in its own tenant scope', async () => {
    seed({}, 'TMC-0001');
    seed({}, 'TMC-0002');
    await dispatchDueIntegrations(NOW);
    expect(h.scopes[0].fn).toBe('without');
    const inScopes = h.scopes.filter((s) => s.fn === 'in').map((s: any) => s.scope.clientNumber).sort();
    expect(inScopes).toEqual(['TMC-0001', 'TMC-0002']);
    expect(h.startRun.mock.calls.map((c) => c[0]).sort()).toEqual(['TMC-0001', 'TMC-0002']);
    // Every claim names the row's own tenant.
    for (const q of h.db.raw) expect(q.sql).toMatch(/client_number = \?/);
  });
});
