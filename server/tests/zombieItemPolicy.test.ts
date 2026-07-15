import { describe, expect, it } from 'vitest';
import {
  classifyZombieOpenItem,
  planZombieLifecycle,
  SELF_PRUNE_POLICY_VERSION,
} from '../src/services/openItems/zombieItemPolicy';

const base = {
  title: 'Exam solution of',
  status: 'DRAFT',
  priority: 'medium',
  notes: [],
  metadata: {},
};

describe('open-item self-pruning policy', () => {
  it('recognises an incomplete dangling title without hard-coded project names', () => {
    expect(classifyZombieOpenItem(base)).toBe('dangling_fragment');
    expect(classifyZombieOpenItem({ ...base, title: 'Review contract with' })).toBe('dangling_fragment');
  });

  it('recognises empty and placeholder residue', () => {
    expect(classifyZombieOpenItem({ ...base, title: '---' })).toBe('empty_title');
    expect(classifyZombieOpenItem({ ...base, title: 'Untitled' })).toBe('placeholder_title');
  });

  it('preserves complete conditional work', () => {
    expect(classifyZombieOpenItem({
      ...base,
      title: 'Send WhatsApp to Asad once number is received',
    })).toBeNull();
  });

  it('preserves critical, delegated, noted, due-dated, and active work', () => {
    expect(classifyZombieOpenItem({ ...base, priority: 'critical' })).toBeNull();
    expect(classifyZombieOpenItem({ ...base, delegateeName: 'Muhammad' })).toBeNull();
    expect(classifyZombieOpenItem({ ...base, notes: [{ text: 'user note' }] })).toBeNull();
    expect(classifyZombieOpenItem({ ...base, dueDate: new Date() })).toBeNull();
    expect(classifyZombieOpenItem({ ...base, status: 'IN_PROGRESS' })).toBeNull();
  });

  it('preserves an incomplete title when its description contains useful context', () => {
    expect(classifyZombieOpenItem({
      ...base,
      description: 'Prepare the complete examination solution for the finance team review.',
    })).toBeNull();
  });

  it('quarantines first and suppresses proactive messages', () => {
    const now = new Date('2026-07-15T00:00:00.000Z');
    const plan = planZombieLifecycle(base, now);
    expect(plan.action).toBe('quarantine');
    if (plan.action !== 'quarantine') throw new Error('unexpected plan');
    expect(plan.selfPrune).toMatchObject({
      version: SELF_PRUNE_POLICY_VERSION,
      state: 'quarantined',
      suppressProactive: true,
      detectedAt: now.toISOString(),
    });
  });

  it('holds during the grace period, then soft-archive is planned', () => {
    const detectedAt = '2026-07-01T00:00:00.000Z';
    const quarantined = {
      ...base,
      metadata: {
        selfPrune: {
          version: SELF_PRUNE_POLICY_VERSION,
          state: 'quarantined',
          reason: 'dangling_fragment',
          suppressProactive: true,
          detectedAt,
          lastEvaluatedAt: detectedAt,
        },
      },
    };
    expect(planZombieLifecycle(quarantined, new Date('2026-07-06T00:00:00.000Z')).action).toBe('hold');
    expect(planZombieLifecycle(quarantined, new Date('2026-07-08T00:00:00.000Z')).action).toBe('archive');
  });

  it('automatically recovers a quarantined item after correction', () => {
    const item = {
      ...base,
      title: 'Prepare the EXIM solution status report',
      metadata: {
        selfPrune: {
          version: SELF_PRUNE_POLICY_VERSION,
          state: 'quarantined',
          reason: 'dangling_fragment',
          suppressProactive: true,
          detectedAt: '2026-07-14T00:00:00.000Z',
          lastEvaluatedAt: '2026-07-14T00:00:00.000Z',
        },
      },
    };
    const plan = planZombieLifecycle(item, new Date('2026-07-15T00:00:00.000Z'));
    expect(plan.action).toBe('recover');
    if (plan.action !== 'recover') throw new Error('unexpected plan');
    expect(plan.selfPrune.suppressProactive).toBe(false);
    expect(plan.selfPrune.state).toBe('recovered');
  });
});
