/**
 * DEF-055 — "yes" dispatched a stale preview to a third party.
 *
 * 2026-08-05 18:00. Brain asked: "I can record a note on her contact profile
 * with your instruction. Would you like me to do that?" The owner said "yes".
 * A WhatsApp went to Hamna Latif Bhutta — a different person, from a
 * preview_shown pending left over from the 17:17 flow — and the note he
 * actually asked for was never written.
 *
 * MY DEF-035 guard caused it. It asked two questions:
 *    is this a bare confirmation?      yes
 *    does a stored preview exist?      yes
 * and never the one that matters: IS THAT PREVIEW WHAT BRAIN JUST ASKED ABOUT?
 *
 * A human assistant who asks "shall I add a note?" and hears "yes" does not
 * send yesterday's email. The confirmation belongs to the last question asked.
 *
 * This is the fourth defect in the confirm family (DEF-024 constraint, DEF-032
 * displacement, DEF-035 ordering, this) and the second I introduced while
 * fixing the previous one. The class does not close by patching the reported
 * instance — DEF-038 removes the confirmation step for instructed actions
 * entirely, and that is the real fix.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const GUARD = CODE.slice(CODE.indexOf('const confirmChannel'), CODE.indexOf('resolveReasoningMode'));

describe('DEF-055/056 — the BRAIN decides what a short reply refers to', () => {
  it('the classifier decides, not a vocabulary list', () => {
    // The owner's rule: judgement is LLM-with-context, never a regex at the
    // decision boundary. "Does this 'yes' confirm THAT preview?" is judgement.
    expect(GUARD).toContain('resolveAmbiguousWithLlm');
    expect(GUARD).toMatch(/relation\.type === 'confirm_preview'/);
  });

  it('the hardcoded confirm vocabulary is gone from the decision path', () => {
    expect(
      GUARD,
      'yes|send|ok|haan as a decision boundary is what dispatched a stale '
      + 'preview to a third party on 2026-08-05 18:00',
    ).not.toMatch(/yep\|yeah|kar\\s\+do|theek\\s\+hai/);
    expect(GUARD).not.toContain('lastBrainWasThePreview');
  });

  it('Brain\'s last message is given to the classifier as context', () => {
    // This is the input that distinguishes "yes" answering a fresh question
    // from "yes" confirming an outstanding preview.
    expect(GUARD).toContain('lastBrainText');
    expect(GUARD).toMatch(/history[\s\S]{0,120}role === 'brain'/);
  });

  it('only a preview_shown pending is ever eligible', () => {
    expect(GUARD).toMatch(/outstandingPending\.status === 'preview_shown'/);
  });

  it('a declined classification is logged with the relation it chose', () => {
    expect(GUARD).toMatch(/early-confirm declined by the turn classifier/);
  });

  it('an unavailable classifier falls through — it never guesses', () => {
    // Falling through costs a re-plan. Guessing wrong sends a real message to
    // a real person. The asymmetry decides the default.
    expect(GUARD).toMatch(/catch[\s\S]{0,200}turn classifier unavailable/);
  });

  it('the dispatch still goes through the shared chokepoint (DEF-039)', () => {
    expect(GUARD).toContain('dispatchConfirmedPending(');
  });
});
