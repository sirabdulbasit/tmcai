/**
 * DEF-136 — the address guard existed, was correct, and was never reached.
 *
 * DEF-134 (2026-08-11) diagnosed the "Sir, …" prefix correctly and built a
 * working guard for it. The guard was written inline in `compose`'s legacy
 * tail. The reasoning gate returns ~1,820 lines ABOVE that, and reasoning is
 * the DEFAULT path — so on essentially every real turn the guard was dead
 * code. The capability benchmark kept scoring C4 down for bare vocatives
 * across three consecutive measurements (84.8 → 85.8 → 85.4) while
 * `def134BareVocativeOpener.test.ts` stayed green, because those 19 tests
 * call `stripBareVocativeOpener` directly — the function the live path
 * skipped.
 *
 * This is DEF-041's rule again, and DEF-041 said it in one line: judge the
 * STATE of the turn, never the code path that produced it. A remedy bolted
 * to one exit is invisible to every other exit, and helper-level tests
 * cannot see the difference.
 *
 * So the assertions here come in two layers, and the SECOND layer is the
 * point of the file:
 *
 *   1. `finaliseUserVisibleProse` behaves — form, frequency, and the order
 *      between them.
 *   2. A real `compose()` call, returning through the REASONING exit,
 *      actually finalises its prose. That is the assertion that would have
 *      failed before this commit, and the one that fails again if someone
 *      adds a third exit and forgets the chokepoint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks. Everything compose touches before the reasoning return. ──────
//
// Factories are self-contained because vi.mock is hoisted above imports.

vi.mock('../src/db/prisma', () => {
  const model = {
    findMany: async () => [],
    findFirst: async () => null,
    findUnique: async () => null,
    create: async () => ({}),
    createMany: async () => ({ count: 0 }),
    update: async () => ({}),
    updateMany: async () => ({ count: 0 }),
    upsert: async () => ({}),
    count: async () => 0,
    aggregate: async () => ({}),
    groupBy: async () => [],
    deleteMany: async () => ({ count: 0 }),
  };
  const p: any = new Proxy(
    {
      $queryRaw: async () => [],
      $queryRawUnsafe: async () => [],
      $executeRaw: async () => 0,
      $transaction: async (arg: any) => (typeof arg === 'function' ? arg(p) : []),
    },
    { get: (t: any, k: string) => (k in t ? t[k] : model) },
  );
  return { __esModule: true, default: p, prisma: p };
});

const PERSONA = {
  addressAs: 'Sir',
  userFirstName: 'Basit',
  userFullName: 'Basit Ahmed',
  userEmail: 'basit.ahmed@tmcltd.ai',
  systemPreamble: 'test persona',
  brainName: 'Suzi',
  userGender: 'male',
};

vi.mock('../src/services/knowledge/brainPersonaService', () => ({
  __esModule: true,
  getBrainPersona: async () => PERSONA,
}));

/** The reasoning answer under test — set per case. */
const reasoningAnswer = { text: '' };

vi.mock('../src/services/knowledge/reasoningCompose', () => ({
  __esModule: true,
  reasoningComposeWithTools: async () => ({
    decision: 'answer',
    confidence: 1,
    rationale: 'test',
    answer_text: reasoningAnswer.text,
    action: null,
    citations: [],
  }),
}));

vi.mock('../src/services/knowledge/reasoningCompose.applyDispatch', () => ({
  __esModule: true,
  applyReasoningDecision: async () => ({
    answer: reasoningAnswer.text,
    citedPageIds: [],
    gaps: [],
    sources: [],
    action: null,
    actionResult: null,
  }),
}));

/** The legacy tail's single LLM seam. Returning a compose envelope here
 *  drives the OTHER exit through the same chokepoint. */
const legacyAnswer = { text: '' };

vi.mock('../src/services/llmRouter', () => ({
  __esModule: true,
  callLLM: async () => ({
    text: JSON.stringify({ answer: legacyAnswer.text, cites: [], gaps: [], action: null }),
    provider: 'test',
    model: 'test',
  }),
}));

import { compose, finaliseUserVisibleProse } from '../src/services/knowledge/brainComposer';

