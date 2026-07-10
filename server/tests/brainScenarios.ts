/**
 * brainScenarios.ts — the regression corpus.
 *
 * Every WhatsApp chat Basit reports as "the brain got this wrong"
 * becomes a permanent, executable scenario here. This is the
 * anti-whack-a-mole mechanism: a bug is fixed ONCE, encoded ONCE, and
 * can never silently come back — brainRegression.test.ts runs every
 * scenario's `assert()` on each `npx vitest run`, which must be green
 * before any deploy.
 *
 * PROCESS (do this for every new reported chat):
 *   1. Add a scenario object below with the real user message, the
 *      failure that was observed, and the symptom tag(s).
 *   2. Write an `assert()` that exercises the REAL deterministic code
 *      path that broke and proves the fix holds. No assert = the
 *      coverage meta-test fails, so this can't be skipped.
 *   3. Link the fix commit.
 *
 * SCOPE (honest): these test the DETERMINISTIC machinery around the
 * LLM — parsers, prompt-block builders, dispatch guards, sanitizers,
 * routing. That's where ~every reported bug actually lived (ad-hoc
 * drop, wrong-owner routing, completion fabrication, marker leak,
 * prompt-queue capture). They do NOT test the LLM's judgement itself
 * (non-deterministic, not CI-safe) — the strategy is to make the
 * machinery fail CLOSED (ask / block) whenever the LLM is unsure, so
 * a judgement miss becomes a caught "ask", not a silent wrong action.
 */
import { expect } from 'vitest';
import { claimsCompletion, normaliseAction } from '../src/services/knowledge/brainComposer';
import { sanitizeAnswerForUser } from '../src/services/knowledge/answerSanitizer';
import { looksLikeAnswer } from '../src/services/brainPrompts/promptReplyHandler';

export interface BrainScenario {
  /** Stable id — chatN. */
  id: string;
  /** When Basit reported it. */
  date: string;
  /** What Basit typed / the trigger. */
  userMessage: string;
  /** What the brain did wrong. */
  observedFailure: string;
  /** Controlled vocab tags (must match brain_chat_archive.md). */
  symptomTags: string[];
  /** Commit(s) that fixed it. */
  fixCommits: string[];
  /**
   * Executable proof the fix holds. Exercises the real deterministic
   * code path. Async so scenarios that build prompt blocks (DB-mocked
   * in the test file) can await. Throws / expect-fails on regression.
   */
  assert: () => void | Promise<void>;
}

export const BRAIN_SCENARIOS: BrainScenario[] = [
  {
    id: 'chat1',
    date: '2026-07-07',
    userMessage: 'set my meeting with Rafay → rafayfrasat02@gmail.com',
    observedFailure:
      'User typed a raw email for a non-contact; the schedule_meeting parser dropped it, so the preview showed an empty "With:" line and the flow broke.',
    symptomTags: ['ad-hoc-drop'],
    fixCommits: ['682bbc1'],
    assert: () => {
      // The parser MUST retain an ad-hoc attendee email (schedule_meeting)
      // and an ad-hoc phone (notify_via_whatsapp) — the silent-drop that
      // caused the empty "With:" line.
      const meeting = normaliseAction({
        type: 'schedule_meeting',
        title: 'Meeting with Rafay',
        whenRaw: 'tomorrow 6pm',
        attendeeCandidateIds: [],
        attendeeAdHocEmails: ['rafayfrasat02@gmail.com'],
      });
      expect(meeting).not.toBeNull();
      expect((meeting as any).attendeeAdHocEmails).toContain('rafayfrasat02@gmail.com');

      const wa = normaliseAction({
        type: 'notify_via_whatsapp',
        recipientAdHocPhone: '+923710042740',
        message: 'hi',
      });
      expect(wa).not.toBeNull();
      expect((wa as any).recipientAdHocPhone).toBe('+923710042740');
    },
  },
  {
    id: 'chat2',
    date: '2026-07-08',
    userMessage: 'ask him status / send a test email … (Asad leave request)',
    observedFailure:
      'Brain replied "The email has been sent to Asad" without dispatching — a fabricated completion claim in passive voice that slipped past the first-person-only guard.',
    symptomTags: ['send-fabrication:email', 'capability-fabrication'],
    fixCommits: ['259f972', '459bd4d'],
    assert: () => {
      // Passive-voice + third-person completion claims MUST be detected
      // (the exact phrasing that shipped to the user).
      expect(claimsCompletion('Certainly, Sir. The email about the leave request has been sent to Asad Ahmed Taj.')).toBe(true);
      expect(claimsCompletion('Done. Delegated to Yousuf.')).toBe(true);
      // And habitual / conversational prose must NOT trip it (no false
      // positives that would nag the user).
      expect(claimsCompletion('I schedule my day at 8am.')).toBe(false);
      expect(claimsCompletion('Should I send this now?')).toBe(false);
    },
  },
  {
    id: 'chat3',
    date: '2026-07-08',
    userMessage: 'send a test email to sirabdulbasit@gmail.com',
    observedFailure:
      'A stale prompt-queue item captured the command; promptReplyHandler treated "send a test email…" as an ANSWER and replied "[noted]" instead of composing the email.',
    symptomTags: ['pending-prompt-eats-command', 'bracketed-marker-leak'],
    fixCommits: ['c977a3d'],
    assert: () => {
      // A new-chat imperative starting with send/email/notify/etc. MUST
      // fall through (not be captured as an answer to a stale prompt).
      for (const cmd of [
        'send a test email to sirabdulbasit@gmail.com',
        'email Asad about the invoice',
        'notify Yousaf the plan is ready',
        'schedule a meeting with Rafay',
      ]) {
        expect(looksLikeAnswer(cmd, 'noop')).toBe(false);
      }
      // And the [noted] marker must never reach the user raw.
      expect(sanitizeAnswerForUser('[noted]')).not.toContain('[noted]');
    },
  },
  {
    id: 'chat4',
    date: '2026-07-10',
    userMessage: 'ask status of EXIM',
    observedFailure:
      'EXIM is delegated to Muhammad Yousaf, but the brain proposed messaging Asad (the recently-discussed contact) — the open-items block gave reasoning the owner NAME but no routable id, so it substituted.',
    symptomTags: ['wrong-owner-routing', 'stale-contact-data'],
    fixCommits: ['680c441'],
    // NOTE: the buildOpenItemsBlockForReasoning binding proof needs a
    // prisma mock, so it lives in the dedicated openItemsOwnerRouting
    // test (loaded there, not here, to keep this registry mock-free).
    // The invariant this scenario pins at the registry level: the
    // reasoning owner-routing rule text exists in the prompt contract.
    assert: () => {
      // Guard the prompt contract that forbids substitution — if this
      // rule is ever removed, the wrong-owner class can silently return.
      // (Content check is deliberate: the rule is prompt-level, not code
      // branching, so a source assertion is the honest lock.)
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const { join } = require('node:path') as typeof import('node:path');
      const src = readFileSync(join(__dirname, '..', 'src', 'services', 'knowledge', 'reasoningCompose.ts'), 'utf-8');
      expect(src).toContain('Owner-routing contract');
      expect(src).toMatch(/delegatee_candidateId/);
      expect(src).toMatch(/NEVER substitute/i);
    },
  },
];
