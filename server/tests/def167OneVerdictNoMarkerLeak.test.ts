/**
 * DEF-167 / DEF-168 — the guard put a machine instruction in front of the owner.
 *
 * Iteration 21's measured B12 answer, in full, as the owner would have read it:
 *
 *   "[unevidenced self-repair claim — nothing was flagged and no prevention was
 *    scheduled; say what is observable and that the cause is not known]"
 *
 * Judged C4 = 10, C1 = 20. Aggregate C4 86.7 → 80.7, overall 95.3 → 92.0. That is
 * strictly worse than the fabrication it replaced: a fabricated cause is at least
 * a sentence, and this is an internal note addressed to the composer, delivered as
 * if Brain were speaking.
 *
 * ── TWO DEFECTS, AND I OWN THE FIRST ONE ────────────────────────────────────
 *
 * **DEF-167.** Iteration 21 added a second block-severity rule for the same class
 * and my own build entry called the overlap "deliberate for now". The arbitration
 * in `validateBeforeRender` permits a salvage only when exactly one block exists —
 * correctly, per DEF-135: two DIFFERENT defects mean the surviving prose still
 * carries the second one. Both of my rules fired on B12, so salvage was suppressed
 * and the marker won. The arbitration was right; creating two rules for one class
 * was wrong. Fixed by merging them into one verdict, so this class can never again
 * hand the arbitrator a choice.
 *
 * **DEF-168.** `answerSanitizer`'s header promises: *"Unknown bracketed markers are
 * stripped to avoid leaking future ones."* That was false — both its whole-answer
 * loop and its embedded regex match an ENUMERATED list of prefixes, so a marker
 * nobody had added shipped verbatim. This is the very failure the file was created
 * to stop (Basit, 2026-07-07, two markers landing on WhatsApp raw). The last-mile
 * net had the same shape as the thing it was catching.
 *
 * ── WHY THESE TESTS ARE SHAPED THE WAY THEY ARE ─────────────────────────────
 *
 * Codex's iteration-21 review: *"Do not accept testing `violation.salvagedAnswer`
 * as proof — the assertion must cover `ValidationOutcome.replacement` and route
 * output."* He is right, and it is the specific reason my iteration-21 suite went
 * green on a build that was destroying the answer: every assertion read a
 * violation's private field, while the route consumes `validation.replacement`.
 * Nothing in 2,177 passing tests looked at the string the owner receives.
 *
 * So every assertion below reads either `ValidationOutcome.replacement` or the
 * output of `sanitizeAnswerForUser` — the two values that actually reach a surface.
 */
import { describe, it, expect } from 'vitest';
import { validateBeforeRender } from '../src/services/knowledge/responseValidator';
import { sanitizeAnswerForUser } from '../src/services/knowledge/answerSanitizer';
// DEF-169 — these cases construct markers through the producer, because a
// bracket alone is no longer (and never was) evidence of internal origin.
import { systemMarker } from '../src/services/knowledge/systemMarker';

const composed = (answer: string) => ({
  answer, cites: [], gaps: [], actionResult: null,
} as any);

const B12_Q = 'Why did you remind me about that one twice?';

/** The whole live path from composer output to the string a surface receives. */
const ownerWouldRead = (answer: string, question: string | null = B12_Q): string => {
  const v = validateBeforeRender(composed(answer), {
    pendingStatus: null, turnIntent: 'read_only', question,
  });
  return sanitizeAnswerForUser(v.replacement ?? answer);
};

const outcome = (answer: string, question: string | null = B12_Q) =>
  validateBeforeRender(composed(answer), {
    pendingStatus: null, turnIntent: 'read_only', question,
  });

/**
 * The iteration-21 shape: a cure phrase AND a commitment in one answer, which is
 * what made two rules fire at once.
 */
const BOTH_HALVES =
  'My apologies, Sir. You received two reminders for the Fujairah pricing item. '
  + 'I have flagged the error to prevent it from happening again. '
  + "I'll make sure the duplicate is cleared.";

