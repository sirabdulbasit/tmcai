/**
 * DEF-211 — a clarifying question must not DELETE the answer.
 *
 * `B03-pronoun-followup` C5 95 -> 75. The whole reply was:
 *
 *     "When you say 'what about it', are you asking for more details, or do you
 *      want me to take an action regarding the Q3 headcount plan?"
 *
 * Judge: *"Brain asks for clarification, which is appropriate for a vague query.
 * However, it could have made an intelligent guess and offered information
 * first."* It could have — the subject was resolved well enough to be NAMED in
 * the question.
 *
 * Three things had to change together, and the middle one is why the previous
 * two turns of this class did not reach the surface:
 *
 *   1. `applyReasoningDecision`'s `ask` case returned `question.text` and
 *      ignored `answerText` entirely — the THIRD branch of that function to
 *      destroy prose (DEF-205/206 fixed decline, DEF-209 fixed act);
 *   2. the reasoning CONTRACT said "exactly ONE of {action, action_plan,
 *      question, answer_text} is non-null", which made answering-then-asking
 *      literally unrepresentable. Repairing the renderer alone would have been a
 *      guaranteed no-op: the decider was instructed never to fill both;
 *   3. the legacy decider's `missingSlot` arm — three lines below the arm
 *      DEF-209 repaired — overwrote the composed prose with a slot prompt.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { answerThenAsk } from '../src/services/knowledge/actionReceipt';
import { curatedMarkerMeaning } from '../src/services/knowledge/answerSanitizer';

const src = (rel: string) => {
  const raw = fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
  // Comments stripped: a guard must read code, not prose about it (DEF-195).
  return raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
};

describe('DEF-211 — the answer comes first, the question after', () => {
  it('keeps BOTH, in that order', () => {
    const out = answerThenAsk(
      "He's still waiting on the Q3 headcount plan — it's due Friday and unassigned.",
      'Did you want the detail, or should I chase it?',
    );
    expect(out.indexOf('Q3 headcount plan')).toBeLessThan(out.indexOf('Did you want'));
    expect(out).toContain('\n\n');
  });

  it('is the identity when only one side exists — it never invents the other', () => {
    expect(answerThenAsk(null, 'Which Asad?')).toBe('Which Asad?');
    expect(answerThenAsk('It is due Friday.', null)).toBe('It is due Friday.');
    expect(answerThenAsk('  ', '  ')).toBe('');
  });

  it('does not say the question twice when the prose already ends with it', () => {
    const q = 'Which Asad — Ahmed Taj or Shafique?';
    expect(answerThenAsk(`Two contacts match. ${q}`, q)).toBe(`Two contacts match. ${q}`);
  });
});

describe('DEF-211 — the ask branch stopped discarding answerText', () => {
  const code = src('src/services/knowledge/reasoningCompose.applyDispatch.ts');

  it('composes the answer with the question instead of returning the question alone', () => {
    expect(code).toMatch(/answer:\s*answerThenAsk\(result\.answerText,\s*q\?\.text\)/);
    expect(code, 'the old question-only form is gone').not.toMatch(/answer:\s*q\?\.text\s*\|\|/);
  });

  it('the hardcoded English fallback is gone from that branch', () => {
    expect(code).not.toMatch(/I need one more detail before I can proceed/);
    expect(code).toMatch(/\[clarification needed:/);
  });

  it('the last-resort marker has a curated meaning, so it is never published raw', () => {
    const meaning = curatedMarkerMeaning(
      '[clarification needed: the decider asked for a detail but supplied no question text]');
    expect(meaning).toBeTruthy();
    expect(meaning!).not.toContain('decider');   // internal wording never reaches him
    expect(meaning!.toLowerCase()).toContain('detail');
  });
});

describe('DEF-211 — the contract can now represent answering AND asking', () => {
  const contract = fs.readFileSync(
    path.resolve(__dirname, '..', 'src/services/knowledge/reasoningCompose.ts'), 'utf8');

  it('answer_text is NO LONGER in the mutual-exclusion set', () => {
    // This is the load-bearing half. With answer_text inside the exclusion, a
    // decider that obeyed the contract could never fill both, so the renderer
    // repair alone could not fire even once.
    expect(contract).not.toMatch(/Exactly ONE of \{action, action_plan, question, answer_text\}/);
    expect(contract).toMatch(/Exactly ONE of \{action, action_plan, question\} is non-null/);
    expect(contract).toMatch(/answer_text is NOT in that exclusion/);
  });

  it('the ask guidance tells the decider to say what it knows first', () => {
    expect(contract).toMatch(/ANSWER WHAT YOU ALREADY KNOW BEFORE YOU ASK/);
    expect(contract).toMatch(/decision='ask' fills question AND[^\n]*answer_text/);
  });
});

describe('DEF-211 — the legacy missingSlot arm stopped overwriting prose', () => {
  const code = src('src/services/knowledge/brainComposer.ts');

  it('appends the slot prompt to the surviving answer rather than replacing it', () => {
    expect(code).toMatch(
      /parsed\.answer = answerThenAsk\(parsed\.answer, renderMissingSlotPrompt\(null, decision\.missingSlot\)\)/);
    expect(code, 'the unconditional overwrite is gone')
      .not.toMatch(/parsed\.answer = renderMissingSlotPrompt\(null, decision\.missingSlot\);/);
  });

  it('BOTH arms of that if/else now preserve the reply — the pair is the point', () => {
    // DEF-209 fixed `decision.action`; this fixed its sibling. A guard that only
    // checks one arm is how the second one survived a whole iteration.
    expect(code).toMatch(/if \(!String\(parsed\.answer \?\? ''\)\.trim\(\)\) \{\s*parsed\.answer = actionReceiptMarker\(/);
    expect(code).toMatch(/parsed\.answer = answerThenAsk\(parsed\.answer, renderMissingSlotPrompt/);
  });

  it('there is ONE implementation of the composition, imported by both sites', () => {
    for (const f of [
      'src/services/knowledge/brainComposer.ts',
      'src/services/knowledge/reasoningCompose.applyDispatch.ts',
    ]) {
      expect(src(f), f).toMatch(/import \{[^}]*answerThenAsk[^}]*\} from '\.\/actionReceipt'/);
    }
  });
});
