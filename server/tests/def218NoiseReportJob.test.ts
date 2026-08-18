/**
 * DEF-218 — the increment-1 JOB, tested where it actually risks something.
 *
 * DEF-217 shipped C-3 increment 1 last turn with 12 tests — all of them on
 * `worstOffender` (the selection rule) and on the marker's constructor/parser.
 * **The job itself had none.** Nothing exercised tenant scoping, the master
 * switch, the once-per-day guarantee, or what happens when one user's read
 * throws.
 *
 * That is the wrong gap to leave open on this particular file, and the reason is
 * not general caution — it is this session's own record. Every review finding
 * Codex has raised against a background job here has been in exactly those four
 * places: tenant boundary (iteration-3 CRITICAL, iteration-4 CARRIED), gating
 * (DEF-191), idempotency (iteration-3 HIGH 2, iteration-4 HIGH 3), and failure
 * isolation. Shipping a NEW job whose selection logic is well covered and whose
 * orchestration is not is the finding waiting to happen.
 *
 * These are the four properties a deploy of this job depends on. If any of them
 * is wrong, the failure is either "the owner is spammed", "a tenant sees another
 * tenant's counts", or "the report silently never runs" — and the third is the
 * one that made increment 1 look done for five turns.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const userFindMany = vi.hoisted(() => vi.fn());
const summarise = vi.hoisted(() => vi.fn());
const enqueue = vi.hoisted(() => vi.fn());
const behaviorValue = vi.hoisted(() => vi.fn());

vi.mock('../src/db/prisma', () => ({ default: { user: { findMany: userFindMany } } }));
vi.mock('../src/services/selfpruning/inboundNoiseLedger', () => ({ summariseInboundNoise: summarise }));
vi.mock('../src/services/brainPrompts/brainPromptQueueService', () => ({ enqueueBrainPrompt: enqueue }));
vi.mock('../src/services/behaviorConfig', () => ({ getBehaviorValue: behaviorValue }));
vi.mock('../src/utils/logger', () => ({
  default: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  runInboundNoiseReportForTenant,
  runInboundNoiseReportForAllTenants,
} from '../src/jobs/inboundNoiseReportJob';

/** A summary loud enough to report: CL-033's shape. */
const loud = (over: Record<string, unknown> = {}) => ({
  windowHours: 36,
  unattributed: [{ senderKey: '+923001234567', reached: 10, acted: 0 }],
  subjects: [],
  ...over,
});

beforeEach(() => {
  userFindMany.mockReset();
  summarise.mockReset();
  enqueue.mockReset();
  behaviorValue.mockReset();
  behaviorValue.mockImplementation(async (key: string) =>
    (key === 'selfpruning.noise_report_enabled' ? 1 : 5));
  summarise.mockResolvedValue(loud());
  enqueue.mockResolvedValue({ status: 'queued', promptId: 'p1' });
  userFindMany.mockResolvedValue([{ id: 7 }]);
});

describe('DEF-218 — the tenant boundary', () => {
  it('every user read carries the tenant', async () => {
    await runInboundNoiseReportForTenant('tenant-1');
    for (const [args] of userFindMany.mock.calls) {
      expect(args.where?.clientNumber, JSON.stringify(args.where)).toBe('tenant-1');
    }
  });

  it('the ledger is read inside the tenant, for that user only', async () => {
    await runInboundNoiseReportForTenant('tenant-1');
    expect(summarise).toHaveBeenCalledWith(
      expect.objectContaining({ clientNumber: 'tenant-1', userId: 7 }),
    );
  });

  it('the message is enqueued to that tenant and user', async () => {
    await runInboundNoiseReportForTenant('tenant-1');
    expect(enqueue.mock.calls[0][0]).toMatchObject({ clientNumber: 'tenant-1', userId: 7 });
  });

  it('the ONLY cross-tenant read is the registry, and it reads distinct clientNumber', async () => {
    userFindMany.mockResolvedValueOnce([{ clientNumber: 'a' }, { clientNumber: 'b' }]);
    await runInboundNoiseReportForAllTenants();
    const registry = userFindMany.mock.calls[0][0];
    expect(registry.distinct).toEqual(['clientNumber']);
    expect(registry.select).toEqual({ clientNumber: true });
    expect(registry.where?.clientNumber, 'the registry read is the one without a tenant').toBeUndefined();
    // Everything AFTER it is scoped.
    for (const [args] of userFindMany.mock.calls.slice(1)) {
      expect(args.where?.clientNumber).toBeDefined();
    }
  });
});

