/**
 * DEF-169 — a marker says it is one, instead of being guessed at from brackets.
 *
 * Three iterations of the same boundary, each fixing the previous by the same
 * wrong method — recognising an internal signal from its TEXT:
 *
 *   iter 21  markers matched by NAME (an enumerated list). Two new ones were not
 *            on the list, so `[unevidenced self-repair claim — …]` reached the
 *            owner verbatim. B12 C4 = 10.
 *   iter 22  I replaced the list with a SHAPE test, `/^\[...\]$/`. It cannot tell
 *            an internal signal from a person writing `[see attached]`, so a
 *            legitimate whole-bracket reply became a fabricated failure message.
 *            Codex's iteration-22 HIGH #1 — and my build entry claimed
 *            `[see attached]` was asserted safe while the test omitted it.
 *   iter 23  provenance. `systemMarker()` stamps an invisible sentinel at the
 *            producer; the sanitizer reads that. A bracket is punctuation and
 *            never carried the information being asked of it.
 *
 * ── THE TWO SURFACES, BECAUSE ONLY ONE WAS EVER CHECKED ─────────────────────
 *
 * `sanitizeAnswerForUser` is the web/synchronous path. WhatsApp uses
 * `sanitizeAnswerInBrainVoice`, and iteration 22's catch-all never ran there at
 * all: an uncurated marker was handed to `renderMarkerInBrainVoice` as the LLM's
 * only fact, and iteration 21's marker was a policy instruction addressed to the
 * composer. The model rewrote an internal note into Brain's voice for the owner.
 * `markerVoice.lastResort` does the same without an LLM — it capitalises the
 * marker body and returns it — so BOTH the success and the failure path
 * published internal text. Codex's HIGH #2.
 *
 * Every case below therefore runs on BOTH surfaces. Checking one and claiming
 * "the whole live path" is the error this file exists to stop repeating.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  sanitizeAnswerForUser, sanitizeAnswerInBrainVoice,
} from '../src/services/knowledge/answerSanitizer';
import {
  systemMarker, isSystemMarker, NEUTRAL_MARKER_FALLBACK,
} from '../src/services/knowledge/systemMarker';
import { validateBeforeRender } from '../src/services/knowledge/responseValidator';

/** The iteration-21 marker, rebuilt through the constructor. */
const UNKNOWN_MARKER = systemMarker(
  'unevidenced claim about your own actions — nothing was flagged, fixed or scheduled; '
  + 'state what the record shows, say the cause is not recorded, and offer the next step as a question',
);

/** A marker with a curated plain-language meaning (`MARKERS` in the sanitizer). */
const CURATED_MARKER = '[no action dispatched — retry with the action and target named explicitly]';

describe('DEF-169 — legitimate bracketed content survives BOTH surfaces', () => {
  /**
   * Codex's HIGH #1, with his examples. Iteration 22's shape test turned every one
   * of these into "I don't have a good answer for that yet". The claim that "no
   * human reply is shaped like that" was simply false, and my own build entry
   * supplied the counterexample it did not test.
   */
  const legitimate = [
    '[see attached]',
    '[CONFIDENTIAL]',
    '[Approved by Basit]',
    '[Draft — not final]',
    '[1]',
    '[Fujairah pricing — awaiting Latif]',
  ];

  for (const text of legitimate) {
    it(`web keeps: "${text}"`, () => {
      expect(sanitizeAnswerForUser(text)).toBe(text);
    });

    it(`whatsapp keeps: "${text}"`, async () => {
      expect(await sanitizeAnswerInBrainVoice(text, {})).toBe(text);
    });
  }

  it('none of them is a system marker, which is the whole distinction', () => {
    for (const text of legitimate) expect(isSystemMarker(text), text).toBe(false);
    expect(isSystemMarker(UNKNOWN_MARKER)).toBe(true);
  });
});

