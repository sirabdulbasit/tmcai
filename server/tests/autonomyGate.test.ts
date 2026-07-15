import { describe, it, expect } from 'vitest';
import { resolveAutonomyGate } from '../src/services/actions/autonomyGate';

// D1 — automationLevel (observe_only|drafts_only|supervised|full_auto) was
// defined in schema but enforced NOWHERE. The gate is a deterministic
// decision table in the executor — never model discretion, never a prompt
// instruction. It applies to BRAIN-INITIATED actions only: a user-initiated
// chain (clicked approve, gave a voice instruction, configured a rule) is
// the user acting, not Brain autonomy (per the agreed autonomy definition).

describe('resolveAutonomyGate', () => {
  it('never gates user-initiated actions, at any level', () => {
    for (const level of ['observe_only', 'drafts_only', 'supervised', 'full_auto'] as const) {
      expect(resolveAutonomyGate('user', level)).toBe('execute');
    }
  });

  it('observe_only: brain actions are proposed only — never dispatched', () => {
    expect(resolveAutonomyGate('brain', 'observe_only')).toBe('proposed');
  });

  it('drafts_only: brain actions park as drafts', () => {
    expect(resolveAutonomyGate('brain', 'drafts_only')).toBe('draft');
  });

  it('supervised: brain actions queue for preview-confirm', () => {
    expect(resolveAutonomyGate('brain', 'supervised')).toBe('pending_approval');
  });

  it('full_auto: brain actions execute silently', () => {
    expect(resolveAutonomyGate('brain', 'full_auto')).toBe('execute');
  });

  it('unknown level fails closed to the most restrictive brain behavior', () => {
    expect(resolveAutonomyGate('brain', 'garbage' as any)).toBe('proposed');
  });
});
