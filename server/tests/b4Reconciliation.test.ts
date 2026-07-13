import { describe, it, expect, vi, beforeEach } from 'vitest';

// B4 — provider-confirmed-but-DB-write-fails gap. The confirmed outcome is
// durable in action_idempotency_log BEFORE the AgentAction status write
// (withIdempotency stores it), so a crash between provider ack and the row
// update leaves a row stuck 'executing' while the log holds the truth. The
// reaper's reconciliation pass resolves stuck rows FROM the log: confirmed
// ok → done (no re-send), confirmed fail → error, no log entry → stale.
// Never silently 'done' without log-backed truth.

const findManyActions = vi.fn();
const updateAction = vi.fn(async () => ({}));
const updateManyActions = vi.fn(async () => ({ count: 0 }));
const findUniqueLog = vi.fn();

vi.mock('../src/db/prisma', () => ({
  default: {
    agentAction: {
      findMany: (...a: any[]) => findManyActions(...a),
      update: (...a: any[]) => updateAction(...a),
      updateMany: (...a: any[]) => updateManyActions(...a),
    },
    actionIdempotencyLog: { findUnique: (...a: any[]) => findUniqueLog(...a) },
  },
}));

import { reconcileStuckExecuting } from '../src/jobs/agentActionReaper';

const stuckRow = (over: any = {}) => ({
  id: 7,
  clientNumber: 'tmc',
  userId: 2,
  input: { to: ['x@y.com'], _idempotencyKey: 'idem_abc' },
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('reconcileStuckExecuting', () => {
  it('marks done from a confirmed ok log entry — no re-send', async () => {
    findManyActions.mockResolvedValue([stuckRow()]);
    findUniqueLog.mockResolvedValue({ clientNumber: 'tmc', userId: 2, result: { ok: true, output: { messageId: 'm1' } } });
    const r = await reconcileStuckExecuting();
    expect(updateAction).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 7 },
      data: expect.objectContaining({ status: 'done' }),
    }));
    expect(r.recovered).toBe(1);
  });

  it('marks error from a failed log entry', async () => {
    findManyActions.mockResolvedValue([stuckRow()]);
    findUniqueLog.mockResolvedValue({ clientNumber: 'tmc', userId: 2, result: { ok: false, error: 'provider 500' } });
    await reconcileStuckExecuting();
    expect(updateAction).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'error' }),
    }));
  });

  it('marks stale when the log has no entry — outcome unknown, never done', async () => {
    findManyActions.mockResolvedValue([stuckRow()]);
    findUniqueLog.mockResolvedValue(null);
    await reconcileStuckExecuting();
    expect(updateAction).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'stale' }),
    }));
  });

  it('marks stale when the row carries no idempotency key (pre-B4 rows)', async () => {
    findManyActions.mockResolvedValue([stuckRow({ input: { to: ['x@y.com'] } })]);
    await reconcileStuckExecuting();
    expect(findUniqueLog).not.toHaveBeenCalled();
    expect(updateAction).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'stale' }),
    }));
  });

  // ─────────────────────────────────────────────────────────────────
  // Fix 1 (2026-07-09) — cross-tenant result spoofing.
  //
  // A crafted or stale _idempotencyKey in the row's input JSON can
  // point at ANOTHER tenant's action_idempotency_logs row. If the
  // reconciler trusts the log unconditionally, it copies the wrong
  // tenant's output onto this row and marks 'done' — a confidentiality
  // AND integrity breach. The row's clientNumber/userId are the source
  // of truth; the log entry MUST match on both.
  // ─────────────────────────────────────────────────────────────────

  it('SECURITY: log entry belonging to another tenant → stale, never done (spoof rejected)', async () => {
    findManyActions.mockResolvedValue([stuckRow({ clientNumber: 'tmc', userId: 2 })]);
    // Attacker (or stale key collision) points at another tenant's log row.
    findUniqueLog.mockResolvedValue({
      clientNumber: 'other-tenant',
      userId: 99,
      result: { ok: true, output: { messageId: 'other-tenant-secret' } },
    });
    const r = await reconcileStuckExecuting();
    expect(updateAction).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 7 },
      data: expect.objectContaining({ status: 'stale' }),
    }));
    // The other tenant's output MUST NOT have been copied.
    const call = (updateAction.mock.calls[0]?.[0] as any) ?? {};
    const dataOut = JSON.stringify(call?.data ?? {});
    expect(dataOut).not.toContain('other-tenant-secret');
    expect(r.recovered).toBe(0);
    expect(r.staled).toBe(1);
  });

  it('SECURITY: log entry with same tenant but different user → stale (fail closed, tenant-and-user match required)', async () => {
    findManyActions.mockResolvedValue([stuckRow({ clientNumber: 'tmc', userId: 2 })]);
    findUniqueLog.mockResolvedValue({
      clientNumber: 'tmc',
      userId: 3, // different user in same tenant
      result: { ok: true, output: { messageId: 'other-user-msg' } },
    });
    const r = await reconcileStuckExecuting();
    expect(updateAction).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'stale' }),
    }));
    expect(r.staled).toBe(1);
  });

  it('SECURITY: mismatch stale-reason names the tenant mismatch (operator triage + spoof audit signal)', async () => {
    findManyActions.mockResolvedValue([stuckRow({ clientNumber: 'tmc', userId: 2 })]);
    findUniqueLog.mockResolvedValue({
      clientNumber: 'other-tenant', userId: 99,
      result: { ok: true, output: {} },
    });
    await reconcileStuckExecuting();
    const call = (updateAction.mock.calls[0]?.[0] as any) ?? {};
    const errorText = String(call?.data?.error ?? '');
    expect(errorText).toMatch(/tenant/i);
    expect(errorText).toMatch(/mismatch|spoof/i);
  });
});