describe('DEF-169 — an uncurated marker never reaches the owner or the model', () => {
  it('web: replaced with the neutral line', () => {
    const out = sanitizeAnswerForUser(UNKNOWN_MARKER);
    expect(out).toBe(NEUTRAL_MARKER_FALLBACK);
    expect(out).not.toContain('[');
  });

  it('whatsapp: replaced without consulting the language model', async () => {
    // The LLM is never called, so there is no success path and no failure path to
    // differ — which is stronger than making both paths safe. If this ever routes
    // through `markerVoice` again, the mock below records it.
    const spy = vi.fn();
    vi.doMock('../src/services/knowledge/markerVoice', () => ({
      __esModule: true,
      renderMarkerInBrainVoice: async (m: string) => { spy(m); return 'rewritten'; },
    }));
    const out = await sanitizeAnswerInBrainVoice(UNKNOWN_MARKER, {});
    expect(out).toBe(NEUTRAL_MARKER_FALLBACK);
    expect(spy, 'internal text was handed to the LLM as fact').not.toHaveBeenCalled();
    vi.doUnmock('../src/services/knowledge/markerVoice');
  });

  it('the internal instruction is not paraphrased on either surface', async () => {
    // What made iteration 21 read as Brain being broken: the marker's content is
    // an instruction TO THE COMPOSER, so any rendering of it addresses the owner
    // with someone else's homework.
    const leaks = /record shows|cause is not recorded|offer the next step|unevidenced/i;
    expect(sanitizeAnswerForUser(UNKNOWN_MARKER)).not.toMatch(leaks);
    expect(await sanitizeAnswerInBrainVoice(UNKNOWN_MARKER, {})).not.toMatch(leaks);
  });

  it('the neutral line promises nothing and asks for nothing', () => {
    // Codex's MEDIUM #3: the previous fallback said "let me look again. Could you
    // ask me once more?" — an unscheduled promise plus a demand that the owner
    // repeat himself, i.e. the empty-promise class inside the safety net.
    expect(NEUTRAL_MARKER_FALLBACK).not.toMatch(/i'?ll|i will|look again|try again|ask me|once more/i);
    expect(NEUTRAL_MARKER_FALLBACK.length, 'and it is still a sentence').toBeGreaterThan(20);
  });
});

describe('DEF-169 — curated markers keep their vetted wording', () => {
  it('web: the curated meaning wins over the neutral line', () => {
    const out = sanitizeAnswerForUser(CURATED_MARKER);
    expect(out).not.toContain('[');
    expect(out).toMatch(/hadn't actually done that yet/i);
    expect(out).not.toBe(NEUTRAL_MARKER_FALLBACK);
  });

  it('whatsapp: the curated meaning is what the voice renderer receives', async () => {
    // Only vetted plain language is safe to hand over. The renderer must never
    // see the raw marker again.
    const out = await sanitizeAnswerInBrainVoice(CURATED_MARKER, {});
    expect(out).not.toContain('[');
    expect(out).not.toMatch(/no action dispatched|retry with the action/i);
  });
});

describe('DEF-169 — the validator stamps what it emits', () => {
  it("a blocked reply's replacement carries provenance", () => {
    const v = validateBeforeRender(
      { answer: "I'll make sure the duplicate is cleared.", cites: [], gaps: [], actionResult: null } as any,
      { pendingStatus: null, turnIntent: 'read_only', question: 'Why did you remind me about that one twice?' },
    );
    // Salvage is impossible here — the whole answer is the promise — so the
    // marker is what the route would ship, and it must be recognisable.
    expect(v.replacement).toBeDefined();
    expect(isSystemMarker(v.replacement!), 'an unstamped marker is invisible to the sanitizer').toBe(true);
    // End to end: what the owner actually reads on each surface.
    expect(sanitizeAnswerForUser(v.replacement!)).toBe(NEUTRAL_MARKER_FALLBACK);
  });

  it('a salvaged reply is prose and carries no stamp', () => {
    const v = validateBeforeRender(
      {
        answer: 'You got two reminders, at 09:03 and 09:08. I have no record of why. '
          + "I'll make sure the duplicate is cleared.",
        cites: [], gaps: [], actionResult: null,
      } as any,
      { pendingStatus: null, turnIntent: 'read_only', question: 'Why did you remind me about that one twice?' },
    );
    expect(isSystemMarker(v.replacement!)).toBe(false);
    expect(v.replacement).toContain('09:03');
    expect(sanitizeAnswerForUser(v.replacement!)).toContain('09:03');
  });
});
