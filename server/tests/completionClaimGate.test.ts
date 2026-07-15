import { describe, it, expect } from 'vitest';
import {
  classifyTurnIntent,
  shouldInterceptCompletionClaim,
  matchedCompletionCategory,
  completionInterceptMarker,
  claimsCompletion,
  extractRecordIds,
} from '../src/services/knowledge/brainComposer';
import { sanitizeAnswerForUser } from '../src/services/knowledge/answerSanitizer';

// Chat 9 (2026-07-14) — "Tell me its status" about the EXIM item
// (delegated to Muhammad Yousaf) was answered correctly by reasoning,
// then destroyed by the ungated completion interceptor: "is delegated"
// matched the passive branch → user got "something didn't dispatch…
// name the recipient" on a read-only question. These tests lock the
// gate: turn intent × claim shape × dispatch evidence × grounding.

const EXIM_STATUS_ANSWER = 'The EXIM solution item is delegated to Muhammad Yousaf. Due date: not set. Last update: delegated on 12 Jul.';

describe('classifyTurnIntent', () => {
  it('status questions are read-only even when they start with an imperative verb', () => {
    expect(classifyTurnIntent('Tell me its status')).toBe('read_only');
    expect(classifyTurnIntent('tell me the status of EXIM solution')).toBe('read_only');
    expect(classifyTurnIntent('show me the open items')).toBe('read_only');
    expect(classifyTurnIntent('give me an update on EXIM')).toBe('read_only');
    expect(classifyTurnIntent('what happened with the leave request?')).toBe('read_only');
    expect(classifyTurnIntent('was the email sent?')).toBe('read_only');
    expect(classifyTurnIntent('did Yousaf reply?')).toBe('read_only');
    expect(classifyTurnIntent('any progress on exim?')).toBe('read_only');
  });

  it('outbound/change requests are mutations, even phrased politely or as questions', () => {
    expect(classifyTurnIntent('Send the email to Asad')).toBe('mutation');
    expect(classifyTurnIntent('Delegate EXIM to Yousaf')).toBe('mutation');
    expect(classifyTurnIntent('can you send it to asad?')).toBe('mutation');
    expect(classifyTurnIntent('please schedule a meeting with rafay tomorrow 3pm')).toBe('mutation');
    expect(classifyTurnIntent('tell Asad we are ready')).toBe('mutation'); // tell <person> ≠ tell me
    expect(classifyTurnIntent('check with Yousaf about the deadline')).toBe('mutation');
    expect(classifyTurnIntent('update the contact email to .com')).toBe('mutation');
  });

  it('neither shape → ambiguous', () => {
    expect(classifyTurnIntent('EXIM solution')).toBe('ambiguous');
    expect(classifyTurnIntent('')).toBe('ambiguous');
  });
});

describe('A — read-only delegated status (the chat-9 regression)', () => {
  it('grounded status answer passes through untouched: no intercept, no dispatch-failure marker', () => {
    const v = shouldInterceptCompletionClaim({
      userQuestion: 'Tell me the status of EXIM solution.',
      answer: EXIM_STATUS_ANSWER,
      decision: 'answer',
      emittedAction: false,
      actionResult: null,
      groundedStatusContext: true, // open-items block was retrieved
    });
    expect(v.intercept).toBe(false);
    expect(v.turnClass).toBe('read_only');
    // sanity: the old ungated regex DID match this — proving the gate,
    // not a weakened regex, is what fixed it.
    expect(claimsCompletion(EXIM_STATUS_ANSWER)).toBe(true);
  });
});

describe('B — pronoun follow-up after clarification', () => {
  it('"Tell me its status" is read-only; grounded answer allowed; never asks for a recipient', () => {
    const v = shouldInterceptCompletionClaim({
      userQuestion: 'Tell me its status',
      answer: 'It is delegated to Muhammad Yousaf and currently in progress.',
      decision: 'answer',
      emittedAction: false,
      actionResult: null,
      groundedStatusContext: true,
    });
    expect(v.intercept).toBe(false);
    expect(v.turnClass).toBe('read_only');
  });
});

describe('C — grounded past email', () => {
  it('"was the email sent?" answered from a retrieved sent record is allowed', () => {
    const v = shouldInterceptCompletionClaim({
      userQuestion: 'Was the email sent?',
      answer: 'Yes — the email was sent yesterday at 3:00 PM to asad.ahmed@tmcltd.com (from your Gmail Sent folder).',
      decision: 'answer',
      emittedAction: false,
      actionResult: null,
      groundedStatusContext: true,
    });
    expect(v.intercept).toBe(false);
  });
});

