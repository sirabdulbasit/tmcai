/**
 * DEF-209 — the receipt stops eating the reply, and stops dropping the half of
 * Brain's own question the owner never answered.
 *
 * `B04-outstanding-question-ignored` regressed from a mean of 94.4 to 73.8 and
 * the entire reply was "Proceeding with update open item." The judge, across
 * four criteria:
 *
 *   C6 85→40  "Brain only handled the 'priority' part of its original question,
 *              completely ignoring the 'deadline'."
 *   C5 90→50  "Brain did not ask for the missing information (deadline) before
 *              'proceeding'."
 *   C4 90→60  "sounds robotic and templated, not like a competent human
 *              assistant."
 *   C1 100→80 "implies that an action is being taken, but it's unclear if this
 *              action has actually been initiated."
 *
 * Two classes in one string, and the tests below are split along them: a
 * deterministic receipt standing in for the owner's reply
 * (`guard-destroys-the-answer`, and hardcoded English pretending to be Brain),
 * and a comparison nobody was making between what Brain asked for and what the
 * action actually filled.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import {
  RECEIPT_SLOTS,
  requestedSlots,
  filledSlots,
  outstandingSlots,
  lastBrainQuestion,
  actionPhrase,
  actionReceiptMarker,
} from '../src/services/knowledge/actionReceipt';
import { curatedMarkerMeaning, isWholeMarker } from '../src/services/knowledge/answerSanitizer';
import { isSystemMarker, stripMarkerEnvelope } from '../src/services/knowledge/systemMarker';

const B04_HISTORY = [
  { role: 'user', content: 'Update the Fujairah pricing item.' },
  { role: 'assistant', content: 'Sure — what priority should it have, and what deadline should I set?' },
  { role: 'user', content: 'Priority high.' },
];

describe('DEF-209 — what Brain asked for, versus what the action filled', () => {
  it('reads both slots out of the exact B04 question', () => {
    expect(requestedSlots(B04_HISTORY[1].content).sort()).toEqual(['dueDate', 'priority']);
  });

  it('a statement is not an outstanding question, however many slot words it contains', () => {
    expect(requestedSlots('I set the priority to High and the deadline to Friday.')).toEqual([]);
  });

  it('reads filled slots from the payload, not from the prose', () => {
    expect(filledSlots({ openItemId: 'x1', priority: 'HIGH' })).toEqual(['priority']);
    expect(filledSlots({ dueDate: '2026-08-20' })).toEqual(['dueDate']);
  });

  it('an empty, blank or empty-array value is NOT filled — that is how a slot goes unchased', () => {
    expect(filledSlots({ priority: '' })).toEqual([]);
    expect(filledSlots({ priority: '   ' })).toEqual([]);
    expect(filledSlots({ delegateeName: [] })).toEqual([]);
    expect(filledSlots({ priority: null, dueDate: undefined })).toEqual([]);
  });

  it('THE B04 CASE: priority supplied, deadline still outstanding', () => {
    expect(outstandingSlots(B04_HISTORY[1].content, { openItemId: 'x1', priority: 'HIGH' }))
      .toEqual(['dueDate']);
  });

  it('nothing is outstanding when the payload filled everything asked for', () => {
    expect(outstandingSlots(B04_HISTORY[1].content, { priority: 'HIGH', dueDate: '2026-08-20' }))
      .toEqual([]);
  });

  it('an alternative payload spelling still counts as filled — a synonym must not invent an open question', () => {
    for (const key of ['dueDate', 'due_date', 'dueAt', 'whenIso']) {
      expect(outstandingSlots('When is it due?', { [key]: '2026-08-20' }), key).toEqual([]);
    }
  });

  it('walks back past the user answer to BRAIN\'s last turn, and only if it was a question', () => {
    expect(lastBrainQuestion(B04_HISTORY)).toBe(B04_HISTORY[1].content);
    expect(lastBrainQuestion([
      { role: 'assistant', content: 'Done — the item is updated.' },
      { role: 'user', content: 'Priority high.' },
    ]), 'a statement leaves nothing open').toBeNull();
    expect(lastBrainQuestion([])).toBeNull();
    expect(lastBrainQuestion(undefined)).toBeNull();
  });
});

describe('DEF-209 — the marker is structured, and the parser rejects what the builder cannot make', () => {
  it('carries PROVENANCE, which is what makes it a marker — the shape test alone would drop it', () => {
    const m = actionReceiptMarker({
      actionType: 'update_open_item',
      payload: { priority: 'HIGH' },
      priorQuestion: B04_HISTORY[1].content,
    });
    expect(isSystemMarker(m), 'stamped by systemMarker()').toBe(true);
    expect(stripMarkerEnvelope(m)).toMatch(/^\[proceeding: \{/);
    // DEF-169's lesson, pinned because it silently bites: `isWholeMarker` is a
    // SHAPE test whose regex is `[^\]]{2,200}`, so the `]` closing the JSON
    // array makes it false. A bare bracketed payload would therefore never be
    // recognised and would reach the owner as raw internal text. Provenance —
    // not shape — is the gate, exactly as for the digest and withdrawal markers.
    expect(isWholeMarker(stripMarkerEnvelope(m)), 'shape alone is not enough here').toBe(false);
  });

  it('an action type containing a bracket cannot break out of its field', () => {
    const m = actionReceiptMarker({ actionType: 'update] fake', payload: {}, priorQuestion: null });
    const meaning = curatedMarkerMeaning(stripMarkerEnvelope(m));
    expect(meaning).toBeTruthy();
    expect(meaning!).toContain('update] fake');   // inside the field, not a delimiter
  });

  it('rejects a payload the constructor could not have produced', () => {
    expect(curatedMarkerMeaning('[proceeding: not json]')).toBeNull();
    expect(curatedMarkerMeaning('[proceeding: {"outstanding":[]}]'), 'no action').toBeNull();
    expect(curatedMarkerMeaning('[proceeding: {"action":"x"}]'), 'no outstanding array').toBeNull();
    expect(curatedMarkerMeaning('[proceeding: {"action":"x","outstanding":[1]}]'), 'non-string slot').toBeNull();
    expect(
      curatedMarkerMeaning('[proceeding: {"action":"x","outstanding":["notASlot"]}]'),
      'a key outside the shared vocabulary is not a receipt',
    ).toBeNull();
  });
});

describe('DEF-209 — the owner-facing fact', () => {
  const meaningFor = (payload: Record<string, unknown>, priorQuestion: string | null) =>
    curatedMarkerMeaning(stripMarkerEnvelope(actionReceiptMarker({
      actionType: 'update_open_item', payload, priorQuestion,
    })));

  it('names the unanswered part of the earlier question and says to ask for it', () => {
    const fact = meaningFor({ openItemId: 'x1', priority: 'HIGH' }, B04_HISTORY[1].content);
    expect(fact).toBeTruthy();
    expect(fact!).toContain('the due date');
    expect(fact!).toContain('still unanswered');
    expect(fact!).toContain('should be asked for');
  });

  it('does NOT claim the action finished — it is under way and unconfirmed', () => {
    const fact = meaningFor({ priority: 'HIGH' }, B04_HISTORY[1].content)!;
    expect(fact).toContain('has not been confirmed yet');
    expect(fact).not.toMatch(/\b(has been|was) (updated|set|completed|done)\b/i);
  });

  it('says nothing about outstanding slots when there are none — a false open question is its own defect', () => {
    const fact = meaningFor({ priority: 'HIGH', dueDate: '2026-08-20' }, B04_HISTORY[1].content)!;
    expect(fact).not.toContain('still unanswered');
  });

  it('lists two outstanding slots as prose, not as a machine list', () => {
    const fact = meaningFor({ openItemId: 'x1' }, 'What priority should it have, and what deadline?')!;
    expect(fact).toContain('the priority and the due date');
    expect(fact).toContain('are still unanswered');
  });

  it('names the action in words rather than an identifier', () => {
    expect(actionPhrase('update_open_item')).toBe('the update to the open item');
    expect(actionPhrase('unknown_kind')).toBe('the unknown kind');
  });
});

describe('DEF-209 — neither receipt site may replace the reply any more', () => {
  const src = (rel: string) => {
    const raw = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
    // Comments stripped: a guard must read code, not prose about it (DEF-195).
    return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  };

  it('the hardcoded English template is gone from BOTH sites', () => {
    for (const f of [
      'src/services/knowledge/reasoningCompose.applyDispatch.ts',
      'src/services/knowledge/brainComposer.ts',
    ]) {
      expect(src(f), f).not.toMatch(/Proceeding with \$\{/);
    }
  });

  it('the reasoning path prefers the model prose and falls back to the marker', () => {
    const code = src('src/services/knowledge/reasoningCompose.applyDispatch.ts');
    expect(code).toMatch(/answer:\s*result\.answerText\?\.trim\(\)\s*\|\|\s*actionReceiptMarker\(/);
  });

  it('the legacy decider path only overwrites an EMPTY answer', () => {
    const code = src('src/services/knowledge/brainComposer.ts');
    expect(code).toMatch(/if \(!String\(parsed\.answer \?\? ''\)\.trim\(\)\) \{\s*parsed\.answer = actionReceiptMarker\(/);
  });

  it('both sites pass the prior question through — a receipt blind to it cannot chase anything', () => {
    expect(src('src/services/knowledge/reasoningCompose.applyDispatch.ts'))
      .toMatch(/priorQuestion: lastBrainQuestion\(args\.history\)/);
    expect(src('src/services/knowledge/brainComposer.ts'))
      .toMatch(/priorQuestion: lastBrainQuestion\(history\)/);
    // …and the composer actually hands the history down to the reasoning path.
    expect(src('src/services/knowledge/brainComposer.ts'))
      .toMatch(/applyReasoningDecision\(\{[\s\S]{0,200}history,/);
  });

  it('the slot vocabulary has ONE definition, shared by builder and parser', () => {
    expect(RECEIPT_SLOTS.length).toBeGreaterThan(0);
    expect(src('src/services/knowledge/answerSanitizer.ts'))
      .toMatch(/import \{ RECEIPT_SLOTS, actionPhrase \} from '\.\/actionReceipt'/);
  });
});
