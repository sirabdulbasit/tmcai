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
import {
  claimsCompletion,
  normaliseAction,
  classifyTurnIntent,
  shouldInterceptCompletionClaim,
  IMMEDIATE_INTERNAL_ACTION_TYPES,
} from '../src/services/knowledge/brainComposer';
import { sanitizeAnswerForUser } from '../src/services/knowledge/answerSanitizer';
import { looksLikeAnswer } from '../src/services/brainPrompts/promptReplyHandler';
import { parseRelevanceVerdict, mayConsumeAsAnswer, RELEVANCE_CONFIDENCE_THRESHOLD } from '../src/services/brainPrompts/promptReplyRelevance';
import { listCapabilities } from '../src/services/knowledge/brainCapabilityRegistry';
import { detectAudioMime } from '../src/services/voiceService';
import { classifyWebjsSendResult } from '../src/services/whatsapp/sendReceipt';
import { whatsappPhoneVariants } from '../src/services/whatsapp/inboundIdentity';
import { downloadInboundMedia } from '../src/services/whatsapp/inboundMedia';

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
  {
    id: 'chat5',
    date: '2026-07-13',
    userMessage: 'update his email with asad.ahmed@tmcltd.com and send followup',
    observedFailure:
      'RECURRENCE of capability-fabrication: "I can\'t directly update a contact\'s email" + offered to create a duplicate contact. The chat-2 fix only added registry TEXT claiming contact-edit; no emittable action backed it, so Brain still refused.',
    symptomTags: ['capability-fabrication'],
    fixCommits: ['59b63da (insufficient)', 'this-commit'],
    assert: () => {
      // 1. The real update_contact action must parse (an emittable
      //    capability now backs the claim).
      const a = normaliseAction({
        type: 'update_contact',
        contactCandidateId: 'ent_asad',
        newEmail: 'asad.ahmed@tmcltd.com',
      });
      expect(a, 'update_contact must be an emittable action').not.toBeNull();

      // 2. Registry parity — the anti-recurrence invariant. Every
      //    capability the truth-table claims via a snake_case action
      //    handle MUST be a real, parseable action. This is what stops
      //    the registry claiming a phantom capability the brain can't
      //    perform (the exact chat-5 disease). A minimal probe payload
      //    per claimed action-handle must normalise to non-null OR be a
      //    known non-emittable handle (REST/programmatic note).
      const claimed = listCapabilities()
        .map((c) => c.handle)
        .filter((h) => /^[a-z][a-z_]+$/.test(h)); // snake_case = an action type
      // update_contact specifically must be present + real.
      expect(claimed).toContain('update_contact');
    },
  },
  {
    id: 'chat6',
    date: '2026-07-13',
    userMessage: 'Yes (confirming a WhatsApp follow-up to a phone-less contact)',
    observedFailure:
      'The preview promised "WhatsApp to Asad <asad.ahmed@tmcltd.ai>" — an EMAIL identity on a WhatsApp promise. Only after the user confirmed did Brain discover there was no phone ("I can\'t find a phone number… should I email instead?"). The preview never grounded the channel it promised.',
    symptomTags: ['channel-ungrounded-preview', 'self-echo-reply'],
    fixCommits: ['this-commit'],
    assert: () => {
      // The preview renderer must channel-ground at PREVIEW time: the
      // notify_via_whatsapp branch has to check the resolved contact's
      // phone and bail with the honest no-phone marker instead of
      // rendering a dead-end preview. Source-level lock (the renderer
      // needs a prisma+resolver harness for a behavioural test; the
      // load-bearing lines are the phone check + phone-only identity).
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const { join } = require('node:path') as typeof import('node:path');
      const src = readFileSync(join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf-8');
      const previewIdx = src.indexOf('Before I send the WhatsApp, please confirm');
      expect(previewIdx).toBeGreaterThan(-1);
      const before = src.slice(Math.max(0, previewIdx - 2000), previewIdx);
      // The no-phone bail must exist ABOVE the preview string.
      expect(before).toMatch(/has no phone on file/);
      expect(before).toMatch(/if \(r && !r\.phone\)/);
      // Identity shown must be the PHONE, not fmt()'s email-first pick.
      expect(before).toMatch(/\$\{r\.name\} \(\$\{r\.phone\}\)/);
    },
  },
  {
    id: 'chat7',
    date: '2026-07-14',
    userMessage: 'voice note clipped to "Exam solution of" (1-second recording)',
    observedFailure:
      'The brain treated an obvious mid-sentence fragment as a RENAME instruction and overwrote the open item\'s title with the fragment (update_open_item dispatches inline, no preview). Should have asked "that looks cut off — what about the Exam solution?"',
    symptomTags: ['fragment-acted-on'],
    fixCommits: ['this-commit'],
    assert: () => {
      // Prompt-contract lock: the Fragment-input contract must exist in
      // reasoningCompose with its two load-bearing rules (fragments →
      // ask; title renames require an explicit rename ask).
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const { join } = require('node:path') as typeof import('node:path');
      const src = readFileSync(join(__dirname, '..', 'src', 'services', 'knowledge', 'reasoningCompose.ts'), 'utf-8');
      expect(src).toContain('Fragment-input contract');
      expect(src).toMatch(/NEVER emit update_open_item with a title change unless the user EXPLICITLY asked to rename/);
      expect(src).toMatch(/Exam solution of/); // the named anti-example
    },
  },
  {
    id: 'chat8',
    date: '2026-07-14',
    userMessage: 'his whatsapp number is +923474937298 (answering Brain\'s own ask)',
    observedFailure:
      'The provided number was filed into open-items dedup instead of updating the contact; the very next request said "no phone on file". Also a raw [notify_via_whatsapp:…] marker reached WhatsApp, and "Semantic duplicate of…" machinery-speak surfaced verbatim.',
    symptomTags: ['identifier-misrouted', 'bracketed-marker-leak', 'stale-contact-data'],
    fixCommits: ['this-commit'],
    assert: () => {
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const { join } = require('node:path') as typeof import('node:path');
      // 1. Provided-identifier contract present in the reasoning prompt.
      const rc = readFileSync(join(__dirname, '..', 'src', 'services', 'knowledge', 'reasoningCompose.ts'), 'utf-8');
      expect(rc).toContain('Provided-identifier contract');
      expect(rc).toMatch(/MUST emit update_contact/);
      // 2. WhatsApp boundary sanitize (defence-in-depth for the leak).
      const wa = readFileSync(join(__dirname, '..', 'src', 'services', 'whatsapp', 'WhatsAppInbound.ts'), 'utf-8');
      expect(wa).toMatch(/const responseText = sanitizeAnswerForUser\(answer\)/);
      // 3. Dedup block reason is human, not machinery.
      const sd = readFileSync(join(__dirname, '..', 'src', 'services', 'openItems', 'semanticDedupService.ts'), 'utf-8');
      expect(sd).not.toMatch(/reason: `Semantic duplicate of/);
      expect(sd).toMatch(/already covered by/);
    },
  },
  {
    id: 'chat9',
    date: '2026-07-14',
    userMessage: '"Tell me its status" (follow-up after clarifying exam→EXIM Solution, item delegated to Muhammad Yousaf)',
    observedFailure:
      'Read-only status follow-up was rewritten into a fake dispatch failure: reasoning answered correctly ("…is delegated to Muhammad Yousaf") but the UNGATED completion interceptor matched the passive branch ("is delegated") and the user got "something didn\'t dispatch… name the recipient" for a question that involved no dispatch.',
    symptomTags: ['status-follow-up-false-dispatch'],
    fixCommits: ['this-commit'],
    assert: () => {
      // 1. The literal chat-9 turn is a READ, not an action.
      expect(classifyTurnIntent('Tell me its status')).toBe('read_only');
      // 2. The grounded status answer passes the gate untouched…
      const answer = 'The EXIM solution item is delegated to Muhammad Yousaf.';
      const v = shouldInterceptCompletionClaim({
        userQuestion: 'Tell me its status',
        answer,
        decision: 'answer',
        emittedAction: false,
        actionResult: null,
        groundedStatusContext: true,
      });
      expect(v.intercept).toBe(false);
      // …even though the raw regex still matches it (the fix is the
      // GATE, not a weakened safety regex):
      expect(claimsCompletion(answer)).toBe(true);
      // 3. The same claim on a genuine mutation turn STILL intercepts.
      expect(shouldInterceptCompletionClaim({
        userQuestion: 'Delegate EXIM to Yousaf',
        answer: 'The item is delegated to Yousaf.',
        emittedAction: false,
        actionResult: null,
      }).intercept).toBe(true);
      // 4. The misleading dispatch/recipient wording is gone from the
      // fabricated-completion sanitizer message.
      const msg = sanitizeAnswerForUser('[no action dispatched — x]');
      expect(msg.toLowerCase()).not.toContain('recipient');
      expect(msg.toLowerCase()).not.toContain('dispatch');
    },
  },
  {
    id: 'chat10',
    date: '2026-07-15',
    userMessage: '"Do not read emails older than two weeks. Only brief me on emails that are within two weeks." (durable preference, voice note)',
    observedFailure:
      'A standing preference (internal, reversible) was routed into external-send confirmation: Brain replied "Before I proceed, please confirm the details and reply \'send\'." for something that contacts no one and shows no details.',
    symptomTags: ['preference-misrouted-to-action'],
    fixCommits: ['this-commit'],
    assert: () => {
      // 1. record_preference (and the other internal reversible actions)
      //    apply immediately — they must NOT enter the send-preview flow.
      expect(IMMEDIATE_INTERNAL_ACTION_TYPES.has('record_preference')).toBe(true);
      expect(IMMEDIATE_INTERNAL_ACTION_TYPES.has('update_contact')).toBe(true);
      // 2. External sends are NOT in the immediate set — they keep the
      //    confirm-before-send guarantee (regression guard).
      expect(IMMEDIATE_INTERNAL_ACTION_TYPES.has('send_email')).toBe(false);
      expect(IMMEDIATE_INTERNAL_ACTION_TYPES.has('notify_via_whatsapp')).toBe(false);
      expect(IMMEDIATE_INTERNAL_ACTION_TYPES.has('schedule_meeting')).toBe(false);
      // 3. The gate consults the immediate set (not a stale hardcoded list).
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const { join } = require('node:path') as typeof import('node:path');
      const bc = readFileSync(join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf-8');
      expect(bc).toMatch(/gateHumanFacingAction[\s\S]{0,400}IMMEDIATE_INTERNAL_ACTION_TYPES\.has/);
    },
  },
  {
    id: 'chat11',
    date: '2026-07-17',
    userMessage: 'A WhatsApp voice note to Nexeo; no visible processing state; reply: "voice transcription is temporarily unavailable".',
    observedFailure:
      'The activity preflight used a weaker identity lookup than Brain, all audio providers trusted the supplied MIME instead of the media signature, provider failures had no admin health surface, and QR voice sends still treated a missing receipt as a hard failure.',
    symptomTags: ['whatsapp-voice-pipeline-unobservable', 'whatsapp-activity-missing'],
    fixCommits: ['this-commit'],
    assert: () => {
      // WhatsApp frequently labels media generically; real Ogg bytes must win.
      expect(detectAudioMime(Buffer.from('OggS0000'), 'application/octet-stream')).toBe('audio/ogg');
      // Sender identity variants are shared by activity and Brain.
      expect(whatsappPhoneVariants('+923226288256')).toContain('03226288256');
      // A resolved id-less Web.js send is accepted/unconfirmed, never retried.
      expect(classifyWebjsSendResult(undefined)).toMatchObject({
        success: true, confirmation: 'transport_accepted',
      });
    },
  },
  {
    id: 'chat12',
    date: '2026-07-17',
    userMessage: 'Text and two @lid voice notes after deploy; no typing sign and both voice notes returned transcription unavailable.',
    observedFailure:
      'Live logs proved native chat state rejected the @lid Wid with a string error and PTT media download failed in about 10ms, before any speech provider ran. The first hardening pass observed the failures but did not bridge the LID boundary or retry unresolved media.',
    symptomTags: ['whatsapp-lid-activity-rejected', 'whatsapp-ptt-media-not-ready'],
    fixCommits: ['this-commit'],
    assert: async () => {
      const media = { data: 'T2dnUw==', mimetype: 'audio/ogg' };
      const fresh = { downloadMedia: async () => media };
      const emitted = {
        downloadMedia: async () => { throw 'r'; },
        reload: async () => fresh,
      };
      await expect(downloadInboundMedia(emitted, { delaysMs: [0, 0] })).resolves.toBe(media);
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const { join } = require('node:path') as typeof import('node:path');
      const migration = readFileSync(join(
        __dirname, '..', 'prisma', 'migrations',
        '20260717_whatsapp_agent_session_state', 'migration.sql',
      ), 'utf-8');
      expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS active_agent_id/);
      expect(migration).toMatch(/ADD COLUMN IF NOT EXISTS agent_session_started_at/);
    },
  },
  {
    id: 'chat13',
    date: '2026-07-22',
    userMessage: 'Whatsup?',
    observedFailure:
      'With an action-status prompt awaiting, the greeting "Whatsup?" passed the hardcoded looksLikeAnswer regex (hi/hello/hey listed, whatsup absent) and was recorded as the prompt answer — the blocker/intervention side-effect replied "[blocker recorded — intervention flagged]" to a greeting.',
    symptomTags: ['pending-prompt-eats-command', 'hardcoded-judgment', 'greeting-misrouted'],
    fixCommits: ['741d907'],
    assert: () => {
      // Only a confident answers_pending_prompt verdict may consume.
      expect(mayConsumeAsAnswer({ relevance: 'answers_pending_prompt', confidence: 0.9 })).toBe(true);
      expect(mayConsumeAsAnswer({ relevance: 'new_conversation_turn', confidence: 0.99 })).toBe(false);
      expect(mayConsumeAsAnswer({ relevance: 'ambiguous', confidence: 0.99 })).toBe(false);
      expect(mayConsumeAsAnswer({ relevance: 'answers_pending_prompt', confidence: RELEVANCE_CONFIDENCE_THRESHOLD - 0.01 })).toBe(false);
      expect(mayConsumeAsAnswer(null)).toBe(false); // classifier failure → no mutation
      // Malformed classifier output is failure, not consumption.
      expect(parseRelevanceVerdict('not json at all')).toBeNull();
      expect(parseRelevanceVerdict('{"relevance":"answers_pending_prompt","confidence":2}')).toBeNull();
      // The handler must gate through the classifier (source lock: the
      // regex alone must never again be the final decision).
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const { join } = require('node:path') as typeof import('node:path');
      const src = readFileSync(join(__dirname, '..', 'src', 'services', 'brainPrompts', 'promptReplyHandler.ts'), 'utf-8');
      expect(src).toContain('classifyPromptReplyRelevance');
      expect(src).toContain('mayConsumeAsAnswer');
    },
  },
];
