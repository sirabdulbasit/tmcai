/**
 * DEF-155 — the proactive surface becomes measurable (campaign C-1 / D-5).
 *
 * CL-033 counted **14 of 19** owner-facing messages in a six-hour window that
 * were proactive notifications rather than replies, and CL-034/R-1 is eight turns
 * of the owner arguing with them. `nexeoCapabilityBenchmark.ts` drives
 * `answerAsBrain` — twelve REPLIES — so eleven iterations have optimised the
 * smaller half of what he reads. D-5 asked for this slice at iteration 8; it was
 * deferred four times, and Codex ranked it first at iteration 11: *"fifth
 * deferral is no longer justified."*
 *
 * These tests defend the three properties that make the slice trustworthy, since
 * a measurement harness nobody checks is worse than none:
 *
 *   1. **It cannot write the owner's backlog.** D-1 exists because the compose
 *      benchmark left junk rows in `open_items` twice. It also forbade fixing
 *      that with a non-dispatching "benchmark mode", because a second path
 *      measures something other than production. The proactive surface sidesteps
 *      the dilemma: its producers are pure renderers, so this harness calls the
 *      same functions production calls and there is nothing to tear down.
 *   2. **The twelve compose cases, the judge and the gate are untouched.**
 *      Folding proactive cases into the existing average would move the headline
 *      without improving Brain — the one failure this loop cannot see from inside.
 *   3. **The extraction changed no text.** `renderLifecycleIntervention` and
 *      `renderUnattachedReply` were lifted verbatim out of their call sites. If a
 *      character moved, the owner's messages changed and this is no longer a
 *      measurement change.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  renderLifecycleIntervention,
  renderUnattachedReply,
} from '../src/services/notifications/proactiveMessageText';
import { __PROACTIVE_CASES } from '../src/scripts/nexeoProactiveBenchmark';

const SRC = path.join(__dirname, '..', 'src');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

describe('DEF-155 — the proactive slice is measurable and inert', () => {
  describe('the extraction changed no owner-facing text', () => {
    it('the lifecycle intervention renders the exact production sentence', () => {
      // Verbatim from R-1 17:00 and from actionLifecycleService before the move.
      expect(renderLifecycleIntervention({
        itemTitle: 'Vision Metric Integration',
        summary: 'Three follow-up attempts have gone out with no usable response.',
        delayReason: null,
      })).toBe(
        'Intervention needed on "Vision Metric Integration". Three follow-up attempts '
        + 'have gone out with no usable response. Please decide whether to remove the '
        + 'blocker, contact the responsible person, reassign it, or set a new deadline.',
      );
    });

    it('includes the delay reason only when there is one', () => {
      const withReason = renderLifecycleIntervention({
        itemTitle: 'X', summary: 'S.', delayReason: 'waiting on legal',
      });
      expect(withReason).toContain('Delay reason: waiting on legal.');
      expect(renderLifecycleIntervention({ itemTitle: 'X', summary: 'S.' }))
        .not.toContain('Delay reason');
    });

    it('the unattached reply renders the exact production sentence', () => {
      // Verbatim from CL-033, one of the ten.
      expect(renderUnattachedReply({ who: '+923001234567', body: 'Okby' })).toBe(
        '+923001234567 replied: "Okby"\n\n'
        + '(Not attached to an open request — everything I had with them is already '
        + 'closed or waiting on you.)',
      );
    });

    it('still truncates a long counterpart message at 300 characters', () => {
      const long = 'x'.repeat(400);
      const out = renderUnattachedReply({ who: 'A', body: long });
      expect(out).toContain('x'.repeat(300));
      expect(out).not.toContain('x'.repeat(301));
    });

    it('both call sites now delegate rather than holding their own copy', () => {
      // Source-level, and labelled as such (working rule 6): a second copy of a
      // template is how `protection-with-two-implementations` reached nine.
      const lifecycle = read('services/openItems/actionLifecycleService.ts');
      expect(lifecycle).toContain('renderLifecycleIntervention({');
      expect(lifecycle, 'the inline template must be gone, not duplicated')
        .not.toContain('Please decide whether to remove the blocker');

      const capture = read('services/delegation/delegationCaptureService.ts');
      expect(capture).toContain('renderUnattachedReply({');
      expect(capture).not.toContain('Not attached to an open request');
    });
  });

  describe('the slice cannot write the owner\'s backlog (D-1)', () => {
    const harness = read('scripts/nexeoProactiveBenchmark.ts');

    /** Only the import statements. Scanning raw source was wrong twice over: the
     *  docblock NAMES the forbidden surfaces in order to say it avoids them, so a
     *  textual check failed on the very sentence promising the property. The
     *  claim is about what the module imports, so that is what is read. */
    const harnessImports = harness
      .split('\n')
      .filter((l) => /^\s*import\b/.test(l) || /^\s*}\s*from\s+'/.test(l) || /^\s*await import\(/.test(l))
      .join('\n');

    it('imports no dispatch, queue or persistence surface', () => {
      // The guarantee is structural: with no import there is no send, so there
      // is nothing to tear down. Stronger than a teardown that ran (BLD-007).
      for (const forbidden of [
        'brainContactsUser',
        'brainOutboundService',
        'enqueueBrainPrompt',
        'brainPromptQueueService',
        'sendTenantWhatsAppText',
        'tenantWhatsappSender',
        'db/prisma',
        'answerAsBrain',
      ]) {
        expect(harnessImports, `the proactive slice must not import ${forbidden}`)
          .not.toContain(forbidden);
      }
    });

    it('every case renders through a real producer, never an inline string', () => {
      // A case that hard-codes its own text would score a fiction. Each render
      // must call one of the four exported producers.
      // Names only, no trailing paren: the transpiled arrow reads
      // `(0,__vite_ssr_import_1__.phraseDraftAsk)({...})`, so requiring
      // `name(` passed nothing and the assertion was testing the bundler.
      const producers = [
        'phraseDraftAsk',
        'phraseOwnerChase',
        'renderLifecycleIntervention',
        'renderUnattachedReply',
      ];
      for (const c of __PROACTIVE_CASES) {
        const body = c.render.toString();
        expect(
          producers.some((p) => body.includes(p)),
          `${c.id} does not call a real producer — it would be scoring a fiction`,
        ).toBe(true);
      }
    });

    it('reports dispatched=false and writesPerformed=0 as data, not prose', () => {
      // So the ledger can assert the property instead of trusting a docblock.
      expect(harness).toContain('dispatched: false');
      expect(harness).toContain('writesPerformed: 0');
    });

    it('every case produces non-empty text and names its provenance', () => {
      expect(__PROACTIVE_CASES.length).toBeGreaterThanOrEqual(6);
      for (const c of __PROACTIVE_CASES) {
        expect(c.render().trim().length, `${c.id} rendered nothing`).toBeGreaterThan(20);
        expect(c.provenance, `${c.id} must cite the defect or chat log it came from`)
          .toMatch(/DEF-|CL-|R-1|B0/);
        expect(c.situation.length).toBeGreaterThan(20);
      }
    });

    it('the six cases cover the shapes D-5 named', () => {
      const ids = __PROACTIVE_CASES.map((c) => c.id).join(' ');
      for (const shape of [
        'draft-ask',                  // the "Basit," message
        'owner-chase',                // DEF-151's four disambiguation requests
        'lifecycle-intervention',     // R-1 17:00, B08's framing
        'unattached-reply',           // one of CL-033's ten
        'duplicate-window',           // DEF-139's cadence, as the owner saw it
        'unreadable-delegatee-reply', // DEF-142's "Kon"
      ]) {
        expect(ids, `D-5 asked for a ${shape} case`).toContain(shape);
      }
    });
  });

  describe('the compose benchmark is untouched', () => {
    it('the twelve-case harness does not import the proactive slice', () => {
      // Separate surfaces, separate numbers. Averaging them would move the
      // headline without improving Brain.
      const compose = read('scripts/nexeoCapabilityBenchmark.ts');
      expect(compose).not.toContain('nexeoProactiveBenchmark');
      expect(compose).not.toContain('proactiveMessageText');
    });

    it('the proactive report labels itself as separately scored', () => {
      const harness = read('scripts/nexeoProactiveBenchmark.ts');
      expect(harness).toContain("surface: 'proactive'");
      expect(harness).toContain('Do not average these with the ');
    });

    it('the slice uses the SAME judge rather than a second rubric', () => {
      const harness = read('scripts/nexeoProactiveBenchmark.ts');
      expect(harness).toContain("import { evaluateBrainResponse }");
      // A local scoring function here would be a tenth instance of the
      // duplicated-protection shape.
      expect(harness).not.toContain('SYSTEM_PROMPT');
    });
  });
});
