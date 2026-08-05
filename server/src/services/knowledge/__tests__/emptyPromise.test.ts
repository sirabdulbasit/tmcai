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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimsCompletion, EMPTY_PROMISE_RE } from '../brainComposer';

// For Part-2 retention-hazard regression checks. Reading source is a
// pragmatic choice — the retention logic is inline in the ~5000-line
// compose() function, and extracting it for unit testing would exceed
// the "no refactoring" boundary. Source-content assertions catch the
// exact regression the fix targets without requiring a compose harness.
const BRAIN_COMPOSER_PATH = join(__dirname, '..', 'brainComposer.ts');
const BRAIN_COMPOSER_SRC = readFileSync(BRAIN_COMPOSER_PATH, 'utf-8');

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
    // CHANGED 2026-08-05 (DEF-058). The old premise — "no Brain action
    // called note X" — is no longer true: record_preference stores notes, and
    // create_contact carries a `note` slot. More to the point, "I've noted
    // that" when nothing was written is precisely the fabrication the owner
    // hit at 18:21, alongside "I've created a contact for your friend".
    //
    // So it now matches, and is protected the same way "removed" below is:
    // the composer gates the intercept on isActionTurn, so a conversational
    // aside is not rewritten unless the user's message was an imperative.
    expect(claimsCompletion("I've noted that.")).toBe(true);

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

// ─────────────────────────────────────────────────────────────────
// AUDIT ROUND 2 (2026-07-08) — verb-list coverage extension.
//
// The Action Center audit surfaced fabrication holes for five action
// types (archive_wiki_page, mark_contact_inactive, record_preference,
// set_brain_name, mark_open_item_done). Each hole exists because the
// completion verb used in that action's natural prose was missing
// from _COMPLETION_VERBS_ANY / _COMPLETION_VERBS_PAST.
//
// These tests pin every phrase from the audit's empirical probe. If
// any of them regresses (unmatched again), a fabricated completion
// claim for that action type could ship to the user unchallenged.
// ─────────────────────────────────────────────────────────────────

