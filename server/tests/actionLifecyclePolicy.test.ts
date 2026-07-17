import { describe, expect, it } from 'vitest';
import { planActionLifecycle, readActionLifecycle } from '../src/services/openItems/actionLifecycleService';

const NOW = new Date('2026-07-17T10:00:00.000Z');

function item(overrides: Record<string, unknown> = {}) {
  return {
    status: 'DELEGATED',
    dueDate: null,
    priority: 'medium',
    delegateeId: null,
    delegateeName: 'Muhammad Yousaf',
    delegateeEmail: 'yousaf@example.com',
    metadata: {},
    ...overrides,
  };
}

describe('living Action Center lifecycle policy', () => {
  it('keeps asking the concerned party daily when no deadline exists', () => {
    expect(planActionLifecycle(item(), NOW)).toMatchObject({
      action: 'ask_deadline', audience: 'concerned_party', reason: 'no_committed_deadline',
    });
  });

  it('asks the owner when an item has no separate concerned party', () => {
    expect(planActionLifecycle(item({ delegateeName: null, delegateeEmail: null }), NOW)).toMatchObject({
      action: 'ask_deadline', audience: 'owner',
    });
  });

  it('waits until a future commitment date', () => {
    const plan = planActionLifecycle(item({ dueDate: '2026-07-20T10:00:00.000Z' }), NOW);
    expect(plan.action).toBe('none');
    expect(plan.reason).toBe('monitoring_until_deadline');
  });

  it('asks for completion, delay reason, and new deadline when due', () => {
    expect(planActionLifecycle(item({ dueDate: '2026-07-17T09:59:00.000Z' }), NOW).action).toBe('ask_status');
  });

  it('requests evidence when a completion claim is not yet verified', () => {
    expect(planActionLifecycle(item({
      dueDate: '2026-07-16T10:00:00.000Z',
      metadata: { actionLifecycle: { phase: 'verification' } },
    }), NOW).action).toBe('ask_completion_evidence');
  });

  it('escalates after three unanswered attempts even if the next daily tick is later', () => {
    const plan = planActionLifecycle(item({
      metadata: { actionLifecycle: {
        unansweredAttempts: 3,
        nextFollowUpAt: '2026-07-18T10:00:00.000Z',
      } },
    }), NOW);
    expect(plan).toMatchObject({ action: 'escalate_user', audience: 'owner' });
  });

  it('escalates immediately when a blocker needs user authority', () => {
    const plan = planActionLifecycle(item({
      metadata: { actionLifecycle: {
        needsUserIntervention: true,
        interventionReason: 'Budget approval required',
        nextFollowUpAt: '2026-07-18T10:00:00.000Z',
      } },
    }), NOW);
    expect(plan).toMatchObject({ action: 'escalate_user', reason: 'Budget approval required' });
  });

  it('does not repeat the same escalation inside 24 hours', () => {
    const plan = planActionLifecycle(item({
      metadata: { actionLifecycle: {
        needsUserIntervention: true,
        escalatedAt: '2026-07-17T09:00:00.000Z',
        nextFollowUpAt: '2026-07-18T09:00:00.000Z',
      } },
    }), NOW);
    expect(plan.action).toBe('none');
  });

  it('never follows up terminal or self-pruned items', () => {
    expect(planActionLifecycle(item({ status: 'CLOSED' }), NOW).action).toBe('none');
    expect(planActionLifecycle(item({ metadata: { selfPrune: { suppressProactive: true } } }), NOW).action).toBe('none');
  });

  it('normalizes incomplete metadata into a durable versioned state', () => {
    expect(readActionLifecycle({ actionLifecycle: { phase: 'blocked', unansweredAttempts: 2 } })).toMatchObject({
      version: 1, phase: 'blocked', unansweredAttempts: 2,
      missedCommitments: 0, commitmentHistory: [], followUpHistory: [],
    });
  });
});
