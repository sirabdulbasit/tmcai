/**
 * DEF-035 — the "send → same preview → send → same preview" loop.
 *
 * ROOT CAUSE (ordering): the reasoning gate ran FIRST and returned early with a
 * preview whenever it decided to act. The pending/confirm reducer sat ~200 lines
 * further down and was therefore UNREACHABLE on a confirmation turn — "send"
 * was fed back into reasoning, which re-proposed the identical plan, called
 * startPending (displacing the plan just approved) and re-rendered the preview.
 * Owner hit it 08-04 20:25 ("send" x2) and 08-05 13:05 ("send" then "confirm").
 *
 * Fix: confirmation is evaluated BEFORE re-reasoning and dispatches the STORED
 * slots, so what executes is exactly what was displayed.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('confirmation beats re-planning', () => {
  it('the confirm guard runs BEFORE the reasoning gate — the ordering that caused the loop', () => {
    const guard = CODE.indexOf('early-confirm: dispatching the stored preview');
    const reasoningGate = CODE.indexOf('const reasoningMode = resolveReasoningMode');
    expect(guard).toBeGreaterThan(-1);
    expect(reasoningGate).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(reasoningGate);
  });

  it('dispatches the STORED pending, never a re-derivation', () => {
    const g = CODE.slice(CODE.indexOf('const confirmChannel'), CODE.indexOf('resolveReasoningMode'));
    expect(g).toContain('getActivePending');
    expect(g).toContain('dispatchPendingDirect(clientNumber, userId, outstanding as any)');
    // Re-planning must not appear inside the guard.
    expect(g).not.toContain('reasoningCompose');
    expect(g).not.toContain('startPending');
  });

  it('only fires on a preview the owner actually SAW', () => {
    const g = CODE.slice(CODE.indexOf('const confirmChannel'), CODE.indexOf('resolveReasoningMode'));
    expect(g).toContain("outstanding.status === 'preview_shown'");
  });

  it('accepts the words the owner actually used, including Urdu', () => {
    const m = CODE.match(/const isBareConfirm[\s\S]*?\.test\(q\)/)!;
    for (const w of ['send', 'confirm', 'yes', 'go\\s+ahead', 'do\\s+it', 'haan', 'kar\\s+do', 'theek\\s+hai']) {
      expect(m[0]).toContain(w);
    }
  });

  it('marks the pending terminal so it cannot be confirmed twice', () => {
    const g = CODE.slice(CODE.indexOf('const confirmChannel'), CODE.indexOf('resolveReasoningMode'));
    expect(g).toContain('markCompleted');
    expect(g).toContain('markFailed');
  });

  it('a guard failure falls through instead of breaking the turn', () => {
    const g = CODE.slice(CODE.indexOf('const confirmChannel'), CODE.indexOf('resolveReasoningMode'));
    expect(g).toMatch(/catch[\s\S]*falling through/);
  });
});

describe('the confirm vocabulary is a prefilter, not a judgement', () => {
  it('is length-bounded so a sentence containing "send" is not swallowed', () => {
    const m = CODE.match(/const isBareConfirm[\s\S]*?\.test\(q\)/)!;
    expect(m[0]).toContain('q.length <= 30');
    // Anchored — "send the email to Asad instead" must NOT match.
    expect(m[0]).toContain('/^(');
    expect(m[0]).toContain('$/i');
  });
});