describe('audit round 2 — verb-list coverage for the 5 previously-vulnerable action types', () => {
  it.each([
    // archive_wiki_page — previously unmatched, now must match
    "I've archived the wiki page.",
    'The page has been archived.',
    'Archived it.',
    'Archived that.',
    'The note was archived yesterday.',

    // mark_contact_inactive — previously unmatched, now must match
    "I've marked Rafay as inactive.",
    'Marked Rafay inactive.',
    'Rafay has been marked as inactive.',

    // record_preference — previously unmatched, now must match
    "I've saved that preference.",
    "I've remembered that preference.",
    'That preference has been saved.',
    'Preference saved.',

    // set_brain_name — previously unmatched, now must match
    'Renamed myself to Suzi.',
    "I've renamed myself Suzi.",
    "I'll call myself Suzi now.",
    'Calling myself Suzi from now on.',

    // mark_open_item_done — previously PARTIAL, uncovered phrasings
    // "I've marked it as complete" was the specific miss reported.
    "I've marked it as complete.",
    "I've marked it complete.",
    'The task has been completed.',
    'The task is closed.',
    "I've closed that item.",
    'Item closed.',
  ])('now matches: %s', (phrase) => {
    expect(claimsCompletion(phrase)).toBe(true);
  });

  it.each([
    // Legitimate uses of the newly-added verbs that should still NOT
    // match — these preserve trust in conversational replies.
    'You can archive it yourself in Settings.',        // "archive" (base form) after "you can"
    'Have you marked it done?',                         // question, not a claim
    'Do you want me to close this item?',               // question
    'I archive newsletters weekly.',                    // habitual present ("I archive" — base form)
    'I complete my day-brief every morning.',           // habitual present
    'The archive folder is over there.',                // "archive" as noun
    'I save my drafts before leaving.',                 // habitual present ("I save")
    'I remember the meeting time.',                     // habitual present + inanimate object
    'Would you like me to mark it done?',               // question
    'Should I rename myself?',                          // question with "myself" — but is a question
  ])('does not flag legitimate non-completion use: %s', (phrase) => {
    expect(claimsCompletion(phrase)).toBe(false);
  });

  it('Roman-Urdu completion idioms still match (extended set)', () => {
    // The existing "kar diya / ho gaya" branch is preserved; new
    // additions cover "kar liya" and "yaad rakh liya" (remembered).
    expect(claimsCompletion('Kar liya sir.')).toBe(true);
    expect(claimsCompletion('Yaad rakh liya.')).toBe(true);
    expect(claimsCompletion('Save kar liya hai.')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────
// PART 2 REGRESSION — prose-retention hazard removal.
//
// The audit flagged two sites where a successful dispatch would keep
// the LLM's original prose if it "sounded right", masking discrepancy
// between what the LLM claimed and what the dispatcher actually did:
//   - brainComposer.ts:2447 (add_open_item)
//   - brainComposer.ts:2753 (schedule_meeting)
//
// The retention was implemented as inline conditionals inside the
// ~5000-line compose() function. Extracting them for behaviour tests
// would exceed the "no refactoring" boundary. Instead we assert on the
// source file — verifying the specific retention regex is gone and
// the new unconditional assignment is present. This catches accidental
// re-introduction without requiring a compose harness.
// ─────────────────────────────────────────────────────────────────

describe('audit round 2 — prose-retention hazards removed on success path', () => {
  it('add_open_item: no longer retains LLM prose based on /added|noted|done|got it/', () => {
    // The old retention regex must no longer appear in the source.
    expect(BRAIN_COMPOSER_SRC).not.toContain('/added|added to|noted|done|got it/i.test(answer)');
  });

  it('add_open_item: success path now unconditionally uses res.message', () => {
    // Locate the add_open_item dispatch block and confirm the "answer
    // = res.message" assignment appears without the old conditional.
    const anchor = BRAIN_COMPOSER_SRC.indexOf("intent: 'add_open_item'");
    expect(anchor).toBeGreaterThan(-1);
    // Look within a bounded window after the anchor. The new pattern:
    //   actionResult = { ... message: res.message };
    //   // ...comments...
    //   answer = res.message;
    const window = BRAIN_COMPOSER_SRC.slice(anchor, anchor + 2500);
    expect(window).toMatch(/actionResult\s*=\s*\{[\s\S]*?message:\s*res\.message[\s\S]*?\};[\s\S]*?answer\s*=\s*res\.message/);
  });

  it('schedule_meeting: no longer retains LLM prose based on /scheduled|set|sent invite/', () => {
    expect(BRAIN_COMPOSER_SRC).not.toContain('/scheduled|set|sent invite/i.test(answer)');
  });

  it('schedule_meeting: success path now unconditionally uses res.message', () => {
    // Locate the schedule_meeting dispatch block and confirm the new
    // "answer = res.ok ? res.message : ..." single-line assignment.
    const anchor = BRAIN_COMPOSER_SRC.indexOf("meetingAttendees: [...emails, ...names]");
    expect(anchor).toBeGreaterThan(-1);
    const window = BRAIN_COMPOSER_SRC.slice(anchor, anchor + 1500);
    expect(window).toMatch(/answer\s*=\s*res\.ok\s*\?\s*res\.message\s*:/);
  });

  it('retention conditionals used the phrase "keep LLM prose" — that shortcut removed', () => {
    // Defence in depth: neither of the two failure-mode strings the
    // old code branched on should still be present as a runtime test.
    expect(BRAIN_COMPOSER_SRC).not.toMatch(/if\s*\(\s*!\s*\/added\|added to\|noted\|done\|got it\/i/);
    expect(BRAIN_COMPOSER_SRC).not.toMatch(/if\s*\(\s*!\s*\/scheduled\|set\|sent invite\/i/);
  });
});
