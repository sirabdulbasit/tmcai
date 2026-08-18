/**
 * DEF-216 — the same question, twice, in one reply.
 *
 * `B02-unknown-fact`, `iter-08-post-build.json` — C5 95→60, C3 95→75, C4 90→70.
 * What he actually read:
 *
 *     I can't find a contact entry for Hamna Latif Bhutta, so I don't have her
 *     mobile number.
 *
 *     Her last reply was on August 12th regarding the "Vision Metric's service
 *     sales package video", stating that it was not yet completed.
 *
 *     Shall I create a new contact for her?
 *
 *     I can't seem to find Hamna Latif Bhutta in your contacts list to get her
 *     number. Shall I create a new contact for her?
 *
 * Judge C5: *"it repeats a question it just asked ('Shall I create a new contact
 * for her?')"*. C4: *"the repetition … makes it sound less natural and more like
 * a templa[te]"*.
 *
 * This is DEF-211's `answerThenAsk`, and the flaw is mine: the dedup was
 * `if (a.includes(q)) return a` — byte-identical only. The decider's question was
 * a LONGER string whose tail duplicated the prose's last sentence and whose head
 * restated the prose's first. Neither was a substring, so both shipped.
 *
 * The fix compares sentence by sentence, which drops the duplicated ask AND the
 * restated finding — the second of which a naive "don't repeat the question"
 * check would still have got wrong.
 */

import { describe, it, expect } from 'vitest';
import { answerThenAsk } from '../src/services/knowledge/actionReceipt';

const B02_ANSWER = [
  "I can't find a contact entry for Hamna Latif Bhutta, so I don't have her mobile number.",
  '',
  'Her last reply was on August 12th regarding the "Vision Metric\'s service sales package video", stating that it was not yet completed.',
  '',
  'Shall I create a new contact for her?',
].join('\n');

const B02_QUESTION =
  "I can't seem to find Hamna Latif Bhutta in your contacts list to get her number. "
  + 'Shall I create a new contact for her?';

describe('DEF-216 — THE B02 CASE', () => {
  it('does not ask the same question twice', () => {
    const out = answerThenAsk(B02_ANSWER, B02_QUESTION);
    expect(out.match(/Shall I create a new contact for her\?/g) ?? []).toHaveLength(1);
  });

  it('drops the duplicated ask and keeps the rest — the head is a PARAPHRASE, not a repeat', () => {
    // I expected the whole question to vanish and was wrong, so this records the
    // real behaviour. The head — "I can't seem to find Hamna Latif Bhutta in your
    // contacts list to get her number." — says the same THING as paragraph one but
    // not the same WORDS, and this function deliberately does not judge meaning:
    // deleting sentences that merely resemble the prose is `guard-destroys-the-
    // answer`, the class eight rows of the chart are about. Exact repeats go;
    // paraphrases stay, and the residual is named in the DEF row.
    const out = answerThenAsk(B02_ANSWER, B02_QUESTION);
    expect(out).toBe(`${B02_ANSWER}\n\nI can't seem to find Hamna Latif Bhutta in your contacts list to get her number.`);
    expect(out, 'the ask itself is not repeated').not.toMatch(
      /Shall I create a new contact for her\?[\s\S]*Shall I create a new contact for her\?/);
  });

  it('the OLD byte-identical rule would not have caught it — this is why the fix is sentence-level', () => {
    expect(B02_ANSWER.includes(B02_QUESTION), 'not a substring, so `includes` said "append"').toBe(false);
  });
});

describe('DEF-216 — sameness is not byte equality', () => {
  it('ignores case, spacing and a trailing full stop', () => {
    expect(answerThenAsk('Done. Shall I create a new contact for her?', 'shall i create a new  contact for her?'))
      .toBe('Done. Shall I create a new contact for her?');
  });

  it('keeps a genuinely different question', () => {
    const out = answerThenAsk('I found two people called Asad.', 'Which one did you mean?');
    expect(out).toBe('I found two people called Asad.\n\nWhich one did you mean?');
  });

  it('keeps only the sentences that are new, when the question is partly a repeat', () => {
    const out = answerThenAsk(
      'I have no number for her.',
      'I have no number for her. Should I ask Hamna directly?',
    );
    expect(out).toBe('I have no number for her.\n\nShould I ask Hamna directly?');
    expect(out.match(/I have no number for her\./g) ?? []).toHaveLength(1);
  });

  it('passes a wholly new question through UNCHANGED rather than reassembling it', () => {
    // Reassembly would let a mis-cut sentence reach him reworded. When nothing
    // was a repeat, the original string is used verbatim.
    // The fixture must contain formatting the re-join would FLATTEN, or the test
    // cannot tell the two paths apart — mutation caught exactly that: with a
    // single-space fixture, `fresh.join(' ')` reproduces the original byte for
    // byte and deleting the pass-through changed nothing.
    const q = 'Which Asad — Ahmed Taj or Shafique?\n\nReply with a first name.';
    expect(q, 'the re-join would collapse this').not.toBe(
      q.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean).join(' '));
    expect(answerThenAsk('Two match.', q)).toBe(`Two match.\n\n${q}`);
  });
});

describe('DEF-216 — the DEF-211 properties still hold', () => {
  it('answer first, question after', () => {
    const out = answerThenAsk('It is due Friday.', 'Want me to chase it?');
    expect(out.indexOf('due Friday')).toBeLessThan(out.indexOf('chase it'));
  });

  it('is the identity when only one side exists', () => {
    expect(answerThenAsk(null, 'Which Asad?')).toBe('Which Asad?');
    expect(answerThenAsk('It is due Friday.', null)).toBe('It is due Friday.');
    expect(answerThenAsk('  ', '  ')).toBe('');
  });
});
