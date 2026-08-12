/**
 * DEF-145 — DEF-144 was correct, and it changed nothing the owner could see.
 *
 * B04's benchmark reply was **byte-identical across iterations 06 and 07** — 94
 * characters of `Updated "Define rules …": priority=high.` — while the composer
 * log for the iteration-07 turn shows the model had said:
 *
 *     "Got it. I've marked that as high priority. Still needs a due date if you
 *      have one."
 *
 * dist was rebuilt at 11:23:24 (after the 11:15:56 commit) and contains
 * `brainAnswerSurvivesReceipt`; the benchmark ran at 11:23:34. So DEF-144 was
 * live and inert.
 *
 * The reason is `channelRenderer.renderForChannel`, which handed the receipt to
 * WhatsApp whenever an action succeeded. `answerAsBrain` is called with
 * `channel: 'whatsapp'` by the benchmark AND by the owner's real surface, so
 * that renderer — not `compose` — is what decides what gets read. DEF-144 kept
 * Brain's prose inside the composer and this line put the receipt straight back.
 *
 * That makes FOUR implementations of one policy: the composer's inline success
 * branches, `applyOpenItemUpdate`, `dispatchPendingDirect`, and this renderer.
 * `protection-with-two-implementations`, ninth occurrence, and the tell is
 * exact — a fix verified by tests and by reading the code, with no observable
 * effect, because a later layer re-decides the same question.
 *
 * Two things the substitution was protecting, both preserved and both asserted
 * below: the `ok === true` gate (a failed action's message is an internal
 * sentinel, one leaked verbatim on 2026-05-20), and the guarantee that the owner
 * is not told something the write did not do.
 *
 * That second one gets stricter here, not looser. Codex's iteration-7 review,
 * risk #1: once prose actually reaches the owner, `"I've set the priority to
 * high and the deadline to Friday."` on an update that applied no due date
 * becomes a live false completion claim. Masked before, real now — so the policy
 * checks the claim against the outcome.
 */
import { describe, it, expect } from 'vitest';
import { renderForChannel } from '../src/services/knowledge/channelRenderer';
import {
  brainAnswerSurvivesReceipt,
  isUsableBrainProse,
  verifyUpdateProse,
  __DUE_DATE_CLAIM_RE,
} from '../src/services/knowledge/answerReceiptPolicy';

const RECEIPT = 'Updated "Define rules for Brain\'s responsiveness to new vs. existing contacts": priority=high.';
/** The sentence the owner should have received, verbatim from the iter-07 log. */
const THE_PROSE = "Got it. I've marked that as high priority. Still needs a due date if you have one.";

function wa(answer: string, actionResult: any = null): string {
  return renderForChannel(
    {
      answer,
      citedPageIds: [],
      gaps: [],
      sources: [],
      action: null,
      actionResult,
    } as any,
    'whatsapp',
  ).body;
}

