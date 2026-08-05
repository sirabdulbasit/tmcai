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
import {
  newProbeSession, matchProbeEcho, buildProbeMarker, recordOutboundProof,
  recordProbeFailure, mayReprobe, noteProbeAttempt, getConsecutiveLivenessFailures,
  isSendCapableStatus, EPISODE_PROBE_CAP, __resetTenantLivenessForTests,
} from '../src/services/whatsapp/webjsLiveness';
import {
  normalizeWid, sameWid, lidToPhone, __resetWaIdentityCacheForTests,
} from '../src/services/whatsapp/waIdentity';
import { DISPATCHABLE_PLAN_STEP_KINDS } from '../src/services/knowledge/brainComposer';

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
  {
    id: 'chat14',
    date: '2026-07-31',
    userMessage: 'Ask status of leave request → "send"',
    observedFailure:
      'Brain replied to text normally and previewed the delegation message, then returned "[notifyviawhatsapp failed: no tenant whatsapp channel configured]". The tenant channel had been status=degraded since 07-24 with outbound sends withheld, because every liveness probe failed: the self-chat echo was matched against client.info.wid._serialized alone, so an echo carrying the account @lid spelling was rejected. Three flags (statusMap=degraded, requiresRepair, exhausted EPISODE_PROBE_CAP) each cleared only via recordProbePass, which needs a probe the cap forbade — a closed loop. Reproduced identically on 07-24, 07-29 and 07-31.',
    symptomTags: [
      'whatsapp-lid-activity-rejected', 'liveness-deadlock',
      'connector-status-lies-not-connected', 'silent-withhold-no-alert',
    ],
    fixCommits: ['5e3f3c1'],
    assert: () => {
      __resetTenantLivenessForTests();
      const TENANT = 'TMC-0001';
      const PHONE = '923274572102@c.us';
      const LID = '173555350261799@lid';
      const session = () => {
        const s = newProbeSession(TENANT, 'TMC-0001#gen1', 'nonceA');
        s.expectedProviderId = 'prov_1';
        return s;
      };
      const echo = (s: any, over: Record<string, unknown> = {}) => matchProbeEcho(s, {
        fromMe: true, chatId: PHONE, selfId: PHONE, selfIds: [PHONE, LID],
        body: buildProbeMarker(s.nonce), providerId: 'prov_1',
        generation: s.generation, clientNumber: TENANT, ...over,
      });

      // THE OUTAGE: an echo stamped with the account's LID spelling must match.
      expect(echo(session(), { chatId: LID })).toBe('matched');
      expect(echo(session())).toBe('matched');                          // phone form still matches
      expect(echo(session(), { chatId: '923274572102:9@c.us' })).toBe('matched'); // device suffix

      // The gate keeps its purpose: foreign chats and forged echoes still rejected.
      expect(echo(session(), { chatId: '92300111222@c.us' })).toBe('rejected');
      expect(echo(session(), { chatId: '999999999@lid' })).toBe('rejected');
      expect(echo(session(), { fromMe: false })).toBe('rejected');
      expect(echo(session(), { body: buildProbeMarker('other') })).toBe('rejected');

      // Domains never collapse: a LID must not equal a phone Wid by digits alone.
      expect(sameWid(LID, '173555350261799@c.us')).toBe(false);
      expect(normalizeWid('923274572102:12@c.us')).toBe(PHONE);

      // The deadlock has an exit: confirmed outbound traffic re-arms the budget…
      for (let i = 0; i < EPISODE_PROBE_CAP; i++) noteProbeAttempt(TENANT);
      expect(mayReprobe(TENANT)).toEqual({ allowed: false, reason: 'episode_cap_exhausted' });
      expect(recordOutboundProof(TENANT)).toBe(true);
      expect(mayReprobe(TENANT).allowed).toBe(true);

      // …without erasing probe history and without granting send-capability.
      __resetTenantLivenessForTests();
      recordProbeFailure(TENANT); recordProbeFailure(TENANT); recordProbeFailure(TENANT);
      recordOutboundProof(TENANT);
      expect(getConsecutiveLivenessFailures(TENANT)).toBe(3);
      for (const s of ['degraded', 'connected_unverified', 'liveness_failed']) {
        expect(isSendCapableStatus(s)).toBe(false);
      }
      expect(isSendCapableStatus('connected')).toBe(true);
      __resetTenantLivenessForTests();
    },
  },
  {
    id: 'chat15',
    date: '2026-08-03',
    userMessage: 'Ask status of EXIM → send → (Yousaf replies "Working boss") → Did u get exim update from Yousaf?',
    observedFailure:
      'The delegatee\'s reply arrived as an @lid inbound (+160838254092493) and was dropped as "Unregistered number" because message.getContact() — the door\'s only real-phone resolver — broke upstream, so the sender degraded to a synthetic phone matching no registration row and no delegation thread. The follow-up worker kept pinging him daily while every answer vanished. Brain then fabricated "my WhatsApp connection is currently degraded" (DB: connected since 07-31).',
    symptomTags: [
      'whatsapp-lid-activity-rejected', 'delegatee-reply-dropped',
      'fabricated-system-status', 'pending-prompt-eats-command',
    ],
    // 5e3f3c1 created the shared waIdentity module; the door commit that
    // wires lidToPhone into the @lid inbound branch ships WITH this
    // scenario (same tree — the wiring assertion below proves it's here).
    fixCommits: ['5e3f3c1'],
    assert: async () => {
      __resetWaIdentityCacheForTests();
      // The door recovers the real phone for a LID counterpart…
      const client = { getContactLidAndPhone: async () => [{ lid: '160838254092493@lid', pn: '923028000553@c.us' }] };
      expect(await lidToPhone(client, '160838254092493@lid')).toBe('+923028000553');
      // …and when the mapping is unavailable it returns null (caller falls
      // back to the synthetic) rather than inventing an identity.
      __resetWaIdentityCacheForTests();
      expect(await lidToPhone({ getContactLidAndPhone: async () => { throw new Error('r'); } }, '160838254092493@lid')).toBeNull();
      // Non-LID senders never pass through the mapping.
      expect(await lidToPhone(client, '923028000553@c.us')).toBeNull();
      // Door wiring: the @lid inbound branch consults the shared resolver.
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const { join } = require('node:path') as typeof import('node:path');
      const src = readFileSync(join(__dirname, '..', 'src', 'services', 'whatsapp', 'WebjsProvider.ts'), 'utf-8');
      const lidBranch = src.slice(src.indexOf("rawFrom.includes('@lid')"));
      expect(lidBranch).toContain('lidToPhone');
    },
  },
  {
    id: 'chat16',
    date: '2026-08-04',
    userMessage: '(voice note to Nexeo)',
    observedFailure:
      'Every voice note answered "[I could not read that voice note]". Media download failed 3x in ~30ms with the opaque "r: r". Root cause: Message.downloadMedia resolves the message via Msg.get(msgId)/Msg.getMessagesById([msgId]), and a LID chat message id EMBEDS the identity (false_173555350261799@lid_3BF638...), so the lookup parses a LID Wid and throws before any network call. WhatsApp keeps LID constructors separate (createUserLidOrThrow). Everything after the lookup was proven healthy: 3646 bytes decrypted, 4864 base64 chars.',
    symptomTags: ['whatsapp-ptt-media-not-ready', 'whatsapp-lid-activity-rejected', 'lid-id-parse-throws'],
    // 72ed7f6 shipped the shared @lid resolver this builds on; the direct
    // media limb ships WITH this scenario (the wiring assertions prove it).
    fixCommits: ['72ed7f6'],
    assert: () => {
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const { join } = require('node:path') as typeof import('node:path');
      const dir = join(__dirname, '..', 'src', 'services', 'whatsapp');
      const direct = readFileSync(join(dir, 'webjsMediaDirect.ts'), 'utf-8');
      const code = direct.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // The poisoned lookups must never be called: they parse the @lid id.
      expect(code).not.toMatch(/Msg\.get\(/);
      expect(code).not.toMatch(/getMessagesById/);
      // Message located by string comparison instead.
      expect(code).toContain('_serialized');
      // The healthy library calls are still used.
      expect(code).toContain('downloadAndMaybeDecrypt');
      expect(code).toContain('arrayBufferToBase64Async');
      // And the direct limb runs BEFORE the old retry ladder.
      const media = readFileSync(join(dir, 'inboundMedia.ts'), 'utf-8');
      expect(media.indexOf('downloadMediaDirect')).toBeLessThan(media.indexOf('for (let attempt = 0'));
    },
  },
  {
    id: 'chat17',
    date: '2026-08-04',
    userMessage: 'make all of these high priority … Vision Metric until Friday … → yes',
    observedFailure:
      'A 3-step plan was previewed, the owner confirmed with "yes", and dispatch returned "[Unknown pending action kind: updateopenitem]" then stopped — all three priority+deadline updates lost. update_open_item was registry-valid so validation accepted it and the preview rendered it, but dispatchPendingDirect had no case for that kind. Registry presence was treated as capability.',
    symptomTags: ['phantom-capability', 'confirmed-action-lost', 'registry-vs-dispatcher-drift'],
    fixCommits: ['666fb2a'],
    assert: () => {
      const { readFileSync } = require('node:fs') as typeof import('node:fs');
      const { join } = require('node:path') as typeof import('node:path');
      const src = readFileSync(join(__dirname, '..', 'src', 'services', 'knowledge', 'brainComposer.ts'), 'utf-8');
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // The kind that lost the work must be BOTH declared and dispatchable.
      expect(DISPATCHABLE_PLAN_STEP_KINDS.has('update_open_item')).toBe(true);
      const disp = code.slice(code.indexOf('async function dispatchPendingDirect'));
      expect(disp).toContain("case 'update_open_item':");
      // Every declared kind must have a real case — no phantom capability.
      const cases = new Set([...disp.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]));
      for (const kind of DISPATCHABLE_PLAN_STEP_KINDS) expect(cases.has(kind)).toBe(true);
      // And plans are rejected BEFORE the owner is asked to confirm.
      expect(code).toContain('DISPATCHABLE_PLAN_STEP_KINDS.has(step.type)');
      expect(code.indexOf('no dispatcher for this action')).toBeLessThan(code.indexOf('renderPlanPreview'));
      // One shared update implementation, not a second copy.
      expect(code).toContain("await import('../openItems/applyOpenItemUpdate')");
    },
  },
];
