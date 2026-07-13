import { describe, it, expect, vi, beforeEach } from 'vitest';

// B1 — the ADK Pub/Sub path returned status 'done' right after publishing,
// before the agent worker executed anything: a completion claim not backed
// by the system of record. Now: publish → AgentAction row 'dispatched',
// caller gets 'dispatched'; only the executor's confirmation may write
// 'done'/'error'. Rows that never confirm are reaped to 'stale' — never 'done'.

const agentActionCreate = vi.fn(async () => ({ id: 42 }));
const agentActionUpdate = vi.fn(async () => ({}));
const agentActionUpdateMany = vi.fn(async () => ({ count: 2 }));
const publishMock = vi.fn(async () => 'msg-1');

vi.mock('../src/db/prisma', () => ({
  default: {
    agentAction: {
      create: (...a: any[]) => agentActionCreate(...a),
      update: (...a: any[]) => agentActionUpdate(...a),
      updateMany: (...a: any[]) => agentActionUpdateMany(...a),
    },
  },
}));
vi.mock('../src/services/infra/pubsubPublisher', () => ({
  publish: (...a: any[]) => publishMock(...a),
}));
vi.mock('../src/services/featureFlagService', () => ({
  isFeatureEnabled: vi.fn(async () => true), // ADK agents enabled
}));
vi.mock('../src/config/featureFlags', () => ({
  V15_FLAGS: { ADK_AGENTS: 'adk_agents' },
}));
vi.mock('../src/config/pubsub', () => ({
  PUBSUB_TOPICS: { ACTIONS_APPROVED: 'tmcai-actions-approved' },
}));
vi.mock('../src/services/actions/handlerRegistry', () => ({
  has: vi.fn(() => true),
}));
vi.mock('../src/services/actions/executeViaRegistry', () => ({
  executeViaRegistry: vi.fn(),
}));

import { executeApprovedAction } from '../src/services/actionExecutionService';
import { reapStaleAgentActions } from '../src/jobs/agentActionReaper';

beforeEach(() => vi.clearAllMocks());

describe('B1 — ADK dispatch is never optimistically done', () => {
  it("returns 'dispatched' after publish, not 'done'", async () => {
    const r = await executeApprovedAction({
      type: 'close', openItemId: 'oi-1', userId: 2, clientNumber: 'tmc',
    });
    expect(publishMock).toHaveBeenCalled();
    expect(r.status).toBe('dispatched');
    expect(r.status).not.toBe('done');
  });

  it("marks the AgentAction row 'dispatched' after a successful publish", async () => {
    await executeApprovedAction({
      type: 'close', openItemId: 'oi-1', userId: 2, clientNumber: 'tmc',
    });
    expect(agentActionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 42 },
      data: expect.objectContaining({ status: 'dispatched' }),
    }));
  });
});

describe('B1 — reaper', () => {
  it("moves overdue 'dispatched' rows to 'stale' — never 'done'", async () => {
    const r = await reapStaleAgentActions();
    expect(agentActionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        status: 'dispatched',
        updatedAt: expect.objectContaining({ lt: expect.any(Date) }),
      }),
      data: expect.objectContaining({ status: 'stale' }),
    }));
    expect(r.reaped).toBe(2);
  });
});