describe('DEF-145 — the renderer stops overriding the answer with the receipt', () => {
  describe('the layer that decides what the owner reads', () => {
    it('sends Brain\'s prose to WhatsApp, not the receipt', () => {
      // The assertion that would have failed before this commit, and the one
      // whose absence let DEF-144 measure as a no-op.
      // DEF-146 made the receipt the default again; DEF-147 replaced its
      // boolean with a token only `verifyUpdateProse` can mint. This is the
      // real shape of a verified `update_open_item` result.
      const body = wa(THE_PROSE, {
        ok: true, message: RECEIPT, artifactId: 'item-b04',
        verifiedProse: verifyUpdateProse(THE_PROSE, {
          artifactTitle: "Define rules for Brain's responsiveness to new vs. existing contacts",
          appliedPriority: 'high', appliedDueDate: false, appliedStatus: null,
          requestedButNotApplied: [],
        }),
      });
      expect(body).toBe(THE_PROSE);
      expect(body, 'the deadline question is the whole point of B04').toContain('due date');
      expect(body).not.toContain('priority=high');
    });

    it('web was already a pass-through and still is', () => {
      const rendered = renderForChannel(
        { answer: THE_PROSE, citedPageIds: [], gaps: [], sources: [], action: null,
          actionResult: { ok: true, message: RECEIPT } } as any,
        'web',
      );
      expect(rendered.body).toBe(THE_PROSE);
    });

    it('falls back to the receipt when the answer is a bracketed marker', () => {
      // Markers belong to answerSanitizer. On a SUCCESSFUL action the receipt
      // is the better body, and this is the fallback DEF-144's predicate exists
      // to provide.
      const body = wa('[update_open_item: no recognised fields to update]', { ok: true, message: RECEIPT });
      expect(body).toBe(RECEIPT);
    });

    it('falls back to the receipt when the answer is a stub', () => {
      expect(wa('Done.', { ok: true, message: RECEIPT })).toBe(RECEIPT);
      expect(wa('   ', { ok: true, message: RECEIPT })).toBe(RECEIPT);
    });

    it('never surfaces a FAILED action\'s message — the 2026-05-20 sentinel leak', () => {
      // The ok===true gate is untouched. A failed action's message is internal;
      // the owner gets Brain's answer instead.
      const body = wa(THE_PROSE, { ok: false, message: 'empty_promise_blocked' });
      expect(body).toBe(THE_PROSE);
      expect(body).not.toContain('empty_promise_blocked');
    });

    it('still strips markdown and still trims — compression is unchanged', () => {
      const body = wa('**Bold** and `code` here, plus a real sentence to clear the floor.');
      expect(body).toBe('*Bold* and code here, plus a real sentence to clear the floor.');
    });
  });

  describe('claim versus outcome — Codex risk #1, now that prose is visible', () => {
    it('keeps the receipt when the answer claims a deadline that was not written', () => {
      // The exact case from the review: only priority was applied.
      const claim = "I've set the priority to high and the deadline to Friday.";
      expect(brainAnswerSurvivesReceipt(claim, { appliedFields: ['priority'] })).toBe(false);
    });

    it('allows the same sentence when the due date WAS written', () => {
      const claim = "I've set the priority to high and the deadline to Friday.";
      expect(brainAnswerSurvivesReceipt(claim, { appliedFields: ['priority', 'dueDate'] })).toBe(true);
    });

    it('does not mistake ASKING for a deadline for claiming one', () => {
      // This is the sentence DEF-144 exists to preserve; a claim-detector that
      // swallowed it would undo the whole fix.
      expect(brainAnswerSurvivesReceipt(THE_PROSE, { appliedFields: ['priority'] })).toBe(true);
    });

    const notClaims: Array<[string, string]> = [
      ['a direct question', 'Do you have a deadline for this?'],
      ['a request for one', 'Still needs a due date — when would you like it?'],
      ['stating there is none', "There's no deadline on it yet."],
      ['priority only', "Got it. I've set the priority to high."],
    ];
    for (const [label, sentence] of notClaims) {
      it(`treats ${label} as not a completion claim`, () => {
        expect(__DUE_DATE_CLAIM_RE.test(sentence)).toBe(false);
      });
    }

    const claims: Array<[string, string]> = [
      ['set the deadline', "I've set the deadline to Friday."],
      ['set the due date', "I've set the due date to next Monday."],
      ['added a deadline', "I've added a deadline of Friday."],
      ['stative is now', 'The deadline is now Friday.'],
      ['curly apostrophe', "I’ve set the deadline to Friday."],
    ];
    for (const [label, sentence] of claims) {
      it(`catches "${label}"`, () => {
        expect(__DUE_DATE_CLAIM_RE.test(sentence)).toBe(true);
      });
    }
  });

  describe('one definition, shared', () => {
    it('the renderer and the composer use the same predicate', async () => {
      // Not a source-text check: both modules are imported and the identity of
      // the function is compared. A divergent copy would fail this.
      const composer = await import('../src/services/knowledge/brainComposer');
      const policy = await import('../src/services/knowledge/answerReceiptPolicy');
      expect(composer.brainAnswerSurvivesReceipt).toBe(policy.brainAnswerSurvivesReceipt);
      expect(composer.isUsableBrainProse).toBe(policy.isUsableBrainProse);
    });

    it('fails closed on an empty outcome', () => {
      // No information about what was applied → a deadline claim cannot be
      // justified, so the receipt wins.
      expect(brainAnswerSurvivesReceipt("I've set the deadline to Friday.", {})).toBe(false);
      // …but ordinary prose with nothing to verify still stands.
      expect(isUsableBrainProse(THE_PROSE)).toBe(true);
      expect(brainAnswerSurvivesReceipt(THE_PROSE, {})).toBe(true);
    });
  });
});
