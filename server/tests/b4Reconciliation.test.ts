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
  input: { to: ['x@y.com'], _idempotencyKey: 'idem_abc' },
  ...over,
});

beforeEach(() => vi.clearAllMocks());

describe('reconcileStuckExecuting', () => {
  it('marks done from a confirmed ok log entry — no re-send', async () => {
    findManyActions.mockResolvedValue([stuckRow()]);
    findUniqueLog.mockResolvedValue({ result: { ok: true, output: { messageId: 'm1' } } });
    const r = await reconcileStuckExecuting();
    expect(updateAction).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 7 },
      data: expect.objectContaining({ status: 'done' }),
    }));
    expect(r.recovered).toBe(1);
  });

  it('marks error from a failed log entry', async () => {
    findManyActions.mockResolvedValue([stuckRow()]);
    findUniqueLog.mockResolvedValue({ result: { ok: false, error: 'provider 500' } });
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
});
