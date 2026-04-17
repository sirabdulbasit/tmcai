import { describe, it, expect } from 'vitest';
import type { ApprovedAction, ExecutionResult } from '../actionExecutionService';

describe('actionExecutionService', () => {
  it('T4-TYPES: ApprovedAction interface has required fields', () => {
    const action: ApprovedAction = {
      type: 'close',
      openItemId: 'item-1',
      userId: 1,
      clientNumber: 'C001',
    };
    expect(action.type).toBe('close');
    expect(action.userId).toBe(1); // number, not string
  });

  it('T4-RESULT: ExecutionResult has correct shape', () => {
    const result: ExecutionResult = {
      status: 'done',
      confirmedTargets: 3,
      openItemId: 'item-1',
    };
    expect(result.status).toBe('done');
    expect(result.confirmedTargets).toBe(3);
  });

  it('T4-PARTIAL: partial failure result includes failed target names', () => {
    const result: ExecutionResult = {
      status: 'partial_failure',
      failedTargets: ['entity_context', 'connector_reply'],
      openItemId: 'item-1',
    };
    expect(result.failedTargets).toContain('entity_context');
    expect(result.failedTargets).toHaveLength(2);
  });

  it('T4-SNOOZE: snooze action has correct result shape', () => {
    const result: ExecutionResult = {
      status: 'snoozed',
      openItemId: 'item-1',
    };
    expect(result.status).toBe('snoozed');
  });
});
