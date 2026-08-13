/**
 * DEF-135 — the fabricated-process guard destroyed the answer around the clause.
 *
 * Benchmark B12-reminder-referent, 2026-08-12 06:59. The user asked:
 *
 *   "Why did you remind me about that one twice?"
 *
 * Brain answered it, correctly and with ownership:
 *
 *   "I can see that, Sir. My apologies. It looks like a bug caused the same
 *    overdue reminder job to run twice. I've logged th[is with the ...]"
 *
 * The tail fabricated an escalation path, `fabricated_process` fired — rightly —
 * and the remedy replaced the ENTIRE answer with the curated meaning of the
 * marker: "I can't route to a team like that — Nexeo doesn't have that channel.
 * What concrete task should I do instead?" The user asked about a duplicate
 * reminder and was told about routing. The judge scored the turn C6=0, C3=0,
 * C7=10, C1=20, C2=20, C5=20, and named the mechanism without seeing the code:
 * "a pre-programmed error message triggered by a keyword that wasn't even
 * present". `answerLen` was 108 — the canned string's exact length, the same
 * tell that identified the four occurrences on 2026-08-10.
 *
 * That makes this occurrence 5 of `guard-destroys-the-answer` (chart §3). The
 * earlier four were each met by narrowing WHEN the guard fires (DEF-107,
 * DEF-113, DEF-114). Here the guard was right to fire, so eligibility was never
 * the lever — the remedy was. Excise the fabricated sentence, keep the answer.
 *
 * The guard must NOT be weakened, and these tests exist mainly to prove it
 * wasn't: the fabricated clause must be absent from every salvaged answer, and
 * an answer that is nothing BUT fabrication must still be replaced wholesale.
 *
 * Asserted through `validateBeforeRender` — the function the route calls — not
 * only through the helper. Codex's iteration-1 review made that point directly:
 * a unit test of the helper stays green while an earlier return bypasses it.
 */
import { describe, it, expect } from 'vitest';
import {
  validateBeforeRender,
  exciseSentencesMatching,
  FABRICATED_PROCESS_RE,
} from '../src/services/knowledge/responseValidator';
import { isSystemMarker } from '../src/services/knowledge/systemMarker';

const res = (answer: string, extra: Record<string, unknown> = {}) =>
  ({ answer, actionResult: null, ...extra } as any);

// DEF-169 — markers now carry an invisible origin stamp (`systemMarker`), so the
// bracket is no longer at index 0. The property being asserted is unchanged: the
// whole answer was replaced by THIS marker.
const MARKER = /^\s*\u2063?\[fabricated escalation path/;

/** The real B12 answer, with the tail the log truncated restored. */
const B12 =
  "I can see that, Sir. My apologies. It looks like a bug caused the same overdue reminder job to run twice. I've logged this with the engineering team to investigate.";

const fired = (r: ReturnType<typeof validateBeforeRender>) =>
  r.violations.some((v) => v.rule === 'fabricated_process' && v.severity === 'block');

describe('DEF-135 — the guard still fires, and still removes the fabrication', () => {
  it('blocks B12: detection is unchanged', () => {
    expect(fired(validateBeforeRender(res(B12)))).toBe(true);
    expect(validateBeforeRender(res(B12)).ok).toBe(false);
  });

  it('never lets the fabricated clause reach the user', () => {
    const { replacement } = validateBeforeRender(res(B12));
    expect(replacement).toBeDefined();
    expect(replacement!.toLowerCase()).not.toContain('engineering team');
  });

  it('still blocks the 2026-05-21 incident sentence', () => {
    const r = validateBeforeRender(res('I am escalating this to the support team for review.'));
    expect(fired(r)).toBe(true);
  });
});

describe('DEF-135 — what the user actually receives', () => {
  it('keeps the three true sentences that answer the question', () => {
    const { replacement } = validateBeforeRender(res(B12));
    expect(replacement).toBe(
      'I can see that, Sir. My apologies. It looks like a bug caused the same overdue reminder job to run twice.',
    );
  });

  it('no longer answers a reminder question with the routing marker', () => {
    const { replacement } = validateBeforeRender(res(B12));
    expect(replacement).not.toMatch(MARKER);
    expect(replacement).not.toContain('route to a team');
  });

  it('does not ship the 108-character canned string that marked all five occurrences', () => {
    const { replacement } = validateBeforeRender(res(B12));
    expect(replacement!.length).not.toBe(108);
  });
});

describe('DEF-135 — the marker survives where it is the right answer', () => {
  it('replaces wholesale when the answer is nothing but fabrication', () => {
    const { replacement } = validateBeforeRender(res("I'll escalate this to the support team."));
    expect(replacement).toMatch(MARKER);
  });

  it('replaces wholesale when too little survives to be an answer', () => {
    // "Two are open." is 13 chars once the fabricated sentence is gone — under
    // MIN_SALVAGE_CHARS (40), so the marker at least states what went wrong.
    // read_only isolates the threshold: it takes empty_promise out of play, so
    // this asserts the length rule rather than the two-block fallback below.
    const r = validateBeforeRender(
      res('Two are open. The engineering team has the third.'),
      { turnIntent: 'read_only' },
    );
    expect(r.violations.filter((v) => v.severity === 'block').map((v) => v.rule)).toEqual(['fabricated_process']);
    expect(r.replacement).toMatch(MARKER);
  });

  it('falls back to the marker when a SECOND block rule also fired', () => {
    // A salvage keeps prose, so it must not be offered while the remainder
    // still carries another blocking defect — here a raw provider error leak.
    const answer =
      "I've logged this with the engineering team. All LLM providers failed, so I could not finish reading your calendar today.";
    const r = validateBeforeRender(res(answer));
    const blocks = r.violations.filter((v) => v.severity === 'block').map((v) => v.rule);
    expect(blocks).toContain('fabricated_process');
    expect(blocks).toContain('provider_error_leak');
    // DEF-169: assert the ORIGIN rather than a leading bracket — the point of
    // this line is "the owner got a marker, not prose", and a stamp says so
    // where punctuation only suggested it.
    expect(isSystemMarker(r.replacement)).toBe(true);
  });

  it('leaves a clean answer completely alone', () => {
    const clean = 'Hamna replied at 15:24 about the ShireMe recruiting page. Nothing else is outstanding.';
    const r = validateBeforeRender(res(clean));
    expect(fired(r)).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.replacement).toBeUndefined();
  });
});

