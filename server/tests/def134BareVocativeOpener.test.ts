import { describe, it, expect } from 'vitest';
import { stripBareVocativeOpener } from '../src/services/knowledge/brainComposer';

// DEF-134 (2026-08-11). The capability benchmark showed 11 of 12 replies
// opening with "Sir, ..." — the preferred form of address stamped on the
// front of every message. The Living Assistant judge scored the human-voice
// criterion (C4) down on 11 of those 12 cases naming exactly that ("canned",
// "template-like", "robotic if overused"), making C4 the gating criterion at
// 84.8. The preference is real; the reflexive prefixing is the defect.
//
// The guard has to cut the bare vocative WITHOUT touching the legitimate
// uses of the same word — that separation is the whole point, so it is what
// these assertions pin down.

describe('DEF-134 — bare-vocative opener is stripped, real address use is not', () => {
  describe('strips the reflexive opener', () => {
    // Verbatim openers from the iter-00 benchmark cases that lost C4 points.
    const realCases: Array<[string, string, string]> = [
      ['B01', "Sir, I haven't sent any messages directly to Hamna myself.", "I haven't sent any messages directly to Hamna myself."],
      ['B02', "Sir, Hamna Latif Bhutta's mobile number is +923134199294.", "Hamna Latif Bhutta's mobile number is +923134199294."],
      ['B03', "Sir, the Q3 headcount plan is an approval item for you.", 'The Q3 headcount plan is an approval item for you.'],
      ['B07', 'Sir, you have three outstanding items with Hamna Latif Bhutta:', 'You have three outstanding items with Hamna Latif Bhutta:'],
      ['B11', "Sir, I can't place calls directly.", "I can't place calls directly."],
    ];
    for (const [caseId, before, after] of realCases) {
      it(`${caseId}: drops the leading vocative and recapitalises the substance`, () => {
        expect(stripBareVocativeOpener(before, 'Sir')).toBe(after);
      });
    }

    it('handles a dash or colon separator, not only a comma', () => {
      expect(stripBareVocativeOpener('Sir — your 3pm moved to 4.', 'Sir')).toBe('Your 3pm moved to 4.');
      expect(stripBareVocativeOpener('Sir: your 3pm moved to 4.', 'Sir')).toBe('Your 3pm moved to 4.');
    });

    it('skips a leading markdown marker when recapitalising', () => {
      expect(stripBareVocativeOpener('Sir, *high priority* items follow.', 'Sir'))
        .toBe('*High priority* items follow.');
    });

    it('applies to whatever form of address the user configured, not just "Sir"', () => {
      expect(stripBareVocativeOpener('Boss, the invoice cleared.', 'Boss')).toBe('The invoice cleared.');
      expect(stripBareVocativeOpener('Basit, the invoice cleared.', 'Basit')).toBe('The invoice cleared.');
    });

    it('is case-insensitive on the address token', () => {
      expect(stripBareVocativeOpener('sir, the invoice cleared.', 'Sir')).toBe('The invoice cleared.');
    });
  });

  describe('leaves legitimate uses of the address alone', () => {
    it('keeps a real greeting — "Good morning, Sir." is natural and scored well', () => {
      const greeting = "Good morning, Sir.\n\nHere's a look at your day:";
      expect(stripBareVocativeOpener(greeting, 'Sir')).toBe(greeting);
    });

    it('keeps the address when it is not the first thing in the reply', () => {
      const mid = "I've logged it for the team, Sir.";
      expect(stripBareVocativeOpener(mid, 'Sir')).toBe(mid);
    });

    it('only ever looks at position 0 — a vocative later in the reply survives', () => {
      // Pins the ^ anchor. Without it the guard would reach into the middle
      // of a reply and cut a vocative the writer meant to be there.
      const later = 'Done. Sir, one more thing — your 3pm moved to 4.';
      expect(stripBareVocativeOpener(later, 'Sir')).toBe(later);
    });

    it('keeps the token when it is a sentence subject, not a vocative (no separator)', () => {
      const subject = 'Sir Basit is asking whether you will be in the office tomorrow.';
      expect(stripBareVocativeOpener(subject, 'Sir')).toBe(subject);
    });

    it('never leaves a stub — a reply that is only the vocative is untouched', () => {
      expect(stripBareVocativeOpener('Sir, ok', 'Sir')).toBe('Sir, ok');
    });

    it('is inert when no form of address is configured', () => {
      expect(stripBareVocativeOpener('Sir, the invoice cleared.', '')).toBe('Sir, the invoice cleared.');
    });

    it('does not touch a reply that never opens with the address', () => {
      const plain = "I haven't sent anything to Hamna today.";
      expect(stripBareVocativeOpener(plain, 'Sir')).toBe(plain);
    });
  });

  describe('mutation checks — the assertions would catch a broken guard', () => {
    it('a guard that stripped any leading word would break the greeting case', () => {
      // If the regex dropped the separator requirement, "Good morning, Sir."
      // would lose "Good" — the greeting assertion above is what catches it.
      expect(stripBareVocativeOpener('Good morning, Sir.', 'Sir')).toContain('Good morning');
    });

    it('a guard that forgot to recapitalise would leave a lowercase sentence', () => {
      expect(stripBareVocativeOpener('Sir, the invoice cleared.', 'Sir')).not.toMatch(/^the /);
    });

    it('an address containing regex metacharacters is escaped, not interpreted', () => {
      // "S.r" is not the word "Sir". Unescaped, "." means "any character",
      // so the guard would match — and cut — an opener that does not contain
      // the configured address at all.
      expect(stripBareVocativeOpener('Sir, the invoice cleared.', 'S.r')).toBe('Sir, the invoice cleared.');
    });
  });
});
