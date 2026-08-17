/**
 * DEF-206 — the internal decline note can no longer reach the owner UNWRAPPED.
 *
 * DEF-205 preferred `answerText` and told the contract to require it on decline.
 * The decider ignored that. `B11-capability-limit` came back as:
 *
 *   "The user requested an action (initiating a WhatsApp call) that is not
 *    supported by the available tools or actions."
 *
 * — `decline_reason` verbatim, third person and technical. C6 90 -> 70,
 * C5 85 -> 70, C1 100 -> 85, C4 50. The judge: *"could be clearer by stating
 * 'I can't'"*, *"a bit clunky and technical"*, *"offers no alternative"*.
 *
 * Asking the model to fill a field is not a guarantee. This is: the reason still
 * travels, but as a MARKER PAYLOAD, so the ONE existing owner-facing renderer
 * decides how he hears it.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { declineMarker } from '../src/services/knowledge/reasoningCompose.applyDispatch';
import { sanitizeAnswerForUser } from '../src/services/knowledge/answerSanitizer';

const REAL_B11_REASON =
  'The user requested an action (initiating a WhatsApp call) that is not supported by the available tools or actions.';

describe('DEF-206 — a decline reason becomes a marker, never bare prose', () => {
  it('wraps the reason so it can never be delivered as-is', () => {
    // Mutation: returning the bare reason restores the B11 defect exactly.
    expect(declineMarker(REAL_B11_REASON)).toBe(`[declined: ${REAL_B11_REASON}]`);
    expect(declineMarker(REAL_B11_REASON).startsWith('[declined:')).toBe(true);
  });

  it('falls back to the no-reason marker rather than an empty reply', () => {
    for (const empty of [null, undefined, '', '   ']) {
      expect(declineMarker(empty)).toBe('[declined: no reason captured from decider]');
    }
  });

  it('strips brackets, which would terminate the curated rule early and leak the tail', () => {
    // The curated regex payload is [^\]]+ — an inner `]` ends the marker and the
    // remainder escapes as bare prose, which is the very thing being prevented.
    const out = declineMarker('cannot call [WhatsApp] voice] yet');
    expect(out).toBe('[declined: cannot call WhatsApp voice yet]');
    expect((out.match(/\]/g) ?? []).length).toBe(1);
  });

  it('collapses newlines, because a whole-marker shape test decides if it renders at all', () => {
    expect(declineMarker('no capability\nfor calls')).toBe('[declined: no capability for calls]');
  });

  it('caps the payload so a runaway reason cannot become the whole reply', () => {
    expect(declineMarker('x'.repeat(500)).length).toBeLessThanOrEqual('[declined: ]'.length + 300);
  });
});

describe('DEF-206 — the dispatch site itself must use the wrapper', () => {
  // Caught by mutation testing: every assertion above exercises `declineMarker`
  // directly, so re-introducing `result.declineReason ||` at the call site would
  // restore the B11 defect with the whole suite green. The guard has to pin the
  // EXPRESSION, not just the helper.
  const code = fs.readFileSync(
    path.resolve(__dirname, '..', 'src/services/knowledge/reasoningCompose.applyDispatch.ts'), 'utf8',
  ).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('the decline answer is answerText or the MARKER — never the raw reason', () => {
    expect(code).toMatch(/answer:\s*result\.answerText\?\.trim\(\) \|\| declineMarker\(result\.declineReason\)/);
  });

  it('no path hands result.declineReason straight to the owner', () => {
    // Mutation: `result.answerText?.trim() || result.declineReason || …` dies here.
    expect(code).not.toMatch(/answer:[^;]*\|\|\s*result\.declineReason\s*\|\|/);
    expect(code).not.toMatch(/answer:\s*result\.declineReason/);
  });
});

describe('DEF-206 — what the OWNER actually receives, through the real sanitizer', () => {
  it('renders the B11 decline as "I can\'t do that: …" — the judge\'s exact ask', () => {
    // Not a copy of the rule: this calls the real `sanitizeAnswerForUser`, which
    // is what `brainAskRoutes.ts:356` uses on the owner-facing path.
    const rendered = sanitizeAnswerForUser(declineMarker(REAL_B11_REASON));
    expect(rendered.startsWith("I can't do that:")).toBe(true);
    // The reason survives — nothing is lost by wrapping it.
    expect(rendered).toContain('not supported by the available tools');
    // And the raw note is no longer the whole reply.
    expect(rendered).not.toBe(REAL_B11_REASON);
  });

  it('renders the no-reason case as owner-facing prose, not a bare bracket', () => {
    const rendered = sanitizeAnswerForUser(declineMarker(null));
    expect(rendered).not.toMatch(/^\[/);
    expect(rendered.length).toBeGreaterThan(0);
  });
});
