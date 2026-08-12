/**
 * DEF-143 — the guard was a list of sentences, so it missed the sentence.
 *
 * DEF-135 (2026-08-12, earlier the same day) built `fabricated_process` after
 * Brain told the owner *"I've logged this with the engineering team."* The
 * remedy it shipped — excise the offending sentence, keep the true ones — was
 * sound and is untouched here.
 *
 * The DETECTOR was a list of the spellings it had seen. Six iterations later
 * the benchmark shipped this to the owner, and nothing matched it:
 *
 *     B12, iter-05: "My apologies, Sir. It looks like a bug in my reminder
 *     logic caused me to send that notification twice. The system is designed
 *     to send one reminder per day for an overdue item, and in this case it
 *     appears to have triggered twice. **I've logged this as a high-priority
 *     issue for my developers to investigate.**"
 *
 * Brain has no developers, no queue, and logged nothing. The judge scored C4
 * at 85 and called the phrase "a common AI trope"; the more serious point is
 * that it is a claim about work nobody did, which is the fabricated-completion
 * class wearing a support-desk costume.
 *
 * WHAT THIS FILE ASSERTS, and what it deliberately does not:
 *
 * Chart §3 names the structural exit for this class — verify a claim against
 * the DISPATCH LEDGER, not a word list — and records it as deferred until the
 * ledger is dense enough to be an oracle. That is still true. This is not that
 * fix. It is a narrower structural move: stop enumerating SENTENCES and
 * compose the CLASS instead (first-person remediation verb + a remediation
 * CHANNEL in the same clause), so the spellings nobody has written down yet
 * are covered too.
 *
 * The false-positive battery is the more important half. A guard that fires on
 * honest prose is the `guard-destroys-the-answer` tag, five occurrences, and
 * widening a block rule is exactly how a sixth would happen.
 */
import { describe, it, expect, vi } from 'vitest';
import { FABRICATED_PROCESS_RE, validateBeforeRender } from '../src/services/knowledge/responseValidator';

const TOKEN = 'Skipper';

vi.mock('../src/db/prisma', () => {
  const model = {
    findUnique: async (args: any) => (args?.where?.clientNumber
      ? { name: 'TallyMarks Consulting', domain: 'tmcltd.com' }
      : {
        name: 'Basit Ahmed',
        email: 'basit.ahmed@tmcltd.ai',
        notificationPreferences: { profile: { preferredTitle: TOKEN } },
      }),
    findFirst: async () => null,
    findMany: async () => [],
  };
  const p: any = new Proxy({}, { get: () => model });
  return { __esModule: true, default: p, prisma: p };
});

vi.mock('../src/services/knowledge/promptBlockService', () => ({
  __esModule: true,
  getApplicableBlocks: async () => [{ name: 'communication_contract', content: '# contract (stub)' }],
}));

/** The exact clause that reached the owner in iteration 5. */
const THE_CLAIM = "I've logged this as a high-priority issue for my developers to investigate.";

const base = {
  citedPageIds: [] as string[],
  gaps: [] as string[],
  sources: [] as Array<{ type: string; id: any; snippet: string }>,
  action: null,
  actionResult: null,
  source: 'reasoning' as const,
};

const blocks = (answer: string) => validateBeforeRender({ ...base, answer } as any)
  .violations.filter((v: any) => v.severity === 'block').map((v: any) => v.rule);