describe('D — ungrounded send claim on a mutation turn', () => {
  it('"Send the email to Asad" + answer-only "The email has been sent." with no action → intercepted', () => {
    const v = shouldInterceptCompletionClaim({
      userQuestion: 'Send the email to Asad.',
      answer: 'The email has been sent.',
      decision: 'answer',
      emittedAction: false,
      actionResult: null,
      groundedStatusContext: true, // grounding does NOT excuse a mutation-turn claim
    });
    expect(v.intercept).toBe(true);
    expect(v.failureType).toBe('fabricated_completion_on_action_turn');
    expect(v.turnClass).toBe('mutation');
  });
});

describe('E — ungrounded delegation claim on a mutation turn', () => {
  it('"Delegate EXIM to Yousaf" + stative answer-only claim → intercepted', () => {
    const v = shouldInterceptCompletionClaim({
      userQuestion: 'Delegate EXIM to Yousaf',
      answer: 'The item is delegated to Yousaf.',
      decision: 'answer',
      emittedAction: false,
      actionResult: null,
      groundedStatusContext: false,
    });
    expect(v.intercept).toBe(true);
    expect(v.failureType).toBe('fabricated_completion_on_action_turn');
  });
});

describe('F — confirmed mutation', () => {
  it('structured action ran and confirmed → success wording allowed', () => {
    const v = shouldInterceptCompletionClaim({
      userQuestion: 'Delegate EXIM to Yousaf',
      answer: 'Delegated to Muhammad Yousaf — he has been emailed the details.',
      emittedAction: true,
      actionResult: { ok: true },
    });
    expect(v.intercept).toBe(false);
  });
});

describe('G — dispatched but unconfirmed mutation', () => {
  it('the gate defers to the dispatch path (which owns honest unconfirmed wording); never invents its own failure', () => {
    const v = shouldInterceptCompletionClaim({
      userQuestion: 'Send the email to Asad',
      answer: 'Sent for execution — I could not yet confirm delivery; I will verify against your Sent folder.',
      emittedAction: true,     // a real dispatch happened
      actionResult: null,      // …but no confirmation available
    });
    expect(v.intercept).toBe(false);
  });

  it('sanitizer fabricated-completion wording never POSITIVELY claims completion', () => {
    const msg = sanitizeAnswerForUser(completionInterceptMarker('fabricated_completion_on_action_turn'));
    // The truthful negation ("hadn't actually done that") is required;
    // what must never appear is an affirmative claim.
    expect(msg).toContain("hadn't actually done");
    expect(msg.toLowerCase()).not.toMatch(/^done\b|\bis sent\b|\bwas sent\b|\bhas been sent\b|\bcompleted successfully\b/);
  });
});

describe('H — status vocabulary is not auto-fabrication', () => {
  const statusPhrases = [
    'The item is delegated to Muhammad Yousaf.',
    'The email was sent yesterday.',
    'The meeting was rescheduled by Asad.',
    'The task is marked done.',
    'The item is currently assigned to Sara.',
    'According to the action history, the reminder was sent at 3:00 PM.',
  ];
  for (const answer of statusPhrases) {
    it(`read-only turn allows: "${answer.slice(0, 44)}…"`, () => {
      const v = shouldInterceptCompletionClaim({
        userQuestion: 'tell me the status of that item',
        answer,
        decision: 'answer',
        emittedAction: false,
        actionResult: null,
        groundedStatusContext: true,
      });
      expect(v.intercept).toBe(false);
      expect(v.matchedCategory).toBe('stative_state'); // it DID match — the gate let it through
    });
  }

  it('the same stative phrase on a MUTATION turn still intercepts (safety kept)', () => {
    const v = shouldInterceptCompletionClaim({
      userQuestion: 'reschedule the meeting to friday',
      answer: 'The meeting was rescheduled.',
      emittedAction: false,
      actionResult: null,
      groundedStatusContext: true,
    });
    expect(v.intercept).toBe(true);
  });
});

describe('ambiguous turns — never invent a dispatch failure', () => {
  it('bare ungrounded first-person claim is withheld', () => {
    const v = shouldInterceptCompletionClaim({
      userQuestion: 'EXIM solution',
      answer: "I've delegated it to Yousaf.",
      emittedAction: false,
      actionResult: null,
      groundedStatusContext: false,
    });
    expect(v.intercept).toBe(true);
  });

  it('grounded stative description on an ambiguous turn passes', () => {
    const v = shouldInterceptCompletionClaim({
      userQuestion: 'EXIM solution',
      answer: 'That item is delegated to Muhammad Yousaf and due Friday.',
      emittedAction: false,
      actionResult: null,
      groundedStatusContext: true,
    });
    expect(v.intercept).toBe(false);
  });
});

