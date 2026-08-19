/**
 * DEF-034 — a TURN-scoped marker may never be rendered in WORLD-scoped words.
 *
 * On 2026-08-05 Brain replied "nothing was executed on my end" one second after it had
 * successfully delegated three items. The marker behind that sentence is turn-scoped —
 * `[no action dispatched]` means "no action dispatched IN THIS TURN" — and the sentence
 * rendering it claimed something about the whole world. The root cause was found the same
 * day, the fix was written down, and nothing was built: it fired 21 more times in the 14
 * days to 2026-08-19, which is how it reached the top of the owner's own deck.
 *
 * These tests guard the CLASS, not the instance. A future rewording that reintroduces a
 * world-scoped claim on any turn-scoped marker fails here, whichever marker it is.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeAnswerForUser, curatedMarkerMeaning } from '../src/services/knowledge/answerSanitizer';

/** Phrases that assert something about the WORLD rather than about this turn. */
const WORLD_SCOPED = [
  /nothing was executed/i,
  /nothing has been (sent|done|executed|deleted|removed)/i,
  /no action was taken/i,
  /nothing happened/i,
];

/** Offers that invite re-running work whose status the system has just admitted it does
 *  not know. Duplicating an external side effect is not recoverable by apology. */
const BLIND_REDO_OFFERS = [
  /say the word and i'll do it now/i,
  /shall i do it now\?$/i,
];

/** The turn-scoped markers — each says something about THIS turn only. */
const TURN_SCOPED_MARKERS = [
  '[no action dispatched — the assistant claimed completion but no action ran]',
  '[no action dispatched — retry with the action and target named explicitly]',
  '[status read failed — answer withheld pending a grounded re-read]',
];

describe('DEF-034 — marker scope must match claim scope', () => {
  for (const marker of TURN_SCOPED_MARKERS) {
    it(`renders "${marker.slice(1, 28)}…" without any world-scoped claim`, () => {
      const out = sanitizeAnswerForUser(marker);
      expect(out).not.toBe('');
      for (const bad of WORLD_SCOPED) {
        expect(out, `world-scoped claim in: ${out}`).not.toMatch(bad);
      }
    });

    it(`renders "${marker.slice(1, 28)}…" without offering a blind redo`, () => {
      const out = sanitizeAnswerForUser(marker);
      for (const bad of BLIND_REDO_OFFERS) {
        expect(out, `blind redo offered in: ${out}`).not.toMatch(bad);
      }
    });
  }

  it('the no-action rendering states the TURN, and offers to verify before acting', () => {
    const out = sanitizeAnswerForUser('[no action dispatched — the assistant claimed completion but no action ran]');
    // Turn-scoped: it speaks about just now, not about all of history.
    expect(out).toMatch(/just now/i);
    // And the only honest offer from a position of not knowing: check first.
    expect(out).toMatch(/check|verify/i);
  });

  it('still refuses to ship the raw bracketed marker to the user', () => {
    const out = sanitizeAnswerForUser('[no action dispatched — the assistant claimed completion but no action ran]');
    expect(out).not.toContain('[');
    expect(out).not.toContain(']');
  });

  it('the curated meaning handed to the voice renderer carries the same scope', () => {
    // The WhatsApp path rephrases the curated meaning rather than the raw marker, so a
    // world-scoped curated string would leak the same falsehood through a different door.
    const meaning = curatedMarkerMeaning('[no action dispatched — retry]');
    expect(meaning).toBeTruthy();
    for (const bad of [...WORLD_SCOPED, ...BLIND_REDO_OFFERS]) {
      expect(meaning as string, `leaked via curated meaning: ${meaning}`).not.toMatch(bad);
    }
  });
});
