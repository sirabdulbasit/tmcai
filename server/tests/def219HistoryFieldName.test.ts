/**
 * DEF-219 — three fixes were dead on arrival on one field name.
 *
 * `B04-outstanding-question-ignored` C6 **70** in `iter-10-post-build.json`, and
 * the reply is the string DEF-212 was written to eliminate:
 *
 *     Updated "Define rules for Brain's responsiveness to new vs. existing
 *     contacts": priority=high.
 *
 * > "The response only addresses the 'priority' part of Brain's previous
 * >  question, leaving the 'deadline' outstanding without mentioning that it's
 * >  still needed."
 *
 * ROOT CAUSE. The composer's history turn is
 * `ComposerHistoryTurn = { role: 'user' | 'brain' | 'artifact'; text: string }`.
 * `lastBrainQuestion` read `t.content` — **undefined on every real call**. So
 * `String(undefined)` became `"undefined"`, `isQuestionTurn` said no, and the
 * function returned null in production, always. Downstream:
 *
 *   - `requestedSlots(null)` → `[]` → `outstandingSlots` → `[]`;
 *   - DEF-209's proceeding marker names no slot;
 *   - DEF-212's applied marker takes its no-slots branch, which returns the
 *     receipt VERBATIM — so the owner reads `Updated "…": priority=high.`, the
 *     exact field-name string DEF-144 and DEF-145 were written about;
 *   - DEF-215's "ASK FOR IT IN THIS REPLY" can never fire.
 *
 * WHY MY TESTS MISSED IT, which matters more than the typo: every fixture in
 * def209/def211/def215 was a hand-built `{ role, content }` object. **A fixture
 * I invent cannot disagree with me.** These tests import the composer's real
 * exported type, so a future rename breaks the build instead of the behaviour.
 */

import { describe, it, expect } from 'vitest';

import { lastBrainQuestion, outstandingSlots } from '../src/services/knowledge/actionReceipt';
import { actionAppliedMarker } from '../src/services/knowledge/actionReceipt';
import { curatedMarkerMeaning } from '../src/services/knowledge/answerSanitizer';
import { stripMarkerEnvelope } from '../src/services/knowledge/systemMarker';
// The REAL type the composer passes. If `text` is ever renamed, this import
// stops compiling — which is the guarantee the invented fixtures never gave.
import type { ComposerHistoryTurn } from '../src/services/knowledge/brainComposer';

/** B04, in the composer's own shape. */
const B04_HISTORY: ComposerHistoryTurn[] = [
  { role: 'user', text: 'Update the Fujairah pricing item.' },
  { role: 'brain', text: 'Sure — what priority should it have, and what deadline should I set?' },
  { role: 'user', text: 'Priority high.' },
];

describe('DEF-219 — the composer\'s real history shape', () => {
  it('THE DEFECT: reads `text`, the field the composer actually sets', () => {
    expect(lastBrainQuestion(B04_HISTORY)).toBe(B04_HISTORY[1].text);
  });

  it('still reads `content` for producers that use that key', () => {
    expect(lastBrainQuestion([
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'What priority should it have?' },
    ])).toBe('What priority should it have?');
  });

  it('a turn with NEITHER key is not a question — never the string "undefined"', () => {
    // The old code did String(undefined) === "undefined", which is why the bug
    // was silent rather than loud.
    expect(lastBrainQuestion([{ role: 'brain' } as ComposerHistoryTurn])).toBeNull();
    expect(lastBrainQuestion([{ role: 'brain', text: 'undefined' }])).toBeNull();
  });

  it('walks back past the user answer, and only reports a question', () => {
    expect(lastBrainQuestion([
      { role: 'brain', text: 'Done — the item is updated.' },
      { role: 'user', text: 'Priority high.' },
    ])).toBeNull();
    expect(lastBrainQuestion([])).toBeNull();
    expect(lastBrainQuestion(undefined)).toBeNull();
  });
});

describe('DEF-219 — what the three dead fixes now do', () => {
  it('B04: the deadline is finally seen as outstanding', () => {
    expect(outstandingSlots(lastBrainQuestion(B04_HISTORY), { openItemId: 'x1', priority: 'HIGH' }))
      .toEqual(['dueDate']);
  });

  it('B04: the applied receipt stops rendering as the bare field-name string', () => {
    const outstanding = outstandingSlots(
      lastBrainQuestion(B04_HISTORY), { openItemId: 'x1', priority: 'HIGH' });
    const receipt = 'Updated "Define rules for Brain\'s responsiveness": priority=high.';
    const fact = curatedMarkerMeaning(stripMarkerEnvelope(
      actionAppliedMarker({ receipt, outstanding })))!;

    expect(fact, 'the receipt still travels, verbatim').toContain(receipt);
    expect(fact, 'and now so does the open half').toContain('the due date');
    expect(fact).toContain('ASK FOR IT IN THIS REPLY');
    expect(fact).not.toBe(receipt);
  });

  it('with the OLD `content` read, every one of those is empty — the regression, pinned', () => {
    // Exactly what production was doing: the composer's turns have no `content`.
    const asOldCodeSawIt = B04_HISTORY.map((t) => ({ role: t.role, content: undefined }));
    expect(lastBrainQuestion(asOldCodeSawIt)).toBeNull();
    expect(outstandingSlots(lastBrainQuestion(asOldCodeSawIt), { priority: 'HIGH' })).toEqual([]);
    const receipt = 'Updated "x": priority=high.';
    expect(
      curatedMarkerMeaning(stripMarkerEnvelope(actionAppliedMarker({ receipt, outstanding: [] }))),
      'the no-slots branch returns the receipt verbatim — what B04 actually read',
    ).toBe(receipt);
  });
});