describe('DEF-135 — exciseSentencesMatching', () => {
  const RE = /\bengineering\s+team\b/i;

  it('keeps line structure so a bullet list survives losing one bullet', () => {
    const out = exciseSentencesMatching(
      'Two things are open:\n* The vision metric, still with Hamna.\n* I raised the other with the engineering team.',
      RE,
    );
    expect(out).toBe('Two things are open:\n* The vision metric, still with Hamna.');
  });

  it('returns undefined when nothing matched, so the caller keeps the original', () => {
    expect(exciseSentencesMatching('Nothing wrong with this sentence at all.', RE)).toBeUndefined();
  });

  it('leaves no blank gap where a fully-removed line used to be', () => {
    const out = exciseSentencesMatching(
      'The payroll sign-off is still open.\nI raised it with the engineering team.\nEverything else is clear.',
      RE,
    );
    expect(out).toBe('The payroll sign-off is still open.\nEverything else is clear.');
    expect(out).not.toMatch(/\n\s*\n/);
  });

  it('returns undefined rather than a salvage that still matches', () => {
    // Sentence-splitting cannot separate this: one unit, and it matches.
    expect(exciseSentencesMatching('the engineering team the engineering team', RE)).toBeUndefined();
  });

  it('catches a match that only appears once the kept lines are rejoined', () => {
    // The reason the fail-closed recheck exists, and the one case per-sentence
    // filtering provably cannot see: `\s` in the rule matches a NEWLINE, so
    // "engineering" ending one line and "team" opening the next matches the
    // rule while neither line matches it alone. One sentence IS removed here,
    // so the "nothing matched" and length exits are both already past.
    const answer = [
      "I'll escalate this to the support team.",
      'The rest of the delay sits with engineering',
      'team leads, who have not replied to me yet at all.',
    ].join('\n');

    const salvage = exciseSentencesMatching(answer, FABRICATED_PROCESS_RE);
    expect(salvage).toBeUndefined();

    // And through the real entry point: the marker wins, so the pattern the
    // guard exists to suppress never reaches the user by the back door.
    const r = validateBeforeRender(res(answer), { turnIntent: 'read_only' });
    expect(r.violations.filter((v) => v.severity === 'block').map((v) => v.rule)).toEqual(['fabricated_process']);
    expect(r.replacement).toMatch(MARKER);
  });

  it('refuses a global regex, whose lastIndex would skip sentences at random', () => {
    expect(exciseSentencesMatching(B12, /\bengineering\s+team\b/gi)).toBeUndefined();
  });

  it('handles an answer with no sentence terminator', () => {
    const out = exciseSentencesMatching(
      'The payroll run needs your sign-off before Friday or it slips a week',
      RE,
    );
    expect(out).toBeUndefined();
  });
});
