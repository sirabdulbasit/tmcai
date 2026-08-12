/**
 * DEF-138 — the instruction said "optional"; the examples said "every time".
 *
 * DEF-134 wrote the correct rule into the persona: addressing the user is
 * optional, most replies should skip it, more than about one reply in four
 * reads as a template. DEF-136 then made its structural backstop reachable.
 * C4 still gated at 86.3, and the judge kept naming the same thing:
 *
 *   B06  "'Certainly, Sir' is a bit overly formal and template-like"
 *   B05  "The greeting 'Morning, Sir.' is a little stiff … or simply 'Morning.'"
 *   B12  "'My apologies, Sir.' is a little formal"
 *   B01  "'Sir' is slightly overly formal for a human assistant"
 *
 * The reason is 60 lines below the rule. Four of the eight style examples
 * addressed the user — **50%, twice the ceiling the rule states** — and two
 * of those were on wholly ordinary turns: "thanks" → "Anytime, Sir." and
 * "how's my day looking?" → "Morning, Sir. …". The model was imitating the
 * demonstrations, correctly. In a prompt, examples are the strongest
 * instruction in the file, and a rule that contradicts them loses.
 *
 * A prose rule can be outvoted by a demonstration. A ratio cannot, if
 * something counts it — which is what this file does. The examples are now
 * data with a declared reason for each use of the address, so adding one
 * back on an ordinary turn fails CI instead of quietly costing C4 points.
 */
import { describe, it, expect, vi } from 'vitest';

/** A form of address that cannot collide with anything else in the prompt,
 *  so counting occurrences means what it looks like it means. */
const TOKEN = 'Skipper';

vi.mock('../src/db/prisma', () => {
  const model = {
    findUnique: async (args: any) => {
      if (args?.where?.clientNumber) return { name: 'TallyMarks Consulting', domain: 'tmcltd.com' };
      return {
        name: 'Basit Ahmed',
        email: 'basit.ahmed@tmcltd.ai',
        notificationPreferences: { profile: { preferredTitle: TOKEN } },
      };
    },
    findFirst: async () => null,
    findMany: async () => [],
  };
  const p: any = new Proxy({}, { get: () => model });
  return { __esModule: true, default: p, prisma: p };
});

// The DB-backed communication contract is a separate prompt source. It
// mentions the address exactly once, as a PROHIBITION ("never open with
// 'Of course <address>!'"), so it is not part of this budget — but it must
// not be able to smuggle demonstrations in either, hence a fixed stub.
vi.mock('../src/services/knowledge/promptBlockService', () => ({
  __esModule: true,
  getApplicableBlocks: async () => [
    { name: 'communication_contract', content: '# Communication contract\n(stubbed for this test)' },
  ],
}));

import {
  STYLE_EXAMPLES,
  ADDRESS_EXAMPLE_CEILING,
  renderStyleExamples,
  getBrainPersona,
  type AddressWarrant,
} from '../src/services/knowledge/brainPersonaService';

/** The three contexts the voice rule names as genuinely warranting the
 *  user's name. Anything else is deference-by-reflex. */
const WARRANTED: AddressWarrant[] = ['bad-news-or-pushback', 'urgent-attention', 'day-opening'];

const addressing = STYLE_EXAMPLES.filter((ex) => ex.addressUse !== 'none');

describe('DEF-138 — the style examples obey the rule they are meant to demonstrate', () => {
  describe('the budget', () => {
    it(`spends the address on at most one example in four`, () => {
      const rate = addressing.length / STYLE_EXAMPLES.length;
      expect(
        rate,
        `${addressing.length}/${STYLE_EXAMPLES.length} examples address the user. `
          + 'The voice rule promises at most one in four; before DEF-138 this was 4/8. '
          + 'If you are adding an example that uses the name, remove one that does not need it.',
      ).toBeLessThanOrEqual(ADDRESS_EXAMPLE_CEILING);
    });

    it('states the same ceiling in the prose the model reads', async () => {
      // Pins prose to the constant. If someone relaxes the number in the
      // rule, or the constant, the two can no longer drift apart silently.
      const { systemPreamble } = await getBrainPersona(9001, 'TMC-0001');
      expect(systemPreamble).toContain('one reply in four');
      expect(ADDRESS_EXAMPLE_CEILING).toBe(1 / 4);
    });
  });

  describe('the classification is honest', () => {
    for (const ex of STYLE_EXAMPLES) {
      it(`"${ex.user}" — declared ${ex.addressUse}, and the text agrees`, () => {
        const rendered = ex.you(TOKEN);
        if (ex.addressUse === 'none') {
          expect(
            rendered,
            'declared as not addressing the user, but the address token is in the text',
          ).not.toContain(TOKEN);
        } else {
          expect(
            rendered,
            'declares a reason for addressing the user, but never actually does',
          ).toContain(TOKEN);
        }
      });
    }

    it('only uses the three warranted contexts', () => {
      for (const ex of addressing) {
        expect(WARRANTED, `"${ex.user}" claims an unrecognised warrant`).toContain(ex.addressUse);
      }
    });

    it('keeps the address for pushback and for urgent attention', () => {
      // The constraint from Codex's directive, asserted rather than assumed:
      // preserve the configured form where address is genuinely useful. This
      // change reduces frequency; it does not purge the preference.
      expect(addressing.map((ex) => ex.addressUse).sort())
        .toEqual(['bad-news-or-pushback', 'urgent-attention']);
    });
  });

  describe('the shapes the judge named are gone', () => {
    const rendered = renderStyleExamples(TOKEN);

    // Each of these was demonstrated to the model and came back in a
    // benchmark answer nearly verbatim.
    const retired: Array<[string, string]> = [
      ['B06 / "thanks"', `Anytime, ${TOKEN}`],
      ['B05 / day brief', `Morning, ${TOKEN}`],
    ];
    for (const [caseId, shape] of retired) {
      it(`no example teaches "${shape}" (${caseId})`, () => {
        expect(rendered).not.toContain(shape);
      });
    }

    it('still greets on the day-brief turn — the greeting was not the defect', () => {
      // "Morning." survives; "Morning, Sir." does not. The judge proposed
      // exactly this repair, so removing the greeting too would overshoot.
      expect(rendered).toContain('Morning. Three meetings');
    });
  });

  describe('the rendered prompt, not just the data', () => {
    it('carries at most two address tokens in the style-examples section', async () => {
      const { systemPreamble } = await getBrainPersona(9002, 'TMC-0001');
      const section = systemPreamble.slice(systemPreamble.indexOf('# Style examples'));
      expect(section, 'style-examples section missing from the rendered preamble').toBeTruthy();
      const count = section.split(TOKEN).length - 1;
      expect(count, `the rendered examples address the user ${count} times`).toBeLessThanOrEqual(2);
    });

    it('still mandates the configured form and still forbids the full name', async () => {
      const { systemPreamble } = await getBrainPersona(9003, 'TMC-0001');
      expect(systemPreamble).toContain(`the form is "${TOKEN}"`);
      expect(systemPreamble).toContain('NEVER "Basit Ahmed"');
    });

    it('names the reflex shapes the judge flagged as things to avoid', async () => {
      const { systemPreamble } = await getBrainPersona(9004, 'TMC-0001');
      // Frequency/context as the model's rule — Codex's constraint was to do
      // this in generation, not by adding a broader destructive regex.
      expect(systemPreamble).toContain(`My apologies, ${TOKEN}`);
      expect(systemPreamble).toContain(`Certainly, ${TOKEN}`);
    });
  });
});