describe('pronoun follow-ups resolve as reads with RECORD-level grounding (#1 finalization)', () => {
  // The artifacts/open-items blocks carry canonical cuid record ids;
  // extractRecordIds turns block-level grounding into record-level.
  const OPEN_ITEMS_BLOCK = '# Open items\n- [cmoq9md2e02e5rtv69qz84hrd] "EXIM solution" — DELEGATED to Muhammad Yousaf, due: (none)';

  for (const q of ['Tell me its status', 'who owns it?', 'when is it due?', 'was its delegation email sent?']) {
    it(`"${q}" is read-only and a grounded stative answer passes`, () => {
      expect(classifyTurnIntent(q)).toBe('read_only');
      const v = shouldInterceptCompletionClaim({
        userQuestion: q,
        answer: 'The EXIM solution item is delegated to Muhammad Yousaf. The delegation email was sent when it was assigned.',
        decision: 'answer',
        emittedAction: false,
        actionResult: null,
        groundedRecordIds: extractRecordIds(OPEN_ITEMS_BLOCK),
      });
      expect(v.intercept).toBe(false);
    });
  }

  it('extractRecordIds finds cuid-shaped ids and dedupes', () => {
    const ids = extractRecordIds(OPEN_ITEMS_BLOCK, OPEN_ITEMS_BLOCK, undefined, 'no ids here');
    expect(ids).toEqual(['cmoq9md2e02e5rtv69qz84hrd']);
  });

  it('record ids ground an otherwise-ambiguous stative description', () => {
    const v = shouldInterceptCompletionClaim({
      userQuestion: 'EXIM solution', // ambiguous fragment
      answer: 'That item is delegated to Muhammad Yousaf.',
      emittedAction: false,
      actionResult: null,
      groundedRecordIds: ['cmoq9md2e02e5rtv69qz84hrd'],
    });
    expect(v.intercept).toBe(false);
  });

  it('record grounding does NOT excuse a mutation-turn claim (safety intact)', () => {
    const v = shouldInterceptCompletionClaim({
      userQuestion: 'Delegate EXIM to Yousaf',
      answer: 'The item is delegated to Yousaf.',
      emittedAction: false,
      actionResult: null,
      groundedRecordIds: ['cmoq9md2e02e5rtv69qz84hrd'],
    });
    expect(v.intercept).toBe(true);
  });
});

describe('claim-shape classifier', () => {
  it('splits current-turn claims from stative state', () => {
    expect(matchedCompletionCategory("I've sent the email.")).toBe('current_turn_claim');
    expect(matchedCompletionCategory('Done — delegated to Yousaf.')).toBe('current_turn_claim');
    expect(matchedCompletionCategory('kar diya hai')).toBe('current_turn_claim');
    expect(matchedCompletionCategory('The item is delegated to Yousaf.')).toBe('stative_state');
    expect(matchedCompletionCategory('was sent yesterday')).toBe('stative_state');
    expect(matchedCompletionCategory('Happy to help with anything else.')).toBeNull();
  });
});

describe('sanitizer wording per failure type', () => {
  it('fabricated completion: truthful, no invented dispatch failure, no recipient demand', () => {
    const msg = sanitizeAnswerForUser('[no action dispatched — the assistant claimed completion but no action ran]');
    expect(msg).toContain("hadn't actually done that");
    expect(msg.toLowerCase()).not.toContain('dispatch');
    expect(msg.toLowerCase()).not.toContain('recipient');
  });

  it('read-only validation failure: status wording only — never dispatch/recipient', () => {
    const msg = sanitizeAnswerForUser('[status read failed — answer withheld pending a grounded re-read]');
    expect(msg).toBe("I found the item, but I couldn't reliably read its current status. Let me check it again.");
    expect(msg.toLowerCase()).not.toContain('dispatch');
    expect(msg.toLowerCase()).not.toContain('recipient');
  });

  it('the old misleading wording is gone', () => {
    const msg = sanitizeAnswerForUser('[no action dispatched — anything]');
    expect(msg).not.toContain("name the recipient");
    expect(msg).not.toContain("didn't dispatch");
  });
});