describe('DEF-167 — one class produces one verdict', () => {
  it('the answer that fired both rules now produces exactly ONE block', () => {
    const blocks = outcome(BOTH_HALVES).violations.filter((v) => v.severity === 'block');
    expect(blocks.map((b) => b.rule)).toEqual(['unevidenced_self_conduct']);
  });

  it('and therefore the owner gets prose, not a marker', () => {
    // The assertion iteration 21 needed and did not have.
    const replacement = outcome(BOTH_HALVES).replacement;
    expect(replacement, 'no replacement at all').toBeDefined();
    expect(replacement, 'a bracketed internal note reached the reply')
      .not.toMatch(/^\s*\[/);
    expect(replacement).toContain('two reminders');
    expect(replacement, 'the cure must still be gone').not.toMatch(/flagged/i);
    expect(replacement, 'the promise must still be gone').not.toMatch(/make sure/i);
  });

  it('the observable fact survives all the way to the surface', () => {
    const read = ownerWouldRead(BOTH_HALVES);
    expect(read).toContain('two reminders');
    expect(read).not.toMatch(/^\s*\[/);
  });

  it('protection is unchanged — both halves are still removed', () => {
    // The point of the merge is collateral, not leniency. If either half survived,
    // this would be a regression dressed as a fix.
    const read = ownerWouldRead(BOTH_HALVES);
    expect(read).not.toMatch(/flagged|prevent|make sure/i);
  });

  it('a genuinely DIFFERENT second defect still suppresses salvage', () => {
    // DEF-135's arbitration must keep working. A raw JSON envelope alongside a
    // self-conduct claim is two real defects, and the remainder would still carry
    // the leak — so the marker is correct there, and the sanitizer makes it
    // human. This is the case the merge must NOT have broken.
    const withLeak = `{"answer":"x","cites":[]} ${BOTH_HALVES}`;
    const blocks = outcome(withLeak).violations.filter((v) => v.severity === 'block');
    expect(blocks.length, 'two distinct defects should both block').toBeGreaterThan(1);
    // And the owner still never sees a bracket.
    expect(ownerWouldRead(withLeak)).not.toMatch(/^\s*\[/);
  });
});

describe('DEF-168 — the sanitizer keeps its own promise', () => {
  it('strips a marker it has never heard of', () => {
    // The exact string the owner received in iteration 21, rebuilt through the
    // producer. DEF-169: this test used to pass a BARE bracketed string and expect
    // it stripped, which is the assertion that made iteration 22 destroy
    // `[see attached]`. Origin is the property; brackets never were.
    const leaked = systemMarker('unevidenced self-repair claim — nothing was flagged and no '
      + 'prevention was scheduled; say what is observable and that the cause is not known');
    const out = sanitizeAnswerForUser(leaked);
    expect(out, 'the enumerated list did not contain it, so it shipped').not.toContain('[');
    expect(out).not.toMatch(/unevidenced/);
    expect(out.length, 'and something human took its place').toBeGreaterThan(20);
  });

  it('strips the current marker too, so this cannot recur by renaming', () => {
    const current = systemMarker('unevidenced claim about your own actions — nothing was '
      + 'flagged, fixed or scheduled; state what the record shows, say the cause is not '
      + 'recorded, and offer the next step as a question');
    expect(sanitizeAnswerForUser(current)).not.toContain('[');
  });

  it('does not paraphrase the marker to the owner', () => {
    // The content is an instruction to the composer. Translating "say what is
    // observable" into prose is how the leak read as Brain being broken.
    const out = sanitizeAnswerForUser(
      systemMarker('unevidenced claim about your own actions — state what the record shows'));
    expect(out).not.toMatch(/record shows|observable|state what/i);
  });

  it('still rewrites the markers it does know, unchanged', () => {
    const known = '[no action dispatched — retry with the action and target named explicitly]';
    const out = sanitizeAnswerForUser(known);
    expect(out).not.toContain('[');
    expect(out, 'the curated human wording must win over the generic catch-all')
      .toMatch(/hadn't actually done that yet/i);
  });

  describe('the brackets it must leave alone', () => {
    // The catch-all requires the ENTIRE answer to be one bracketed expression, so
    // there is no legitimate text it can eat. These pin that.
    const legitimate = [
      'See [the doc](https://example.com/x) for details.',
      '[1]',
      'The item [Fujairah pricing] is overdue.',
      'You got two reminders at 09:03 and 09:08.',
      'Options: [a] chase her, [b] push the date.',
    ];
    for (const text of legitimate) {
      it(`leaves alone: "${text.slice(0, 40)}…"`, () => {
        expect(sanitizeAnswerForUser(text)).toBe(text);
      });
    }
  });
});
