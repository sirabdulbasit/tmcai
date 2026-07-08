/**
 * emptyPromise.test.ts — regression coverage for the completion-claim
 * detector that gates the fallback action-decider AND the post-guard
 * safety net in brainComposer.
 *
 * Motivated by Basit chat 2 (2026-07-08): the LLM composed
 *   "The email about the leave request has been sent to Asad Ahmed Taj."
 * without ever emitting a send_email action. The old regex only
 * matched first-person active voice ("I've sent", "I sent"), so the
 * passive-voice fabrication slipped past every safety net and the
 * fake completion claim shipped to WhatsApp.
 *
 * Contract these tests enforce:
 *   1. The exact failing phrase (Basit chat 2) MUST match.
 *   2. Multiple paraphrases (active, passive, third-person, idiomatic
 *      Roman-Urdu) MUST match.
 *   3. Innocuous prose that historically false-positived
 *      (habitual-present "I schedule my day", conversational
 *      "I've noted that") MUST NOT match.
 */
import { describe, it, expect } from 'vitest';
import { claimsCompletion, EMPTY_PROMISE_RE } from '../brainComposer';

describe('claimsCompletion — must catch the fabricated completion class', () => {
  it('catches the exact Basit chat-2 failing phrase', () => {
    const phrase =
      'Certainly, Sir. The email about the leave request has been sent to Asad Ahmed Taj.';
    expect(claimsCompletion(phrase)).toBe(true);
  });

  it.each([
    // Passive voice, third-person (the failing shape)
    'The email has been sent.',
    'The invite was scheduled.',
    'The message was delivered to Asad.',
    'The follow-up has been dispatched.',
    'The reminder was set for tomorrow.',
    'The task has been added to the list.',

    // Third-person impersonal with subject phrase
    'The email is sent now.',
    'The nudge was forwarded to Yousuf.',
    'The item was cancelled.',
    // Note: "Done — it's with Asad now." matches only if the "done —" idiom OR the "it was X" branch fires; test kept as separate case.

    // Idiomatic completion (Urdu / Hindi)
    'Ho gaya, sir — kar diya',
    'Message kar diya hai',
    'Ho gayi bhaiya',

    // First-person active — regression that old regex already caught
    "I've sent it.",
    'I sent the email to Asad.',
    "I'll send it now.",
    "I'm scheduling that for Friday.",
    'I just added that.',
    'I already delegated it.',

    // Reasoning-answer-decision-style fabrications (the failure this
    // fix targets structurally)
    'Certainly, Sir. The email has been sent to Asad Ahmed Taj.',
    'Done. Delegated to Yousuf.',
    "Confirmed, Sir. The test email has been sent to sirabdulbasit@gmail.com.",
  ])('catches paraphrase: %s', (phrase) => {
    expect(claimsCompletion(phrase)).toBe(true);
  });

  it('catches "Done — it\'s with X now" via the done-em-dash idiom', () => {
    // Note: em-dash (—), not hyphen. The regex checks for the idiom.
    expect(claimsCompletion("Done — it's with Asad now.")).toBe(true);
  });
});

describe('claimsCompletion — must NOT flag innocuous prose', () => {
  it.each([
    // Habitual present tense — old bare "\bi\b" branch false-positive
    // that this fix restricts (bare "i " is now past-tense only).
    'I schedule my day at 8am.',
    'I add notes to open items when I remember.',
    'I forward newsletters I care about.',
    'I remind myself with sticky notes.',

    // Non-completion first-person prose
    "I've been thinking about it.",
    'I like the way you handled that.',

    // Questions, not claims
    'Should I send this now?',
    'Do you want me to schedule it?',
    'Was the email delivered? I cannot tell.',

    // Descriptions of state without claiming an action was performed
    'The meeting is at 3pm.',
    'The email thread is with Asad.',
    'The task is due tomorrow.',
    'The reminder is for next week.',
  ])('does not flag: %s', (phrase) => {
    expect(claimsCompletion(phrase)).toBe(false);
  });

  it('documents which conversational acknowledgements still match the regex — the composer gates the intercept on isActionTurn to avoid the 2026-05-22 false-positive class', () => {
    // "noted" is NOT in the dispatchable-verb list (no Brain action
    // called "note X"), so this stays false. Recording as an intended
    // exclusion for future reviewers.
    expect(claimsCompletion("I've noted that.")).toBe(false);

    // "removed" IS in the verb list (mark_contact_inactive semantics).
    // This DOES match the regex — but the composer's intercept is
    // gated on isActionTurn, so a conversational aside like this
    // won't be rewritten unless the user's message was itself an
    // imperative. See the gate at the "else if (isActionTurn &&
    // claimsCompletion(...))" branch in brainComposer.
    expect(claimsCompletion("I've removed that from my reading list.")).toBe(true);
  });

  it('empty string returns false without throwing', () => {
    expect(claimsCompletion('')).toBe(false);
  });

  it('undefined / null-shape input returns false without throwing', () => {
    // The helper accepts `?? ''` so nullish inputs are safe.
    expect(claimsCompletion(undefined as any)).toBe(false);
    expect(claimsCompletion(null as any)).toBe(false);
  });
});

describe('EMPTY_PROMISE_RE — behavioural equivalence with claimsCompletion', () => {
  // Guardrail: the exported regex is what other call sites in
  // brainComposer.ts (the pre-decider trigger + post-guard) test
  // directly. Ensure the helper and the regex agree.
  it.each([
    'The email has been sent.',
    "I've sent it.",
    'I schedule my day at 8am.',
    "I've noted that.",
  ])('regex.test agrees with claimsCompletion for: %s', (phrase) => {
    expect(EMPTY_PROMISE_RE.test(phrase)).toBe(claimsCompletion(phrase));
  });
});