describe('DEF-218 — the master switch', () => {
  it('reports nothing when the flag is 0, and does not even read the ledger', async () => {
    behaviorValue.mockImplementation(async (key: string) =>
      (key === 'selfpruning.noise_report_enabled' ? 0 : 5));
    const s = await runInboundNoiseReportForTenant('tenant-1');
    expect(enqueue).not.toHaveBeenCalled();
    expect(summarise, 'a disabled report should not cost a query either').not.toHaveBeenCalled();
    expect(s.reported).toBe(0);
  });

  it('the floor comes from the flag, not from a constant', async () => {
    behaviorValue.mockImplementation(async (key: string) =>
      (key === 'selfpruning.noise_report_enabled' ? 1 : 50));
    // Ten pushes is loud by default and quiet under a floor of fifty.
    const s = await runInboundNoiseReportForTenant('tenant-1');
    expect(enqueue).not.toHaveBeenCalled();
    expect(s.quiet).toBe(1);
  });

  it('an unreadable flag FAILS OPEN to reporting — the increment exists to be seen', async () => {
    behaviorValue.mockRejectedValue(new Error('config table down'));
    await runInboundNoiseReportForTenant('tenant-1');
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('DEF-218 — at most one message per user per day', () => {
  it('the dedup key carries the user and the date, so a second tick cannot re-send', async () => {
    await runInboundNoiseReportForTenant('tenant-1');
    const key = enqueue.mock.calls[0][0].dedupKey as string;
    expect(key).toMatch(/^selfpruning_noise:7:\d{4}-\d{2}-\d{2}$/);
  });

  it('a duplicate verdict from the QUEUE counts as quiet, never as reported', async () => {
    // The queue owns the guarantee; the job must not double-count its own message
    // when the dedup index refuses it.
    enqueue.mockResolvedValue({ status: 'duplicate', promptId: 'p1' });
    const s = await runInboundNoiseReportForTenant('tenant-1');
    expect(s.reported).toBe(0);
    expect(s.quiet).toBe(1);
  });

  it('is a routine, no-reply push — a count never holds the conversation lock', async () => {
    await runInboundNoiseReportForTenant('tenant-1');
    expect(enqueue.mock.calls[0][0]).toMatchObject({
      criticality: 'routine', expectsReply: false, provenance: 'system_marker',
    });
  });
});

describe('DEF-218 — one failure never eats the pass', () => {
  it('a user whose ledger read throws is counted and the next user still reports', async () => {
    userFindMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    summarise.mockRejectedValueOnce(new Error('ledger down')).mockResolvedValue(loud());
    const s = await runInboundNoiseReportForTenant('tenant-1');
    expect(s.errors).toBe(1);
    expect(s.reported, 'the second user still got their count').toBe(1);
  });

  it('a tenant that throws does not stop the tenants after it', async () => {
    userFindMany
      .mockResolvedValueOnce([{ clientNumber: 'a' }, { clientNumber: 'b' }])
      .mockRejectedValueOnce(new Error('user read down'))   // tenant a
      .mockResolvedValueOnce([{ id: 9 }]);                  // tenant b
    const s = await runInboundNoiseReportForAllTenants();
    expect(s.tenants).toBe(2);
    expect(s.errors).toBeGreaterThan(0);
    expect(s.reported, 'tenant b still reported').toBe(1);
  });

  it('a failed registry read reports nothing rather than throwing', async () => {
    userFindMany.mockRejectedValue(new Error('registry down'));
    const s = await runInboundNoiseReportForAllTenants();
    expect(s.errors).toBe(1);
    expect(s.tenants).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
