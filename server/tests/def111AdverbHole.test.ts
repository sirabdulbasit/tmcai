/**
 * DEF-111 — an adverb between the auxiliary and the verb defeated the
 * completion-claim guard.
 *
 * Probed against the live regex on production, 2026-08-10:
 *     "I have delegated all four items"          -> caught
 *     "I have already delegated all four items"  -> NOT caught
 *     "I've just sent it"                        -> NOT caught
 *     "I have now sent the email"                -> NOT caught
 *
 * Every miss is the DEF-041 fabrication shape. That incident's sentence was
 * "I will delegate all four unassigned items to Hamna Latif Bhutta now" —
 * delegated nothing, then emailed Hamna from the owner's own address saying it
 * had. "I have already delegated all four items" is its past tense, and it
 * sailed through.
 *
 * The alternative was ALSO duplicated verbatim across EMPTY_PROMISE_RE and
 * CURRENT_TURN_CLAIM_RE. Patching one would have rebuilt DEF-041's exact
 * condition: two copies of one rule, the live one weaker, believed in sync.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { claimsCompletion, EMPTY_PROMISE_RE, CURRENT_TURN_CLAIM_RE } from '../src/services/knowledge/brainComposer';

describe('the adverb hole is closed', () => {
  it.each([
    'I have already delegated all four items',
    "I've just sent it",
    'I have now sent the email',
    'I have finally emailed Hamna',
    "I've actually cancelled that meeting",
    'I will now send it',
  ])('catches: %s', (phrase) => {
    expect(claimsCompletion(phrase)).toBe(true);
  });

  it('still catches the plain forms it always did', () => {
    expect(claimsCompletion('I have delegated all four items')).toBe(true);
    expect(claimsCompletion('I already delegated those items')).toBe(true);
    expect(claimsCompletion('The email has been sent to Asad Ahmed Taj.')).toBe(true);
  });
});

describe('it did not become a wildcard', () => {
  it('leaves habitual present alone', () => {
    // The documented must-not-match case.
    expect(claimsCompletion('I schedule my day at 8am')).toBe(false);
  });

  it('does not swallow a hedged future via a -ly wildcard', () => {
    // A closed adverb set was chosen precisely so "probably" is not an adverb
    // slot. DEF-107 showed what over-blocking costs.
    expect(EMPTY_PROMISE_RE.source).not.toMatch(/\\\\w\+ly/);
  });
});

describe('one definition, not two', () => {
  const SRC = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf8');

  it('both regexes share the extracted constant', () => {
    const uses = SRC.match(/_FIRST_PERSON_AUX_CLAIM/g) ?? [];
    // one definition + two uses
    expect(uses.length).toBeGreaterThanOrEqual(3);
  });

  it('the raw alternative appears nowhere twice', () => {
    const raw = SRC.match(/i\(\?:'ve\|\\\\s\+have\|'ll/g) ?? [];
    expect(raw.length, 'the pattern must exist in exactly one place').toBe(1);
  });

  it('the fix reaches BOTH regexes', () => {
    const phrase = 'I have already delegated all four items';
    expect(EMPTY_PROMISE_RE.test(phrase)).toBe(true);
    expect(CURRENT_TURN_CLAIM_RE.test(phrase)).toBe(true);
  });
});
