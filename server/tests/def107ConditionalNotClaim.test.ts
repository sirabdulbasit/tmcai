/**
 * DEF-107 — a rule described is not a claim made.
 *
 * Production, 2026-08-10, twice inside nine minutes. Both answers were correct
 * and neither reached the owner; both were replaced by the 107-character canned
 * denial in answerSanitizer, which is how they were identified — the logged
 * `answerLen=107` matches that string's length exactly.
 *
 *   14:30  owner: "if anyone is irresponsive over your email or whatsapp, are
 *                  you counting on it?"
 *          brain:  "Sir, I track when you delegate an item to someone, like the
 *                   tasks with Hamna Latif. If a deadline is approaching … I'll
 *                   remind you"
 *          result: validateBeforeRender block, rules: ['empty_promise']
 *
 *   14:39  owner: "why don't you update me if someone responds"
 *          brain:  "Sir, when I send a query on your behalf, I automatically
 *                   track if a reply comes in. If I get one, I will inform you"
 *          result: blocked at decision=answer, confidence=1, historyTurns=10
 *
 * The guard is right to exist and must not be weakened. DEF-041: Brain said
 * "I will delegate all four unassigned items to Hamna Latif Bhutta now",
 * delegated nothing, then emailed her from the owner's own address saying it
 * had. That sentence is first-person future with a completion verb — exactly
 * the shape being exempted here — and it MUST still block. It does, because it
 * carries no conditional.
 *
 * The whole fix rests on that one distinction, so the tests below are weighted
 * towards proving the guard still catches what it was built for.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { isConditionalFutureBehaviour, claimsCompletion } from '../src/services/knowledge/brainComposer';

describe('the two production sentences are released', () => {
  it('releases the 14:30 answer about tracking delegations', () => {
    const answer = 'Sir, I track when you delegate an item to someone, like the tasks '
      + "with Hamna Latif. If a deadline is approaching and there is no reply, I'll remind you.";
    expect(claimsCompletion(answer)).toBe(true);          // still matches the word list
    expect(isConditionalFutureBehaviour(answer)).toBe(true); // but is not a claim
  });

  it('releases the 14:39 answer about tracking replies', () => {
    const answer = 'Sir, when I send a query on your behalf, I automatically track if a '
      + 'reply comes in. If I get one, I will inform you.';
    expect(isConditionalFutureBehaviour(answer)).toBe(true);
  });
});

describe('DEF-041 and every other real fabrication still blocks', () => {
  it.each([
    ['the DEF-041 incident phrase', 'I will delegate all four unassigned items to Hamna Latif Bhutta now.'],
    ['unconditional future send', "I'll send it now."],
    ['unconditional future email', 'I will email Hamna about this.'],
    ['past tense', "I've sent the email to Hamna."],
    ['bare past tense', 'I already delegated those three items.'],
    ['passive voice (Basit chat 2)', 'The email about the leave request has been sent to Asad Ahmed Taj.'],
    ['third-person impersonal', 'The invite was scheduled.'],
    ['idiomatic Urdu', 'Message kar diya hai'],
  ])('does not exempt: %s', (_label, phrase) => {
    expect(isConditionalFutureBehaviour(phrase)).toBe(false);
  });

  it('does not exempt a past-tense claim merely because a conditional is nearby', () => {
    // The dangerous near-miss: conditional present, but the claim asserts
    // completed work. Must still block.
    expect(isConditionalFutureBehaviour("If you were wondering, I've already sent it.")).toBe(false);
    expect(isConditionalFutureBehaviour('When you asked earlier, the email had been sent.')).toBe(false);
  });

  it('does not exempt a mixed answer where one sentence fabricates', () => {
    // A standing rule in one sentence must not launder a claim in the next.
    const mixed = "If a deadline approaches, I'll remind you. I have delegated all four items.";
    expect(isConditionalFutureBehaviour(mixed)).toBe(false);
  });

  it('requires an actual completion-verb match before exempting anything', () => {
    expect(isConditionalFutureBehaviour('If you like, tell me more.')).toBe(false);
    expect(isConditionalFutureBehaviour('')).toBe(false);
  });
});

describe('conditional markers', () => {
  it.each([
    ["if", "If a deadline is approaching, I'll remind you."],
    ["when", "When a reply arrives, I'll notify you."],
    ["whenever", "Whenever someone responds, I will inform you."],
    ["once", "Once the item is overdue, I'll remind them."],
    ["as soon as", "As soon as they reply, I'll update you."],
    ["unless", "Unless you say otherwise, I'll remind you."],
    ["in case", "In case they go quiet, I'll email them."],
  ])('recognises %s', (_m, phrase) => {
    expect(isConditionalFutureBehaviour(phrase)).toBe(true);
  });

  it('is not fooled by a conditional with no future first-person claim', () => {
    // Passive completion inside a conditional is still a completion claim.
    expect(isConditionalFutureBehaviour('If the deadline passes, the email has been sent.')).toBe(false);
  });
});

describe('one implementation', () => {
  const VAL = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'knowledge', 'responseValidator.ts'), 'utf8');

  it('the validator imports the helper rather than re-deriving conditionality', () => {
    expect(VAL).toContain('isConditionalFutureBehaviour');
    // A second copy of this logic is the protection-with-two-implementations
    // shape that produced DEF-041 itself.
    expect(VAL).not.toMatch(/CONDITIONAL_MARKER_RE\s*=/);
  });

  it('does NOT gate on the turn\'s action state', () => {
    // DEF-041 removed a path-shaped exemption and its comment warns against
    // restoring one. Gating on actionEmitted would be exactly that.
    // Anchored on a real (non-comment) line: the file documents the OLD code
    // verbatim in a comment, so a plain indexOf finds the historical version.
    const m = /^\s*const emptyPromiseEligible\s*=[\s\S]{0,200}/m.exec(VAL);
    expect(m, 'live emptyPromiseEligible assignment not found').not.toBeNull();
    const block = m![0];
    expect(block).not.toMatch(/actionEmitted/);
    expect(block).not.toMatch(/sourceIsReasoning/);
  });
});