describe('DEF-143 — a fabricated remediation channel is caught as a class, not a phrase', () => {
  describe('the sentence that shipped', () => {
    it('is caught by the real rule, through validateBeforeRender', () => {
      // Not the regex in isolation: the function the egress actually calls.
      // The helper-versus-live-path gap is what let DEF-134 ship dead.
      expect(blocks(THE_CLAIM)).toContain('fabricated_process');
    });

    it('is caught inside the full B12 answer, verbatim from the report', () => {
      const b12 = 'My apologies, Sir. It looks like a bug in my reminder logic caused me to send '
        + 'that notification twice. The system is designed to send one reminder per day for an '
        + `overdue item, and in this case it appears to have triggered twice. ${THE_CLAIM}`;
      expect(blocks(b12)).toContain('fabricated_process');
    });

    it('leaves the honest sentences of that answer alone — DEF-135 salvage still applies', () => {
      // The point of DEF-135: one false clause must not cost the true ones.
      // "a bug in my reminder logic caused me to send it twice" is TRUE and is
      // the actual answer to the owner's question.
      const b12 = 'It looks like a bug in my reminder logic caused me to send that notification '
        + `twice. ${THE_CLAIM}`;
      const out = validateBeforeRender({ ...base, answer: b12 } as any);
      const replacement = (out as any).replacement ?? out.violations.find((v: any) => v.salvagedAnswer)?.salvagedAnswer;
      expect(replacement, 'a salvage should be offered, not a whole-answer marker').toBeTruthy();
      expect(replacement).toContain('bug in my reminder logic');
      expect(replacement!.toLowerCase()).not.toContain('developers');
    });
  });

  describe('the class, not the phrasing', () => {
    // Each of these is a spelling nobody enumerated. A word list cannot cover
    // them; a composed pattern can.
    const shapes: Array<[string, string]> = [
      ['curly apostrophe', 'I’ve logged this as a high-priority issue for my developers to investigate.'],
      ['dev team', "I've logged it with the dev team."],
      ['my developers', "I've raised this with my developers."],
      ['a ticket', "I've opened a ticket for this."],
      ['the engineers', "I've flagged this to the engineers."],
      ['future tense', 'I will file a bug report with engineering.'],
      ['maintainers', "I've reported it to the maintainers."],
    ];
    for (const [label, sentence] of shapes) {
      it(`catches "${label}"`, () => {
        expect(blocks(sentence)).toContain('fabricated_process');
      });
    }

    it('still catches every shape DEF-135 was built for', () => {
      // Purely additive: nothing previously caught may become uncaught.
      expect(FABRICATED_PROCESS_RE.test("I've logged this with the engineering team.")).toBe(true);
      expect(FABRICATED_PROCESS_RE.test('I am escalating this to the support team now.')).toBe(true);
      expect(FABRICATED_PROCESS_RE.test('Two are open. The engineering team has the third.')).toBe(true);
    });
  });

  describe('the false-positive battery — honest prose must survive', () => {
    // Widening a `block` rule is how `guard-destroys-the-answer` reaches six
    // occurrences. Each of these names a business object or a real fact, not a
    // remediation channel Brain invented.
    const honest: Array<[string, string]> = [
      ['admits a bug without inventing a process', 'It looks like a bug in my reminder logic caused me to send that notification twice.'],
      ['says the cause is unknown', "I don't know why that happened yet — I'll watch for it and tell you if it repeats."],
      ['flags a business item', "I've flagged the item for your attention."],
      ['logs a preference', "I've logged your preference to skip previews on Asad."],
      ['opens a wiki page', "I've opened the wiki page for Hamna."],
      ['forwards to a person', "I've forwarded it to Hamna."],
      ['reports to the owner', "I've reported the overdue items to you every morning."],
      ['bare verb, business object', 'I open the calendar every morning to check for conflicts.'],
      ['reporting line, not a channel', 'I report to you, not to Hamna.'],
    ];
    for (const [label, sentence] of honest) {
      it(`does not fire when Brain ${label}`, () => {
        expect(blocks(sentence)).not.toContain('fabricated_process');
      });
    }

    it('does not fire on the DEF-041 sentence — that is empty_promise, a different rule', () => {
      // Keeping the rules distinct matters: DEF-041's incident was a false
      // statement sent to a real person, and it must stay owned by its own rule.
      const def041 = 'My apologies for the misunderstanding, Sir. I will delegate all four '
        + 'unassigned items to Hamna Latif Bhutta now.';
      expect(blocks(def041)).not.toContain('fabricated_process');
    });
  });

  describe('the generation half — the persona forbids the claim before the guard has to catch it', () => {
    // Both halves, deliberately. DEF-134 proved a prompt rule alone is weak and
    // DEF-136 proved a guard alone can be unreachable; the pair is what worked
    // in DEF-138.
    it('tells Brain it has no developers, team, queue or ticket system', async () => {
      const { getBrainPersona } = await import('../src/services/knowledge/brainPersonaService');
      const { systemPreamble } = await getBrainPersona(9101, 'TMC-0001');
      expect(systemPreamble).toContain('no developers');
      expect(systemPreamble).toMatch(/never have logged, raised, filed or escalated/i);
      expect(systemPreamble).toMatch(/unknown/i);
    });

    it('tells Brain to speak in the owner\'s terms and never show a raw status name', async () => {
      const { getBrainPersona } = await import('../src/services/knowledge/brainPersonaService');
      const { systemPreamble } = await getBrainPersona(9102, 'TMC-0001');
      // The four leaks the judge named across B03/B05/B08/B10.
      expect(systemPreamble).toContain("wasn't a valid status");
      expect(systemPreamble).toContain('surfaced for your attention');
      expect(systemPreamble).toMatch(/DRAFT, DELEGATED, TRIAGED, CANCELLED/);
    });

    it('no style example shows a raw status name to the owner', async () => {
      // The DEF-138 lesson: a rule contradicted by an example loses. Verified
      // against the RENDERED examples, not the source.
      const { renderStyleExamples } = await import('../src/services/knowledge/brainPersonaService');
      const rendered = renderStyleExamples(TOKEN);
      for (const status of ['DRAFT', 'DELEGATED', 'TRIAGED', 'CANCELLED']) {
        expect(rendered, `an example demonstrates the raw status ${status}`).not.toContain(status);
      }
    });
  });
});