/** Longer than 60 chars so compose's early-confirm pending lookup is skipped
 *  (it only runs for short replies that could be a reference, not a fresh
 *  instruction). Keeps this test on the reasoning path and off the
 *  confirmation path. */
const QUESTION = 'What is outstanding with Hamna at the moment, and who owns each of those items?';

async function composeReasoningAnswer(answer: string): Promise<string> {
  reasoningAnswer.text = answer;
  const result = await compose(
    'TMC-0001',
    2,
    QUESTION,
    { intent: 'question', queries: [], scopeLean: 'personal' } as any,
    [],
    [],
    { useReasoning: true, channel: 'web' } as any,
  );
  return result.answer;
}

describe('DEF-136 — prose finalisation is one chokepoint, reachable from every exit', () => {
  // ── Layer 2 first: the live path. This is the regression that shipped. ──
  describe('the REASONING exit finalises its prose (the bypass that shipped)', () => {
    beforeEach(() => {
      reasoningAnswer.text = '';
    });

    // Verbatim C4 losers from the iter-01/iter-02 benchmark reasoning answers.
    const benchmarkOpeners: Array<[string, string, string]> = [
      [
        'B06',
        'Sir, there are three items outstanding with Hamna Latif Bhutta.',
        'There are three items outstanding with Hamna Latif Bhutta.',
      ],
      [
        'B07',
        'Sir, you have three outstanding items with Hamna Latif Bhutta:',
        'You have three outstanding items with Hamna Latif Bhutta:',
      ],
      [
        'B08',
        "Sir, I haven't been able to reach her on that number yet.",
        "I haven't been able to reach her on that number yet.",
      ],
    ];

    for (const [caseId, modelText, expected] of benchmarkOpeners) {
      it(`${caseId}: compose() strips the bare vocative on the reasoning path`, async () => {
        const answer = await composeReasoningAnswer(modelText);
        expect(
          answer,
          'the reasoning exit must route through finaliseUserVisibleProse — '
            + 'before DEF-136 this returned the envelope untouched',
        ).toBe(expected);
      });
    }

    it('returns source=reasoning, so the finalisation did not change which path ran', async () => {
      reasoningAnswer.text = 'Sir, the invoice cleared this morning.';
      const result = await compose(
        'TMC-0001', 2, QUESTION,
        { intent: 'question', queries: [], scopeLean: 'personal' } as any,
        [], [], { useReasoning: true, channel: 'web' } as any,
      );
      expect(result.source).toBe('reasoning');
      expect(result.answer).toBe('The invoice cleared this morning.');
    });

    it('normalises a full-name greeting to the preferred form on the reasoning path too', async () => {
      // The FORM half of the chokepoint was equally unreachable from here.
      const answer = await composeReasoningAnswer('Hi Basit Ahmed, your 3pm moved to 4.');
      expect(answer).toBe('Hi Sir, your 3pm moved to 4.');
    });

    it('leaves a genuine greeting alone end-to-end', async () => {
      const answer = await composeReasoningAnswer('Good morning, Sir. Three meetings today.');
      expect(answer).toBe('Good morning, Sir. Three meetings today.');
    });

    it('leaves prose with no address at all untouched', async () => {
      const clean = 'Her number is +923134199294, and the item is still open.';
      expect(await composeReasoningAnswer(clean)).toBe(clean);
    });
  });

  // ── The other exit. Same chokepoint, reached a different way. ───────────
  describe('the LEGACY exit finalises its prose', () => {
    async function composeLegacyAnswer(answer: string): Promise<string> {
      legacyAnswer.text = answer;
      const result = await compose(
        'TMC-0001', 2, QUESTION,
        { intent: 'question', queries: [], scopeLean: 'personal' } as any,
        [], [], { useReasoning: false, channel: 'web' } as any,
      );
      return result.answer;
    }

    it('strips the bare vocative on the legacy path', async () => {
      expect(await composeLegacyAnswer('Sir, you have three outstanding items.'))
        .toBe('You have three outstanding items.');
    });

    it('normalises a full-name greeting on the legacy path', async () => {
      expect(await composeLegacyAnswer('Hi Basit Ahmed, your 3pm moved to 4.'))
        .toBe('Hi Sir, your 3pm moved to 4.');
    });

    it('leaves a genuine greeting alone on the legacy path', async () => {
      expect(await composeLegacyAnswer('Good morning, Sir. Three meetings today.'))
        .toBe('Good morning, Sir. Three meetings today.');
    });
  });

  // ── Layer 1: the chokepoint's own behaviour. ────────────────────────────
  describe('finaliseUserVisibleProse — form, then frequency', () => {
    it('applies both rules without them interfering', () => {
      // I first wrote this test asserting that form-BEFORE-frequency was
      // load-bearing. Mutation proved otherwise: swapping the two changed
      // no result, so the claim was wrong and the comment came out of the
      // source. The rules anchor on disjoint shapes — form wants a greeting
      // followed by the user's NAME, frequency wants the PREFERRED TOKEN at
      // position 0 — so neither creates or destroys the other's match.
      // What IS worth pinning is that they compose without damage.
      expect(finaliseUserVisibleProse('Hi Basit Ahmed, your 3pm moved to 4.', PERSONA))
        .toBe('Hi Sir, your 3pm moved to 4.');
      // Both rules with something for each to do in the same reply: the
      // form rule rewrites the mid-sentence greeting, the frequency rule
      // drops the opener, and the result is what a person would write.
      expect(finaliseUserVisibleProse('Sir, hi Basit Ahmed — your 3pm moved to 4.', PERSONA))
        .toBe('Hi Sir — your 3pm moved to 4.');
    });

    it('strips a bare vocative opener', () => {
      expect(finaliseUserVisibleProse("Sir, I haven't sent it yet.", PERSONA))
        .toBe("I haven't sent it yet.");
    });

    it('rewrites a first-name greeting to the preferred form', () => {
      expect(finaliseUserVisibleProse('Hey Basit, the invoice cleared.', PERSONA))
        .toBe('Hey Sir, the invoice cleared.');
    });

    it('keeps the user\'s configured honorific — it does not delete address globally', () => {
      // The explicit constraint on this change: DEF-136 fixes REACHABILITY,
      // it does not repeal the Settings → Profile preference.
      expect(finaliseUserVisibleProse('Good morning, Sir. Two things need you.', PERSONA))
        .toBe('Good morning, Sir. Two things need you.');
      expect(finaliseUserVisibleProse('That one is riskier, Sir, than it looks.', PERSONA))
        .toBe('That one is riskier, Sir, than it looks.');
    });

    it('does not touch a full name used as a topic reference', () => {
      const topic = "Basit Ahmed's profile lists two open approvals.";
      expect(finaliseUserVisibleProse(topic, PERSONA)).toBe(topic);
    });

    it('is a no-op when persona carries no usable address', () => {
      const text = 'Sir, the invoice cleared.';
      expect(finaliseUserVisibleProse(text, { addressAs: '', userFirstName: '', userFullName: '' })).toBe(text);
      expect(finaliseUserVisibleProse(text, null)).toBe(text);
      expect(finaliseUserVisibleProse('', PERSONA)).toBe('');
    });

    it('falls back to the first name when no preferred title is set', () => {
      const p = { addressAs: '', userFirstName: 'Basit', userFullName: 'Basit Ahmed' };
      expect(finaliseUserVisibleProse('Basit, the invoice cleared.', p))
        .toBe('The invoice cleared.');
    });

    it('is idempotent — running it twice changes nothing further', () => {
      const once = finaliseUserVisibleProse('Sir, the invoice cleared.', PERSONA);
      expect(finaliseUserVisibleProse(once, PERSONA)).toBe(once);
    });

    it('leaves a bracketed system marker alone', () => {
      // Markers are rendered by answerSanitizer, not persona prose. The
      // leading "[" means the vocative pattern cannot anchor.
      const marker = '[remove_open_item: could not find an open item matching "that"]';
      expect(finaliseUserVisibleProse(marker, PERSONA)).toBe(marker);
    });
  });
});
