/**
 * DEF-166 — three turns, three phrasings, one defect.
 *
 * B12 asks *"Why did you remind me about that one twice?"*. What shipped:
 *
 *   iteration 17  "It looks like a system glitch caused a duplicate reminder"
 *   iteration 18  "That was a system stutter on my end"
 *   iteration 20  "I'll make sure the duplicate is cleared"
 *
 * Each iteration closed the previous wording and the model produced the next one.
 * The third carries no recurrence vocabulary, so it never reached the cure rule at
 * all. Codex's iteration-20 HIGH #1, and his conclusion is the one that matters:
 * **stop extending the cure regex.** Enumerating what a language model might say
 * is not a strategy — `detector-is-a-list-of-sentences` is a §3 tag for this.
 *
 * ── SO THIS RULE IS GRAMMATICAL, AND SAFE BY ITS GATE ───────────────────────
 *
 * The pattern is a first-person commitment with ANY verb: `I'll …`, `I will …`,
 * `I'm going to …`. There is no vocabulary of objects to keep up to date, which is
 * precisely the thing that failed three times.
 *
 * What keeps a rule that broad from becoming `guard-destroys-the-answer`
 * occurrence 8 is not a narrow pattern but a narrow GATE: it applies only when the
 * USER asked about Brain's own conduct, and only when no repair evidence exists.
 * On such a turn nothing is dispatched, so any "I'll …" is a promise with nothing
 * behind it whatever it promises.
 *
 * That is a real difference from the five earlier recurrences of that tag, which
 * were all met by narrowing when a guard fires and all failed because eligibility
 * depended on a classifier being right about the ANSWER. Here the gate is the
 * user's own words, and being wrong about them costs a salvage, not a wrong answer.
 *
 * The battery below is the evidence Codex asked for: *"prove clear/fixed/taken care
 * of/changed workflow paraphrases cannot bypass the structured boundary."*
 */
import { describe, it, expect } from 'vitest';
import {
  validateBeforeRender, isSelfConductQuestion,
} from '../src/services/knowledge/responseValidator';
import { isSystemMarker } from '../src/services/knowledge/systemMarker';

const composed = (answer: string, over: Record<string, unknown> = {}) => ({
  answer, cites: [], gaps: [], actionResult: null, ...over,
} as any);

/** The measured B12 turn. */
const B12_Q = 'Why did you remind me about that one twice?';

const promise = (answer: string, question: string | null = B12_Q, over: any = {}) =>
  validateBeforeRender(composed(answer), {
    pendingStatus: null, turnIntent: 'read_only', question, ...over,
  }).violations.find((v) => v.rule === 'unevidenced_self_conduct');

describe('DEF-166 — the gate is the user\'s question', () => {
  it('recognises questions about Brain\'s own conduct', () => {
    for (const q of [
      'Why did you remind me about that one twice?',
      'Did you send that message to Hamna?',
      'What have you sent on my behalf today?',
      'Why do you keep nudging me about this?',
      'have you messaged her again',
    ]) expect(isSelfConductQuestion(q), q).toBe(true);
  });

  it('leaves ordinary business questions alone', () => {
    // The blast radius. If this drifts wide, every turn becomes eligible and the
    // rule stops being safe.
    for (const q of [
      "What is Hamna's mobile number?",
      'Brief my day.',
      'Can you place a WhatsApp call to Latif for me?',
      'Add an item to send the Fujairah pricing.',
      '',
    ]) expect(isSelfConductQuestion(q), q).toBe(false);
  });
});

describe('DEF-166 — paraphrases cannot bypass it', () => {
  // Every one of these is a promise of a future internal action on a turn that
  // dispatched nothing. The iteration-20 rule caught none of them.
  const paraphrases = [
    "I'll make sure the duplicate is cleared.",          // the measured answer
    "I'll get that sorted.",
    "I'll take care of it.",
    "I'll clean that up on my side.",
    'I will stop it happening.',
    "I'm going to look into why that happened.",
    "I'll change my workflow so this is smoother.",
    'I am going to tighten that up.',
  ];
  for (const answer of paraphrases) {
    it(`blocks: "${answer}"`, () => {
      const v = promise(answer);
      expect(v, 'shipped an unbacked commitment').toBeDefined();
      expect(v!.severity).toBe('block');
    });
  }
});

describe('DEF-166 — the honest shapes stay', () => {
  // Core rule 6a asks for exactly these: state what is observable, say the cause
  // is not recorded, offer the next step as a QUESTION. If the rule blocked them
  // it would be pushing Brain from a false answer to no answer.
  const honest = [
    'You got two reminders. I can see that, but I have no record of why. Want me to look into it?',
    'I sent it twice. The cause is not recorded. Shall I dig into the scheduler?',
    "I'll need the due date before I can chase her.",
    'I have to check with you first.',
    'Two reminders went out, at 09:03 and 09:08. Nothing explains the second.',
  ];
  for (const answer of honest) {
    it(`leaves alone: "${answer.slice(0, 46)}…"`, () => {
      expect(promise(answer)).toBeUndefined();
    });
  }
});

describe('DEF-166 — it only applies where it is justified', () => {
  it('does not fire on a business turn', () => {
    // "I'll add it now" on an action turn is `empty_promise`'s business, and it
    // has its own evidence rules. This rule must not reach across.
    expect(promise("I'll add that to your list now.", 'Add an item for the Fujairah pricing.'))
      .toBeUndefined();
  });

  it('DEF-167 — caller-supplied "evidence" no longer disables it', () => {
    // This asserted the opposite until iteration 22. Codex's iteration-21 HIGH #3:
    // the seam only trimmed strings, so any four literals turned the guard off.
    // Deleted rather than tightened a fourth time; the guard fails closed.
    expect(promise("I'll make sure the duplicate is cleared.", B12_Q, {
      selfRepairEvidence: {
        kind: 'repair', findingId: 'finding-42', observedCause: 'duplicate tick',
        appliedRepair: 'dedup key added', preventionArtifactId: 'artifact-99',
      },
    })).toBeDefined();
  });

  it('keeps the grounded sentences and cuts only the promise', () => {
    const v = promise(
      'You got two reminders, at 09:03 and 09:08. I have no record of why. '
      + "I'll make sure the duplicate is cleared.",
    )!;
    expect(v.salvagedAnswer).toBeDefined();
    expect(v.salvagedAnswer).toContain('09:03');
    expect(v.salvagedAnswer).toContain('no record of why');
    expect(v.salvagedAnswer, 'the promise must be gone').not.toMatch(/make sure/i);
  });

  it('its marker points at the honest shape rather than scolding', () => {
    const v = promise("I'll make sure the duplicate is cleared.")!;
    // DEF-169 — origin stamp, not a leading bracket.
    expect(isSystemMarker(v.suggestedReplacement)).toBe(true);
    expect(v.suggestedReplacement).toMatch(/nothing was flagged, fixed or scheduled/i);
    expect(v.suggestedReplacement, 'it must say what to do instead')
      .toMatch(/question/i);
  });
});
