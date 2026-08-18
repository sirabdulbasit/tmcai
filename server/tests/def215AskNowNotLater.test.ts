/**
 * DEF-215 — "should be asked for" licensed a deferral, and B04 took it.
 *
 * `iter-08-post-build.json`, B04:
 *
 *     "Got it. I've set the priority to high. I'll ask for a due date if one
 *      becomes necessary."
 *
 *   C6 75  "Brain had previously asked for both 'priority and deadline'. The
 *           response only addresses the priority."
 *   C5 80  "it still has an open question about the deadline from its previous
 *           turn, and inste[ad]…"
 *
 * The run before, the same case read *"OK, I've set the priority to high. When
 * is it due?"* — so this is not the old drop-it-silently defect returning. It is
 * a NEW hedge, and it came out of MY OWN fact sentence: DEF-209 and DEF-212 both
 * ended the outstanding-slot fact with *"and should be asked for"*, which reads
 * as a standing intention rather than an instruction about THIS reply. The model
 * obeyed it in the future tense and made it conditional.
 *
 * A fact that describes asking is not the same as a fact that requires the
 * question now, and the difference is the whole defect.
 */

import { describe, it, expect } from 'vitest';

import { actionReceiptMarker, actionAppliedMarker } from '../src/services/knowledge/actionReceipt';
import { curatedMarkerMeaning } from '../src/services/knowledge/answerSanitizer';
import { stripMarkerEnvelope } from '../src/services/knowledge/systemMarker';

const B04_QUESTION = 'Sure — what priority should it have, and what deadline should I set?';
const TITLE = "Define rules for Brain's responsiveness";

const meaningOf = (m: string) => curatedMarkerMeaning(stripMarkerEnvelope(m))!;

const proceeding = () => meaningOf(actionReceiptMarker({
  actionType: 'update_open_item',
  payload: { openItemId: 'x1', priority: 'HIGH' },
  priorQuestion: B04_QUESTION,
}));

// DEF-220 superseded the payload: the marker carries the applied FIELDS, not
// the rendered receipt. The property this file defends — the fact demands the
// unanswered slot in THIS reply — is unchanged, so only the constructor moved.
const applied = () => meaningOf(actionAppliedMarker({
  title: TITLE, applied: [{ f: 'priority', v: 'high' }], outstanding: ['dueDate'],
}));

describe('DEF-215 — the fact requires the question NOW, on both markers', () => {
  for (const [name, fact] of [['proceeding', proceeding], ['applied', applied]] as const) {
    it(`${name}: says to ask in this reply`, () => {
      expect(fact()).toContain('ASK FOR IT IN THIS REPLY');
    });

    it(`${name}: forbids the two hedges B04 actually produced`, () => {
      // "I'll ask for a due date IF ONE BECOMES NECESSARY" is both at once:
      // deferred to a later turn, and made conditional.
      expect(fact()).toContain('do not promise to ask later');
      expect(fact()).toContain('do not\nmake it conditional');
    });

    it(`${name}: no longer carries the phrase that licensed the deferral`, () => {
      expect(fact(), 'a standing intention, not an instruction about this reply')
        .not.toContain('should be asked for');
    });

    it(`${name}: still names the slot and still says it is unanswered`, () => {
      expect(fact()).toContain('the due date');
      expect(fact()).toContain('still unanswered');
    });

    it(`${name}: credits what he DID answer, so the ask does not read as a repeat`, () => {
      expect(fact()).toContain('He answered part of what you asked');
    });
  }

  it('says nothing about asking when nothing is outstanding', () => {
    const fact = meaningOf(actionAppliedMarker({
      title: TITLE, applied: [{ f: 'priority', v: 'high' }],
    }));
    // DEF-220: this branch used to return the rendered receipt verbatim. It is
    // now the composed fact, and it still must not invent an open question.
    expect(fact).toBe(`The open item "${TITLE}" was updated: its priority is now high.`);
    expect(fact).not.toContain('ASK FOR IT');
  });
});
