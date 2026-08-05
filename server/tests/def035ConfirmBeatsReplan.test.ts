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
    // DEF-039: dispatch goes through the shared chokepoint, which carries the
    // idempotency wrapper and the artifact ledger transitions. Calling
    // dispatchPendingDirect raw here is what shipped the duplicate-send bug.
    expect(g).toContain('dispatchConfirmedPending(');
    expect(g).not.toContain('dispatchPendingDirect(');
    // Re-planning must not appear inside the guard.
    expect(g).not.toContain('reasoningCompose');
    expect(g).not.toContain('startPending');
  });

  it('only fires on a preview the owner actually SAW', () => {
    const g = CODE.slice(CODE.indexOf('const confirmChannel'), CODE.indexOf('resolveReasoningMode'));
    expect(g).toMatch(/outstandingPending\.status === 'preview_shown'/);
  });

  it('understands any phrasing, because a classifier reads it — not a word list', () => {
    // DEF-056 replaced the fixed vocabulary (yes|send|haan|kar do…) with
    // resolveAmbiguousWithLlm. A list could only ever cover the phrasings
    // someone thought of; worse, it decided MEANING, which is the owner's
    // no-hardcoded-judgement rule. Urdu, English or anything else is now the
    // classifier's problem, and it sees Brain's last message for context.
    const g = CODE.slice(CODE.indexOf('const confirmChannel'), CODE.indexOf('resolveReasoningMode'));
    expect(g).toContain('resolveAmbiguousWithLlm');
    expect(g).not.toContain('isBareConfirm');
  });

  it('marks the pending terminal so it cannot be confirmed twice', () => {
    // DEF-039 moved this into dispatchConfirmedPending so both confirm paths
    // share one implementation — assert it there, not in the guard.
    const chokepoint = CODE.slice(
      CODE.indexOf('async function dispatchConfirmedPending'),
      CODE.indexOf('async function dispatchConfirmedPending') + 3000);
    expect(chokepoint).toContain('markCompleted');
    expect(chokepoint).toContain('markFailed');
  });

  it('a guard failure falls through instead of breaking the turn', () => {
    const g = CODE.slice(CODE.indexOf('const confirmChannel'), CODE.indexOf('resolveReasoningMode'));
    expect(g).toMatch(/catch[\s\S]*falling through/);
  });
});

describe('what remains hardcoded is a prefilter, and can only cause a fall-through', () => {
  it('length bound gates the CLASSIFIER CALL, not the decision', () => {
    const g = CODE.slice(CODE.indexOf('const confirmChannel'), CODE.indexOf('resolveReasoningMode'));
    // Its only power is to skip asking the classifier, which falls through to
    // the normal reasoning path. It can never cause something to be sent.
    expect(g).toMatch(/q\.length <= 60/);
    expect(g).toMatch(/confirmsTheStoredPreview = relation\.type === 'confirm_preview'/);
  });
});
