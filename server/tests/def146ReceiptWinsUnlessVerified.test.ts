/**
 * DEF-146 — DEF-145 fixed B04 by trusting the model everywhere.
 *
 * DEF-145 inverted `channelRenderer`'s preference and it worked: B04's reply
 * changed from `Updated "…": priority=high.` to *"Got it. I've set the priority
 * to high. It's still missing a due date if you have one in mind."*, moving that
 * case C6 75 → 90, C7 80 → 100, C4 90 → 95, C3 85 → 90.
 *
 * It also inverted the preference for **every** action, while only
 * `update_open_item` compared its prose against what was actually written.
 * Codex called that CRITICAL and it was:
 *
 *     Gmail sends to a@example.com. The receipt holds the real recipient and
 *     message id. The model says "I've emailed A and B and copied the finance
 *     team." → the receipt is discarded → WhatsApp ships the invented
 *     recipients and the truth is hidden in `actionResult`.
 *
 * Contacts, meetings, delegations and WhatsApp sends all had the same hole. That
 * is invariant #5 — no fabricated completion — weakened across every action
 * class at once, on the surface the owner actually reads.
 *
 * WHY NO SCORE CAUGHT IT, which is the part worth keeping: **B04 is the only one
 * of the twelve benchmark cases that dispatches an action.** The other eleven
 * never produce an `actionResult`, so the global preference was exercised
 * exactly once — on the single case where it happened to be verified. The
 * regression was real, shipped, and structurally invisible to this loop's
 * instrument. Overall even rose, 94.4 → 95.3. Benchmark-clean is not safe.
 *
 * The fix inverts the default back: the receipt wins unless the branch that did
 * the write proves it verified the prose. DEF-147 then replaced the opt-in
 * boolean with a token only the verifier can mint, because a boolean is a
 * capability anybody can assert.
 *
 * These tests are the ones Codex asked for by name: exaggerated model prose must
 * never replace the real recipient/artifact/value receipt.
 */
import { describe, it, expect } from 'vitest';
import { renderForChannel } from '../src/services/knowledge/channelRenderer';
import { receiptWins, verifyUpdateProse } from '../src/services/knowledge/answerReceiptPolicy';

/** DEF-147: a token can no longer be hand-written. Tests must mint one through
 *  the real verifier, which is the point — `proseGrounded: true` used to be
 *  assertable by anybody, including a test that proved nothing. */
function tokenFor(prose: string, artifactTitle: string, appliedPriority: string | null = 'high') {
  return verifyUpdateProse(prose, {
    artifactTitle,
    appliedPriority,
    appliedDueDate: false,
    appliedStatus: null,
    requestedButNotApplied: [],
  });
}

function wa(answer: string, actionResult: any): string {
  return renderForChannel(
    { answer, citedPageIds: [], gaps: [], sources: [], action: null, actionResult } as any,
    'whatsapp',
  ).body;
}

/** Receipts in the shape the composer's other success branches build them. */
const RECEIPTS = {
  send_email: 'Sent email to a@example.com — subject: "Q3 numbers". messageId=<abc123@mail>',
  notify_via_whatsapp: 'WhatsApp sent to Hamna Latif Bhutta (+923134199294).',
  schedule_meeting: 'Scheduled "Phoenix sync" for 2026-08-13 15:00 with asad@tmcltd.com.',
  create_contact: 'Saved Hamna Latif Bhutta (+923134199294) <hamna@tmcltd.com>.',
  delegate_open_item: 'Delegated "ShireMe Portal Testing" to Hamna Latif Bhutta <hamna@tmcltd.com>.',
  add_open_item: 'Added "Revisit Fujairah pricing" to your open items.',
  set_brain_name: 'Got it — from now on you can call me Suzi.',
};

/** Model prose that overstates or misstates each of those outcomes. */
const OVERSTATEMENTS: Record<keyof typeof RECEIPTS, string> = {
  send_email: "I've emailed A and B and copied the finance team.",
  notify_via_whatsapp: "I've messaged Hamna and Yousaf on WhatsApp for you.",
  schedule_meeting: "I've booked the Phoenix sync for Thursday and invited the whole team.",
  create_contact: "I've saved Hamna with her mobile, her email and her office line.",
  delegate_open_item: "I've delegated all four outstanding items to Hamna.",
  add_open_item: "I've added the Fujairah pricing item and set it to critical for Friday.",
  set_brain_name: "I've renamed myself Suzi and updated it everywhere.",
};

