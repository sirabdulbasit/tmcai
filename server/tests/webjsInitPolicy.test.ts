import { describe, expect, it } from 'vitest';
import {
  classifyWebjsInitFailure,
  getWebjsInitPolicy,
  initTimeoutRetryDelayMs,
  watchdogInitDeferral,
} from '../src/services/whatsapp/webjsInitPolicy';

describe('WhatsApp Web.js initialization policy', () => {
  it('classifies the production Runtime.callFunctionOn error as init_timeout', () => {
    expect(classifyWebjsInitFailure(
      new Error('Runtime.callFunctionOn timed out. Increase the protocolTimeout setting'),
    )).toBe('init_timeout');
  });

  it('does not misclassify ordinary auth/launch failures as timeouts', () => {
    expect(classifyWebjsInitFailure(new Error('Authentication failure'))).toBe('init_failed');
    expect(classifyWebjsInitFailure(new Error('Chrome executable missing'))).toBe('init_failed');
  });

  it('uses an explicit protocol timeout and a longer lifecycle deadline', () => {
    const policy = getWebjsInitPolicy({} as NodeJS.ProcessEnv);
    expect(policy.protocolTimeoutMs).toBe(240_000);
    expect(policy.initDeadlineMs).toBeGreaterThan(policy.protocolTimeoutMs);
    expect(policy.timeoutEscalationCount).toBe(3);
  });

  it('bounds environment overrides and keeps the deadline after protocol timeout', () => {
    const policy = getWebjsInitPolicy({
      WHATSAPP_WEBJS_PROTOCOL_TIMEOUT_MS: '99999999',
      WHATSAPP_WEBJS_INIT_DEADLINE_MS: '1',
      WHATSAPP_WEBJS_TIMEOUT_ESCALATION_COUNT: '99',
    } as NodeJS.ProcessEnv);
    expect(policy.protocolTimeoutMs).toBe(600_000);
    expect(policy.initDeadlineMs).toBe(630_000);
    expect(policy.timeoutEscalationCount).toBe(5);
  });

  it('applies bounded timeout retry backoff', () => {
    expect([1, 2, 3, 9].map(initTimeoutRetryDelayMs)).toEqual([
      30_000, 120_000, 300_000, 300_000,
    ]);
  });

  it('withholds watchdog re-init while connecting before the deadline', () => {
    expect(watchdogInitDeferral('connecting', { deadlineAt: 20_000 }, 10_000)).toBe('connecting');
    expect(watchdogInitDeferral('connecting', { deadlineAt: 20_000 }, 20_000)).toBeNull();
  });

  it('respects timeout backoff and stops when re-pair is required', () => {
    expect(watchdogInitDeferral('init_timeout', { retryAt: 20_000 }, 10_000)).toBe('backoff');
    expect(watchdogInitDeferral('init_timeout', { retryAt: 5_000 }, 10_000)).toBeNull();
    expect(watchdogInitDeferral('init_timeout', {
      retryAt: 5_000, requiresRepair: true,
    }, 10_000)).toBe('repair_required');
  });
});
