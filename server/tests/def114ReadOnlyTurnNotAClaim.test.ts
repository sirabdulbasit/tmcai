/**
 * DEF-114 — the validator overruled the composer and ate the apology.
 *
 * Production, 2026-08-10 18:37:03, three log lines in the same second:
 *
 *   [brain-chat] empty-promise regex matched on non-action turn, leaving prose unchanged
 *   [brain-chat] validateBeforeRender block
 *   Brain reply composed  answerLen=107
 *
 * The composer got it RIGHT — it gates on classifyTurnIntent(question) ===
 * 'mutation' and deliberately left the prose alone. validateBeforeRender then
 * overruled it and replaced the whole answer with the 107-character canned
 * denial. What the owner lost that turn:
 *
 *   "My apologies, Sir. That was my mistake. You provided all the necessary
 *    details."
 *
 * The validator never saw the question, so it judged the answer alone — and an
 * apology is textually indistinguishable from a fabricated claim. Four blocked
 * replies in ninety minutes, all on turns where nothing was dispatched.
 *
 * The guard must NOT be weakened. DEF-041 — "I will delegate all four
 * unassigned items to Hamna Latif Bhutta now", delegated nothing, then emailed
 * her saying it had — was a MUTATION turn and must still block. So must an
 * unknown turn: a caller that cannot say what was asked gets the strict path.
 */
import { describe, it, expect } from 'vitest';
import { validateBeforeRender } from '../src/services/knowledge/responseValidator';

const answerWith = (answer: string) => ({ answer, actionResult: null } as any);
const CLAIM = 'I have delegated all four items to Hamna.';

const blocked = (r: ReturnType<typeof validateBeforeRender>) =>
  r.violations.some((v) => v.rule === 'empty_promise' && v.severity === 'block');

describe('a read-only turn cannot host a current-turn fabrication', () => {
  it('does not block a completion-shaped sentence on a read-only turn', () => {
    const r = validateBeforeRender(answerWith(CLAIM), { turnIntent: 'read_only' });
    expect(blocked(r)).toBe(false);
  });

  it('releases the exact apology that was eaten on 2026-08-10', () => {
    const apology = 'My apologies, Sir. That was my mistake. You provided all the '
      + 'necessary details. I have created the task already.';
    const r = validateBeforeRender(answerWith(apology), { turnIntent: 'read_only' });
    expect(blocked(r)).toBe(false);
  });
});

describe('every other turn still blocks — DEF-041 must stay caught', () => {
  it('blocks on a mutation turn', () => {
    const def041 = 'I will delegate all four unassigned items to Hamna Latif Bhutta now.';
    const r = validateBeforeRender(answerWith(def041), { turnIntent: 'mutation' });
    expect(blocked(r)).toBe(true);
  });

  it('blocks on an ambiguous turn', () => {
    expect(blocked(validateBeforeRender(answerWith(CLAIM), { turnIntent: 'ambiguous' }))).toBe(true);
  });

  it('blocks when the intent is UNKNOWN — fail closed', () => {
    // A caller that cannot say what the user asked gets the strict behaviour.
    expect(blocked(validateBeforeRender(answerWith(CLAIM), {}))).toBe(true);
    expect(blocked(validateBeforeRender(answerWith(CLAIM)))).toBe(true);
  });

  it('still blocks a passive fabrication on a mutation turn', () => {
    const passive = 'The email about the leave request has been sent to Asad Ahmed Taj.';
    expect(blocked(validateBeforeRender(answerWith(passive), { turnIntent: 'mutation' }))).toBe(true);
  });

  it('does not block when the action actually succeeded', () => {
    const r = validateBeforeRender(
      { answer: CLAIM, actionResult: { ok: true, message: 'done' } } as any,
      { turnIntent: 'mutation' },
    );
    expect(blocked(r)).toBe(false);
  });
});
