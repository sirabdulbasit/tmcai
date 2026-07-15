import { describe, it, expect } from 'vitest';
import { BEHAVIOR_SPECS, resolveBehaviorValue } from '../src/services/behaviorConfig';

// Hardening audit 2026-07-14, item #3 — behavioral thresholds resolve
// user → tenant → env → documented code default, validated and clamped
// at every level. Category-A safety invariants are NOT in this catalog
// (allowlists, hard caps stay in code).

const spec = BEHAVIOR_SPECS['preactive.meeting_prep_window_min'];

describe('resolveBehaviorValue — precedence', () => {
  it('user override wins over tenant and env', () => {
    const r = resolveBehaviorValue(spec, [
      { source: 'user', value: 45 },
      { source: 'tenant', value: 120 },
      { source: 'env', value: 60 },
    ]);
    expect(r).toEqual({ value: 45, source: 'user' });
  });

  it('tenant applies when user override is absent', () => {
    const r = resolveBehaviorValue(spec, [
      { source: 'user', value: undefined },
      { source: 'tenant', value: '120' }, // string from system_config is fine
      { source: 'env', value: 60 },
    ]);
    expect(r).toEqual({ value: 120, source: 'tenant' });
  });

  it('falls to the documented default when nothing is set', () => {
    const r = resolveBehaviorValue(spec, [
      { source: 'user', value: null },
      { source: 'tenant', value: '' },
      { source: 'env', value: undefined },
    ]);
    expect(r).toEqual({ value: 90, source: 'default' });
  });
});

describe('resolveBehaviorValue — validation and clamping', () => {
  it('a non-numeric value is SKIPPED, not zeroed — next level applies', () => {
    const r = resolveBehaviorValue(spec, [
      { source: 'user', value: 'ninety' },
      { source: 'tenant', value: 30 },
    ]);
    expect(r).toEqual({ value: 30, source: 'tenant' });
  });

  it('out-of-range values clamp to [min,max] — safety caps survive config', () => {
    expect(resolveBehaviorValue(spec, [{ source: 'user', value: 100000 }]).value).toBe(spec.max);
    expect(resolveBehaviorValue(spec, [{ source: 'user', value: 0 }]).value).toBe(spec.min);
  });

  it('the auto-confirm streak floor of 5 cannot be lowered by any override', () => {
    const s = BEHAVIOR_SPECS['auto_confirm.streak_threshold'];
    expect(resolveBehaviorValue(s, [{ source: 'user', value: 1 }]).value).toBe(5);
    expect(resolveBehaviorValue(s, [{ source: 'tenant', value: -10 }]).value).toBe(5);
  });
});

describe('catalog hygiene', () => {
  it('every spec has coherent bounds and a default inside them', () => {
    for (const s of Object.values(BEHAVIOR_SPECS)) {
      expect(s.min).toBeLessThanOrEqual(s.max);
      expect(s.def).toBeGreaterThanOrEqual(s.min);
      expect(s.def).toBeLessThanOrEqual(s.max);
      expect(s.description.length).toBeGreaterThan(10);
      expect(['user', 'tenant']).toContain(s.scope);
    }
  });

  it('existing users keep current behavior: defaults match the old hardcoded constants', () => {
    expect(BEHAVIOR_SPECS['preactive.meeting_prep_window_min'].def).toBe(90);
    expect(BEHAVIOR_SPECS['preactive.due_soon_hours'].def).toBe(24);
    expect(BEHAVIOR_SPECS['pending_action.ttl_hours'].def).toBe(4);
    expect(BEHAVIOR_SPECS['auto_confirm.streak_threshold'].def).toBe(10);
    expect(BEHAVIOR_SPECS['contact_prune.max_merges_per_run'].def).toBe(25);
  });
});