describe('DEF-146 — the receipt wins unless the branch verified the prose', () => {
  describe('every unverified action class keeps its grounded receipt', () => {
    for (const kind of Object.keys(RECEIPTS) as Array<keyof typeof RECEIPTS>) {
      it(`${kind}: exaggerated prose does not replace the receipt`, () => {
        // No token — these branches do not verify, so the owner must see the
        // text that is true by construction.
        const body = wa(OVERSTATEMENTS[kind], { ok: true, message: RECEIPTS[kind] });
        expect(body).toBe(RECEIPTS[kind]);
        expect(body, 'the fabrication must not reach WhatsApp').not.toBe(OVERSTATEMENTS[kind]);
      });
    }

    it('the send_email receipt keeps the real recipient the prose invented around', () => {
      // The exact scenario from Codex's CRITICAL finding.
      const body = wa(OVERSTATEMENTS.send_email, { ok: true, message: RECEIPTS.send_email });
      expect(body).toContain('a@example.com');
      expect(body).not.toContain('finance team');
    });
  });

  describe('the verified branch still gets its prose — B04 must not regress', () => {
    const B04_PROSE = "Got it. I've set the priority to high. It's still missing a due date if you have one in mind.";
    const B04_RECEIPT = 'Updated "Define rules for Brain\'s responsiveness to new vs. existing contacts": priority=high.';
    const B04_TITLE = "Define rules for Brain's responsiveness to new vs. existing contacts";

    it('update_open_item with a genuine token sends the prose', () => {
      const body = wa(B04_PROSE, {
        ok: true, message: B04_RECEIPT,
        verifiedProse: tokenFor(B04_PROSE, B04_TITLE),
      });
      expect(body).toBe(B04_PROSE);
      expect(body).toContain('due date');
    });

    it('the SAME result without a token sends the receipt', () => {
      // One field decides it, which is what makes the containment auditable.
      const body = wa(B04_PROSE, { ok: true, message: B04_RECEIPT });
      expect(body).toBe(B04_RECEIPT);
    });

    it('a token cannot be minted for a marker or a stub', () => {
      // The verifier refuses to mint for a marker or a stub, so there is no
      // token to present — belt and braces at both layers.
      expect(tokenFor('[update_open_item: no recognised fields to update]', B04_TITLE)).toBeNull();
      expect(wa('[update_open_item: no recognised fields to update]',
        { ok: true, message: B04_RECEIPT, verifiedProse: tokenFor('[update_open_item: no recognised fields to update]', B04_TITLE) })).toBe(B04_RECEIPT);
      expect(wa('Done.', { ok: true, message: B04_RECEIPT, verifiedProse: tokenFor('Done.', B04_TITLE) })).toBe(B04_RECEIPT);
    });
  });

  describe('what the old behaviour protected is still protected', () => {
    it('never surfaces a FAILED action message — the 2026-05-20 sentinel leak', () => {
      const prose = 'You have three items outstanding with Hamna.';
      const body = wa(prose, { ok: false, message: 'empty_promise_blocked' });
      expect(body).toBe(prose);
      expect(body).not.toContain('empty_promise_blocked');
    });

    it('an empty receipt message falls through to the prose', () => {
      const prose = 'You have three items outstanding with Hamna.';
      expect(wa(prose, { ok: true, message: '   ' })).toBe(prose);
    });

    it('no action at all leaves the answer alone', () => {
      const prose = 'Her number is +923134199294, and the item is still open.';
      expect(wa(prose, null)).toBe(prose);
    });

    it('web remains a pass-through regardless of the flag', () => {
      const rendered = renderForChannel(
        { answer: OVERSTATEMENTS.send_email, citedPageIds: [], gaps: [], sources: [], action: null,
          actionResult: { ok: true, message: RECEIPTS.send_email } } as any,
        'web',
      );
      // Web shows the composed answer; compose owns that text, and this
      // renderer has never rewritten it.
      expect(rendered.body).toBe(OVERSTATEMENTS.send_email);
    });
  });

  describe('receiptWins — the decision itself', () => {
    it('fails closed when the token is absent, null, or the wrong type', () => {
      const prose = 'A perfectly ordinary sentence about your items.';
      expect(receiptWins({ ok: true, message: 'R' }, prose)).toBe(true);
      expect(receiptWins({ ok: true, message: 'R', verifiedProse: null }, prose)).toBe(true);
      expect(receiptWins({ ok: true, message: 'R', verifiedProse: undefined }, prose)).toBe(true);
      expect(receiptWins({ ok: true, message: 'R', verifiedProse: 1 as any }, prose)).toBe(true);
    });

    it('yields to genuinely verified prose', () => {
      const prose = 'A perfectly ordinary sentence about your items.';
      expect(receiptWins({ ok: true, message: 'R', verifiedProse: tokenFor(prose, 'Some item', null) },
        prose)).toBe(false);
    });

    it('rejects a FORGED token — the DEF-146 weakness DEF-147 closes', () => {
      const prose = 'A perfectly ordinary sentence about your items.';
      // Every shape a careless branch might reach for.
      expect(receiptWins({ ok: true, message: 'R', verifiedProse: true as any }, prose)).toBe(true);
      expect(receiptWins({ ok: true, message: 'R', verifiedProse: {} as any }, prose)).toBe(true);
      expect(receiptWins({ ok: true, message: 'R', verifiedProse: { verified: true } as any }, prose)).toBe(true);
      // And one that has been through JSON, which is how a token would arrive
      // from a queue or a cache.
      const real = tokenFor(prose, 'Some item', null);
      const roundTripped = JSON.parse(JSON.stringify(real));
      expect(receiptWins({ ok: true, message: 'R', verifiedProse: roundTripped }, prose)).toBe(true);
    });

    it('has nothing to show when there is no successful receipt', () => {
      expect(receiptWins(null, 'anything at all here')).toBe(false);
      expect(receiptWins({ ok: false, message: 'R' }, 'anything at all here')).toBe(false);
    });
  });
});
