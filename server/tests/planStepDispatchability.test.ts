/**
 * 2026-08-04: the owner dictated three priority+deadline updates, confirmed
 * the preview with "yes", and got
 *   ✗ [Unknown pending action kind: updateopenitem]
 *   (stopped — 2 remaining steps not attempted)
 * update_open_item was in the action registry, so plan validation accepted
 * it and the preview rendered it — but dispatchPendingDirect had no case for
 * that kind. A working implementation existed inline in the composer the
 * whole time, unreachable from the confirmed path.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { DISPATCHABLE_PLAN_STEP_KINDS } from '../src/services/knowledge/brainComposer';
import { normalisePriority } from '../src/services/openItems/applyOpenItemUpdate';

const COMPOSER = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf8',
);

/** Comments must never influence a source guard — they mention the very
 *  strings we slice on, which has broken this style of test four times. */
const CODE = COMPOSER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The `case` labels inside dispatchPendingDirect — the real capability. */
function dispatcherCases(): Set<string> {
  const start = CODE.indexOf('async function dispatchPendingDirect');
  const end = CODE.indexOf('Unknown pending action kind', start);
  const body = CODE.slice(start, end > start ? end : undefined);
  return new Set([...body.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]));
}

describe('the declared set matches what can actually execute', () => {
  it('every dispatchable kind really has a case (no phantom capability)', () => {
    const cases = dispatcherCases();
    for (const kind of DISPATCHABLE_PLAN_STEP_KINDS) {
      expect(cases.has(kind), `${kind} is declared dispatchable but has no case`).toBe(true);
    }
  });
  it('every case except action_plan is declared (no unreachable dispatcher)', () => {
    for (const kind of dispatcherCases()) {
      if (kind === 'action_plan') continue;
      expect(DISPATCHABLE_PLAN_STEP_KINDS.has(kind), `${kind} dispatches but is not declared`).toBe(true);
    }
  });
  it('update_open_item — the kind that lost the work — is now dispatchable', () => {
    expect(DISPATCHABLE_PLAN_STEP_KINDS.has('update_open_item')).toBe(true);
    expect(dispatcherCases().has('update_open_item')).toBe(true);
  });
  it('nested plans stay undispatchable', () => {
    expect(DISPATCHABLE_PLAN_STEP_KINDS.has('action_plan')).toBe(false);
  });
});

describe('plans are rejected BEFORE the owner is asked to confirm', () => {
  it('validation checks dispatchability, not just registry presence', () => {
    expect(CODE).toContain('DISPATCHABLE_PLAN_STEP_KINDS.has(step.type)');
    expect(CODE).toContain('no dispatcher for this action in a confirmed plan');
    // The guard must sit in the validation loop, before the preview renders.
    const guard = CODE.indexOf('no dispatcher for this action');
    expect(guard).toBeLessThan(CODE.indexOf('renderPlanPreview'));
  });
});

describe('the shared update implementation', () => {
  it('normalises the priority words users actually say', () => {
    expect(normalisePriority('High')).toBe('high');
    expect(normalisePriority('normal')).toBe('medium'); // most common synonym
    expect(normalisePriority('CRITICAL')).toBe('critical');
  });
  it('ignores unrecognised words instead of guessing', () => {
    expect(normalisePriority('urgent-ish')).toBeNull();
    expect(normalisePriority('')).toBeNull();
    expect(normalisePriority(undefined)).toBeNull();
  });
  it('is shared — the confirmed path uses it, not a second copy', () => {
    expect(CODE).toContain("await import('../openItems/applyOpenItemUpdate')");
  });
  it('never lets the LLM compute dates', () => {
    const SVC = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'openItems', 'applyOpenItemUpdate.ts'), 'utf8',
    );
    expect(SVC).toContain('dueDateRaw');
    expect(SVC).toContain('resolveDate');
  });
});
