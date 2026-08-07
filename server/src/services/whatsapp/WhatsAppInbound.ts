// ═════════════════════════════════════════════════════════════════════════════
// WhatsAppInbound — Handles incoming WhatsApp messages (2-way communication)
//
// Flow: Inbound message → identify user → load/create session → call TMCAI
//       chat pipeline → send reply via WhatsApp
// ═════════════════════════════════════════════════════════════════════════════

import { recordFinding } from '../selfheal/healthFindingService';
import prisma from '../../db/prisma';
import { sendWhatsAppMessage } from './WhatsAppManager';
import { askBrainWithRetry } from './brainRetry';
import { learnFromMessage } from '../learningService';
import createLogger from '../../utils/logger';
import { resolveRegisteredWhatsAppUser } from './inboundIdentity';

const log = createLogger('whatsapp:inbound');

export interface InboundParams {
  clientNumber: string;
  fromNumber: string;       // E.164: +923001234567
  messageBody: string;
  messageType: 'text' | 'image' | 'voice' | 'document';
  mediaUrl?: string;
  waMessageId?: string;
  /** Provider id of the message this inbound quotes/replies to, when
   *  the transport exposes it — preferred delegation correlation key. */
  quotedProviderId?: string;
  /** DEF-075 — the RAW WhatsApp sender id, e.g. `255043747987458@lid`.
   *  `fromNumber` may be a SYNTHETIC phone derived from a LID when neither
   *  getContact() nor the mapping API could resolve the real number. The
   *  synthetic matches nothing, so correlation needs the raw id to bind by
   *  alias instead. */
  rawSenderId?: string;
  timestamp?: number;
  replyFn?: (text: string) => Promise<{
    success: boolean;
    messageId?: string;
    confirmation?: 'provider_receipt' | 'transport_accepted';
    error?: string;
  } | void>;
  typingFn?: () => Promise<void>;  // Shows "typing..." indicator in WhatsApp
  /** Set by handleInboundMessage after identity resolution; used by
   *  sendReply so the outbound whatsapp_messages row carries a valid
   *  user_id (column is NOT NULL — previously the insert failed silently). */
  _resolvedUserId?: number;
  _resolvedIdentity?: import('./inboundIdentity').RegisteredWhatsAppUser | null;
}

// Dedup: prevent processing same message twice (WhatsApp Web.js can fire duplicate events)
const recentMessages = new Map<string, number>(); // key → timestamp
const DEDUP_WINDOW_MS = 5000; // 5 seconds

export function inboundDedupKey(params: Pick<InboundParams, 'waMessageId' | 'fromNumber' | 'messageBody'>): string {
  return params.waMessageId
    ? `id:${params.waMessageId}`
    : `fallback:${params.fromNumber}:${params.messageBody}`;
}


/**
 * Speak a system marker instead of printing it.
 *
 * Owner, 2026-08-07: *"i don't want robotic answers if i talk to brain neither
 * anyone else talk to brain"*. These three session-transition markers were the
 * worst offenders in the codebase — they never went through the sanitizer at
 * all, so the owner received literal square brackets describing his own session
 * state, e.g. `[agent session ended — Faria idle 10+ min; routing to main AI]`.
 *
 * The marker remains the honest internal signal (no invented prose about what
 * happened); only its delivery changes. Falls back to the raw marker if the
 * renderer is unavailable, because a bracket the user can read beats silence.
 */
async function sayMarker(params: InboundParams, marker: string, userId?: number): Promise<void> {
  try {
    const { sanitizeAnswerInBrainVoice } = await import('../knowledge/answerSanitizer');
    await sendReply(params, await sanitizeAnswerInBrainVoice(marker, {
      clientNumber: params.clientNumber,
      userId,
      audience: 'owner',
      userMessage: params.messageBody,
    }));
  } catch {
    await sendReply(params, marker);
  }
}

export async function handleInboundMessage(params: InboundParams): Promise<void> {
  const startedAt = Date.now();
  // Dedup check
  const dedupKey = inboundDedupKey(params);
  const now = Date.now();
  const lastSeen = recentMessages.get(dedupKey);
  if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) {
    log.info('Duplicate message ignored', { from: params.fromNumber, body: params.messageBody.slice(0, 30) });
    return;
  }
  recentMessages.set(dedupKey, now);
  // Cleanup old entries
  for (const [k, t] of recentMessages) { if (now - t > 30000) recentMessages.delete(k); }

  // Skip empty messages
  if (!params.messageBody || !params.messageBody.trim()) return;

  log.info('Inbound', { clientNumber: params.clientNumber, from: params.fromNumber, type: params.messageType });

  // ── Step 1: Check if sender's number is registered ────────────────────────
  //
  // Per Basit 2026-06-10: "anyone who sends message to brain through
  // whatsapp will not be saved or entertain if user is not registered".
  // The registration check MUST run BEFORE any DB write. Previously we
  // inserted the inbound message into whatsapp_messages here (with a
  // fallback SA user_id) before doing the lookup — so unregistered
  // senders' messages were getting saved to the audit table even though
  // Brain never replied. Now: lookup first, drop without writing if
  // unregistered. PM2 log line is the ONLY persisted record of
  // unregistered traffic — admins can grep it if they need to audit.
  //
  const resolvedIdentity = params._resolvedIdentity === undefined
    ? await resolveRegisteredWhatsAppUser(params.clientNumber, params.fromNumber)
    : params._resolvedIdentity;

  // Unknown number — silently drop the message.
  //
  // Why ignore + don't save:
  //   1. Privacy / data-hygiene — unregistered senders' bodies stay out
  //      of whatsapp_messages, whatsapp_sessions, feed_events.
  //   2. Replying confirms to the sender that this is an automated
  //      business number, attracting spam/scrapers.
  //   3. Every reply consumes a slot from the tenant's daily cap;
  //      auto-replying to wrong-number / spam senders burns it.
  //   4. A real user who needs access gets onboarded by their admin
  //      via the Settings page; they don't need a reply from the bot.
  //
  // PM2 log line is the only persisted record — admins can grep it.
  if (!resolvedIdentity) {
    // Narrow exception (Section 33a, replaces expectedExternalReplyService's
    // 14-day text-inference matcher): a delegatee may reply to a tracked
    // delegation thread. Explicit correlation only — quoted provider id, or
    // exactly one active thread for this counterpart. Capture is evidence +
    // owner notification; it never enters the chatbot path, never replies,
    // reacts, or echoes to the sender. Flag-gated; OFF ⇒ pre-33a silent drop.
    const { captureDelegationReply } = await import('../delegation/delegationCaptureService');
    const captured = await captureDelegationReply({
      clientNumber: params.clientNumber,
      channel: 'whatsapp',
      fromIdentifier: params.fromNumber,
      rawSenderId: params.rawSenderId ?? null,
      body: params.messageBody,
      sourceId: params.waMessageId
        ?? `external:${params.fromNumber}:${params.timestamp ?? Date.now()}:${params.messageBody.slice(0, 40)}`,
      quotedProviderId: params.quotedProviderId ?? null,
    }).catch((e: any) => {
      log.warn('delegation capture failed', { error: e.message });
      return { matched: false as const };
    });
    if (captured.matched) return;

    // Section 35 Phase 1 (owner ruling 2026-08-04): no more silent drop.
    // Standing ignore → drop; allowed/concern-evidence → relay to owner;
    // unknown → mark pending + ask the owner ONCE. Triage never throws
    // and never replies to the sender (that is Phase 2).
    const { triageUnregisteredInbound } = await import('./senderTriage');
    const outcome = await triageUnregisteredInbound({
      clientNumber: params.clientNumber,
      fromNumber: params.fromNumber,
      body: params.messageBody,
    });
    log.info('Unregistered number — triaged', {
      from: params.fromNumber,
      clientNumber: params.clientNumber,
      action: outcome.action,
      bodyPrefix: params.messageBody.slice(0, 60),
    });
    return;
  }

  const userId = resolvedIdentity.userId;
  const userName = resolvedIdentity.displayName || resolvedIdentity.userName || 'there';
  let queryText = params.messageBody;

  // Now that registration is confirmed, log the inbound to
  // whatsapp_messages with the resolved user_id (no more SA fallback).
  // This row is the audit trail for the conversation we ARE entertaining.
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO whatsapp_messages (client_number, user_id, direction, from_number, to_number, content, message_type, status, created_at)
       VALUES ($1, $2, 'inbound', $3, '', $4, $5, 'received', NOW())`,
      params.clientNumber, userId, params.fromNumber, params.messageBody, params.messageType,
    );
  } catch (err: any) {
    log.warn('inbound log insert failed', { error: err.message });
  }

  // Thread the resolved userId onto params so sendReply's log insert
  // carries it — whatsapp_messages.user_id is NOT NULL and the outbound
  // row was previously being swallowed by an empty catch.
  params._resolvedUserId = userId;

  log.info('Identified user', { from: params.fromNumber, userId, name: userName });
  log.info('Inbound stage completed', {
    stage: 'identity', userId, messageId: params.waMessageId,
    elapsedMs: Date.now() - startedAt, type: params.messageType,
  });

  // Show "typing..." indicator immediately so user knows bot is working
  if (params.typingFn) await params.typingFn().catch(() => {});

  // ── Step 1.4: Negative-feedback shortcut ─────────────────────────────────
  // Phrases like "shouldn't be", "stop", "ignore this", "don't care",
  // "leave me alone" sent in response to a recent Brain bundle / prompt
  // are FEEDBACK, not chat questions. Treat them as an explicit demote
  // signal on whatever Brain most-recently nudged the user about, so
  // Brain learns instead of explaining itself again.
  try {
    const { tryConsumeAsFeedback } = await import('../brainPrompts/negativeFeedbackHandler');
    const fb = await tryConsumeAsFeedback({ userId, clientNumber: params.clientNumber, text: queryText });
    if (fb.handled) {
      log.info('consumed as negative feedback', { userId, action: fb.action });
      if (fb.ackMessage) await sendReply(params, fb.ackMessage);
      return;
    }
  } catch (err: any) {
    log.warn('negative-feedback handler errored — falling through', { err: err.message });
  }

  // ── Step 1.5: Brain prompt queue reply ───────────────────────────────────
  // If Brain is currently asking the user a question (brain_prompt_queue
  // row in awaiting_reply), this inbound message IS the answer. Apply the
  // side-effect, ack, and dispatch the next prompt — do NOT route to the
  // chat LLM. Bypass session control / email-detection paths because those
  // would mis-classify a one-word date answer like "friday" as gibberish
  // and burn a chat turn.
  try {
    const { handlePromptReply } = await import('../brainPrompts/promptReplyHandler');
    const r = await handlePromptReply({ userId, text: queryText });
    if (r.handled) {
      log.info('consumed as prompt reply', {
        userId, promptId: r.promptId, sideEffect: r.sideEffectStatus,
      });
      if (r.ackMessage) {
        // DEF-083: sanitise here too. The composer path runs
        // sanitizeAnswerForUser; this one never did, so promptReplyHandler's
        // machine markers reached the owner verbatim — 2026-08-06 20:52 he got
        // a bare "[noted]" as an answer. The marker vocabulary was correct and
        // the renderer was simply not on this path.
        // 2026-08-07, owner: *"i don't want robotic answers"*. A bare "[noted]"
        // became "Got it — noted." every single time, which is the same machine
        // wearing a politer mask. The marker stays the internal signal; the
        // spoken form is now generated, so it varies and matches his language.
        const { sanitizeAnswerInBrainVoice } = await import('../knowledge/answerSanitizer');
        await sendReply(params, await sanitizeAnswerInBrainVoice(r.ackMessage, {
          clientNumber: params.clientNumber,
          userId,
          audience: 'owner',
          userMessage: params.messageBody,
        }));
      }
      // A6: the answer may carry a piggybacked directive ("tomorrow, and always
      // remind me at 5pm"). Plain answers must come back intent='none'.
      //
      // DEF-093 — that guarantee failed on 2026-08-07 22:09 and cost the owner a
      // junk task. Brain asked "what priority and deadline?", he answered "High
      // immediate", the prompt handler consumed it correctly (`sideEffect:
      // applied`), and one second later this extractor read the same two words
      // with no idea a question had been asked, judged them a new instruction,
      // and created an open item titled "High immediate".
      //
      // Two mechanisms were deciding the same thing. The relevance classifier
      // already splits a compound reply into answer + residual (DEF-017); this
      // extractor was independently re-reading the FULL text. One rule, two
      // implementations — the shape behind DEF-039/041/044/045/051/074/078.
      //
      // Single-sourced now: when the classifier found a residual, only the
      // residual is offered. Either way the extractor is told what question was
      // answered, so it judges what is LEFT OVER instead of guessing in the
      // blind.
      const { handlePiggybackedInstruction } = await import('../brainPrompts/piggybackedInstruction');
      const pb = await handlePiggybackedInstruction({
        text: r.residualText ?? queryText,
        clientNumber: params.clientNumber,
        userId,
        answeredQuestion: r.answeredQuestion ?? null,
      });
      if (pb.dispatched && pb.ackMessage) {
        // Same boundary, same reason.
        await sendReply(params, pb.ackMessage);
      }
      // DEF-017 (2026-08-05, 3rd recurrence of pending-prompt-eats-command):
      // a COMPOUND message ("Priority High, due date today and delegate to
      // Hamna Latif") has its answer half recorded above; the instruction half
      // must still be acted on. Previously we returned here unconditionally and
      // the rest was silently discarded — a fabricated deadline, a junk task,
      // and no delegation. Route the residual through the SAME chat path every
      // other turn uses rather than a parallel extractor with a narrower
      // vocabulary (invariant: one compose path, no surface-specific
      // shortcuts).
      if (r.residualText) {
        log.info('prompt reply was partial — routing the residual to chat', {
          userId, promptId: r.promptId, residualPreview: r.residualText.slice(0, 80),
        });
        queryText = r.residualText;
        // fall through — do NOT return
      } else {
        return;  // whole message was the answer; do NOT continue to chat router
      }
    }
  } catch (err: any) {
    log.warn('prompt reply handler errored — falling through to chat', { err: err.message });
  }

  // ── Step 2: Session control commands ─────────────────────────────────────
  // Keyword shortcut for session close. The DB action stays; the reply
  // is a SYSTEM marker (bracketed) so it's clearly machine-generated
  // status, not Brain pretending to speak. Per Basit 2026-05-20:
  // "don't hardcode anything this is the crime in building AI" — system
  // status messages are honest; fake-Brain greetings are not.
  const lower = queryText.toLowerCase().trim();
  if (['bye', 'stop', 'end', 'quit', 'exit'].includes(lower)) {
    await prisma.$executeRawUnsafe(
      `UPDATE whatsapp_sessions SET closed_at = NOW() WHERE user_id = $1 AND client_number = $2 AND closed_at IS NULL`,
      userId, params.clientNumber,
    );
    await sayMarker(params, `[session ended — send any message to resume]`);
    return;
  }

  // ── Step 2b REMOVED 2026-05-20: email-report fast-path ────────────────────
  // The old code ran a regex over Brain's last reply to detect "Brain
  // offered email" + a regex over the user's message to detect "user
  // said yes", and on both matches generated a structured business
  // report and emailed it to the user.
  //
  // The trigger was wrong. Observed 2026-05-20 on Basit's session:
  //   1. Basit: "send email to asad and ask when haseeb is coming back"
  //   2. Brain: disambiguation listing 2 Asads + 2 Haseebs, where the
  //      contact metadata for Asad happened to contain the substring
  //      "sends meeting notes for HEDP via email".
  //   3. Basit: "yes this asad" — meant as a disambiguation answer.
  //   4. `brainOfferedEmail` regex `send.*via.*email` matched the
  //      contact metadata. `isShortAffirmation` matched "yes…". Both
  //      gates true → email-report fast-path fired → Brain generated
  //      a Day Brief and emailed it to Basit instead of continuing the
  //      send-email pending action to Asad.
  //
  // Same architectural sin as the deleted greeting fast-path: a
  // hardcoded behavior intercept running BEFORE Brain sees the message,
  // matching surface patterns that can't reason about conversation
  // continuity. Per Basit "don't hardcode anything this is the crime
  // in building AI".
  //
  // Replacement: route everything through Brain. If the user genuinely
  // wants a report emailed, Brain emits a `send_email` action with the
  // report content (existing action type, dispatched through Gmail).
  // The intent classifier handles "yes" as a pending-action resolution,
  // not as a fresh email trigger.

  // ── Step 2c REMOVED 2026-05-20: hardcoded "isHireRequest" fast-path
  //    that pattern-matched "hire agent" / "add team member" and returned
  //    a canned "go to the web portal" reply. Per Basit: "don't hardcode
  //    anything this is the crime in building AI". Routing through Brain
  //    instead — let Brain answer naturally with the same web-portal
  //    pointer if and when it knows that's the right answer.
  // ── Step 2d: Agent conversation with session tracking ─────────────────────
  // If user is talking to an agent, ALL messages go to that agent until:
  //   - 10 min idle timeout → agent says goodbye
  //   - User says "exit/back/main ai" → switches to main AI
  //   - User addresses a different agent by name
  const AGENT_SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

  try {
    const { detectAgentMessage, handleAgentMessage } = await import('../../agents/agentConversation');

    // Check if there's an active agent session
    const activeSessions = await prisma.$queryRawUnsafe(
      `SELECT id, active_agent_id, active_agent_name, agent_session_started_at
       FROM whatsapp_sessions
       WHERE user_id = $1 AND client_number = $2 AND closed_at IS NULL
       AND active_agent_id IS NOT NULL
       ORDER BY last_message_at DESC LIMIT 1`,
      userId, params.clientNumber,
    ) as any[];

    let agentMatch = await detectAgentMessage(userId, params.clientNumber, queryText);

    // If no explicit agent match but there's an active agent session
    if (!agentMatch && activeSessions.length) {
      const session = activeSessions[0];
      const sessionAge = Date.now() - new Date(session.agent_session_started_at).getTime();
      const lastMsgAge = await prisma.$queryRawUnsafe(
        `SELECT EXTRACT(EPOCH FROM (NOW() - last_message_at)) * 1000 as age_ms
         FROM whatsapp_sessions WHERE id = $1`, session.id,
      ) as any[];
      const idleMs = Number(lastMsgAge[0]?.age_ms || 0);

      // Check if session timed out (10 min idle)
      if (idleMs > AGENT_SESSION_TIMEOUT_MS) {
        // End agent session \u2014 bracketed system marker, NOT fake-Brain
        // goodbye prose. Per Basit 2026-05-20: "don't hardcode anything
        // this is the crime in building AI". The previous canned
        // multilingual goodbye ("Thank you Sir! Our conversation is
        // ending now.") looked like the agent speaking; it's actually
        // a state transition emitted by the dispatcher. Honest
        // bracketed marker eliminates the fake-Brain impression.
        const agentName = session.active_agent_name;
        await prisma.$executeRawUnsafe(
          `UPDATE whatsapp_sessions SET active_agent_id = NULL, active_agent_name = NULL WHERE id = $1`, session.id,
        );
        await sayMarker(params, `[agent session ended — ${agentName} idle 10+ min; routing to main AI]`, userId);
      } else {
        // Session still active — check if user wants to leave
        const switchingAway = /\b(main ai|tmc ai|exit|back|leave|stop|bye|shukriya|thanks|theek hai)\b/i.test(lower);
        if (switchingAway) {
          const agentName = session.active_agent_name;
          await prisma.$executeRawUnsafe(
            `UPDATE whatsapp_sessions SET active_agent_id = NULL, active_agent_name = NULL WHERE id = $1`, session.id,
          );
          // Bracketed marker, no fake-Brain prose. Per Basit 2026-05-20.
          await sayMarker(params, `[agent session ended — ${agentName} closed; routing to main AI]`, userId);
          return;
        }

        // Route to the active agent
        agentMatch = { agentId: session.active_agent_id, agentName: session.active_agent_name, command: queryText };
        log.info('Sticky agent session', { agent: session.active_agent_name, idle: Math.round(idleMs / 1000) + 's' });
      }
    }

    if (agentMatch) {
      log.info('Agent-directed message', { agent: agentMatch.agentName, command: agentMatch.command?.slice(0, 50) });
      const agentResponse = await handleAgentMessage(agentMatch, userId, params.clientNumber);

      // Set/update active agent session
      await prisma.$executeRawUnsafe(
        `UPDATE whatsapp_sessions SET active_agent_id = $1, active_agent_name = $2,
         agent_session_started_at = COALESCE(agent_session_started_at, NOW())
         WHERE user_id = $3 AND client_number = $4 AND closed_at IS NULL`,
        agentMatch.agentId, agentMatch.agentName, userId, params.clientNumber,
      );

      await sendReply(params, agentResponse);
      return;
    }
  } catch (e: any) {
    log.error('Agent detection failed', { error: e.message });
    // DEF-089: this fires on EVERY inbound turn (undefined column, 42703) and
    // was invisible until a watcher was pointed at the loop. A failure on the
    // normal path is not an exception, it is the current behaviour — which is
    // precisely the kind of thing a log line lets you stop noticing.
    void recordFinding({
      clientNumber: params.clientNumber,
      kind: 'agent_detection_failed',
      severity: 'error',
      source: 'whatsapp:inbound',
      subjectType: 'user',
      subjectId: String(userId),
      userId,
      summary: `agent detection threw on an inbound turn: ${e.message}`,
      evidence: { error: e.message },
    });
  }

  // ── Step 3: Load or create session (24-hour window) ──────────────────────
  let sessions = await prisma.$queryRawUnsafe(
    `SELECT id, conversation_history FROM whatsapp_sessions
     WHERE user_id = $1 AND client_number = $2 AND closed_at IS NULL
     AND last_message_at > NOW() - INTERVAL '24 hours'
     ORDER BY created_at DESC LIMIT 1`,
    userId, params.clientNumber,
  ) as any[];

  let sessionId: number;
  let history: any[];
  let isNewSession = false;

  if (sessions.length) {
    sessionId = sessions[0].id;
    history = (sessions[0].conversation_history as any[]) || [];
  } else {
    isNewSession = true;
    // Close stale sessions
    await prisma.$executeRawUnsafe(
      `UPDATE whatsapp_sessions SET closed_at = NOW() WHERE user_id = $1 AND client_number = $2 AND closed_at IS NULL`,
      userId, params.clientNumber,
    );
    // Create new session
    const newSessions = await prisma.$queryRawUnsafe(
      `INSERT INTO whatsapp_sessions (user_id, client_number, conversation_history, last_message_at, created_at)
       VALUES ($1, $2, '[]'::jsonb, NOW(), NOW()) RETURNING id`,
      userId, params.clientNumber,
    ) as any[];
    sessionId = newSessions[0].id;
    history = [];
  }

  // ── Step 4 REMOVED 2026-05-20: hardcoded greeting fast-path that
  //    pattern-matched "hi" / "hello" / etc. and returned a canned reply
  //    (different versions for new-session vs returning), bypassing Brain
  //    composer entirely. Per Basit: "don't hardcode anything this is
  //    the crime in building AI". Every message — including a bare "hi" —
  //    now routes through Brain so the reply is generated, addressing,
  //    tone, identity, and any embedded follow-up question are all
  //    handled by one consistent path. The 1-2 second LLM latency on
  //    greetings is the price for honesty: every reply is Brain talking,
  //    not code pretending to be Brain.

  // ── Step 5: Process query through Brain (the living two-pass pipeline) ────
  // Refresh typing indicator (it expires after ~25s, processing can take 5-15s)
  if (params.typingFn) await params.typingFn().catch(() => {});

  // Brain identifies WHO is asking from the sender phone (resolved to
  // userId above) and answers with THAT user's full context: their
  // user-scope instructions, private knowledge, open items, calendar.
  // Client-scope instructions apply tenant-wide. This is the same
  // pipeline `POST /brain/ask` uses on the web surface.
  const { answerAsBrain } = await import('../../routes/brainAskRoutes');
  // Map WA session history (role:user|assistant, content) to Brain's
  // shape (role:user|brain, text). Without this, every WA message was
  // a context-less standalone — Brain just sent a Day Brief listing
  // "Numair: Google credits email", then on "add the google email to
  // open items" it ran a fresh Gmail search and asked which Google
  // email the user meant (security alerts, calendar invites, etc.)
  // because it couldn't see what it had just said.
  const brainHistory = history.map((h: any) => {
    const role = h.role === 'assistant' ? ('brain' as const)
      : h.role === 'artifact' ? ('artifact' as const)
      : ('user' as const);
    return { role, text: String(h.content ?? '') };
  });
  // ONE central brain, retried on transient failure — never a degraded
  // parallel pipeline (legacy processWhatsAppQuery removed 2026-07-08).
  // The brain degrades in latency, not competence. If BOTH attempts
  // throw, the user gets a clearly bracketed status marker — not a
  // hardcoded sentence pretending to be Brain.
  const { answer, degraded, result: r } = await askBrainWithRetry(
    () => answerAsBrain(params.clientNumber, userId, queryText, brainHistory, { channel: 'whatsapp' }),
  );
  // Defence-in-depth (chat 8, 2026-07-14): a raw "[notify_via_whatsapp:
  // …]" marker reached WhatsApp despite the routes-level sanitizer —
  // some internal path bypassed it (root cause under diagnosis via prod
  // logs). Sanitizing at THIS boundary guarantees no bracketed system
  // marker ever ships to a phone, whatever path produced the answer.
  const { sanitizeAnswerForUser } = await import('../knowledge/answerSanitizer');
  const responseText = sanitizeAnswerForUser(answer).trim()
    || '[Brain returned no usable response — please retry]';
  log.info('Inbound stage completed', {
    stage: 'brain', userId, messageId: params.waMessageId,
    elapsedMs: Date.now() - startedAt, degraded, answerLen: responseText.length,
    intent: r?.intent ?? null, artifactKind: r?.artifact?.kind ?? null,
  });
  if (!degraded && r) {
    log.info('Brain reply composed', { userId, queryLen: queryText.length, answerLen: responseText.length, sources: r.sources?.length ?? 0, historyTurns: brainHistory.length });

    // Fix 4 (2026-07-09) — restore the hot-path learning signal.
    // Deleting legacy processWhatsAppQuery also deleted its
    // fire-and-forget learnFromMessage call. Web chat still records
    // it (controllers/chat/postProcessing.ts:82); WA no longer did —
    // channel asymmetry in the per-message topic/style signal.
    // reflectionJob remains the batch layer; this restores the
    // instant per-message component so both channels feed learning
    // the same way. Only fires on the true success path — degraded
    // replies and bracketed markers must not train the model on
    // "this intent worked" when it didn't.
    learnFromMessage(
      params.clientNumber,
      userId,
      queryText,
      r?.intent ?? 'conversational',
    ).catch(() => { /* fire-and-forget: learning failure must not break the reply */ });

    // In-chat learning (2026-07-14): passing remarks with durability
    // markers ("always…", "never…", "from now on…") become PROPOSED
    // governed memories — pending the user's approval, never active by
    // themselves. Keyword pre-filter means most messages cost nothing.
    void import('../learning/standingPreferenceCapture')
      .then(({ captureStandingPreference }) => captureStandingPreference({
        clientNumber: params.clientNumber, userId, userMessage: queryText,
      }))
      .catch(() => { /* fire-and-forget */ });

    // If this turn dispatched a successful action, persist the artifact
    // into session history so next turn's compose can resolve
    // cancel/reschedule references. Stored as role='artifact' with
    // JSON-stringified content. The composer filters these out of the
    // conversation block and renders them in a dedicated artifacts
    // block instead. Per Basit 2026-05-21: enables "ok cancel this
    // meeting" to actually work against the eventId from a prior
    // schedule_meeting dispatch.
    if (r.artifact) {
      history.push({ role: 'artifact', content: JSON.stringify(r.artifact) });
      log.info('Brain artifact persisted to session', { userId, kind: r.artifact.kind, artifactId: r.artifact.artifactId });
    }
  }

  // No prefix needed — the LLM already knows the user's name from memory/profile

  // Update WhatsApp session history (keep last 20 messages)
  history.push({ role: 'user', content: queryText }, { role: 'assistant', content: responseText });
  const trimmed = history.slice(-20);

  await prisma.$executeRawUnsafe(
    `UPDATE whatsapp_sessions SET conversation_history = $1::jsonb, last_message_at = NOW() WHERE id = $2`,
    JSON.stringify(trimmed), sessionId,
  );

  // ── Sync to web chat history (user sees WhatsApp conversations on web) ──
  try {
    // Find or create a "WhatsApp" conversation for this user
    let webConvs = await prisma.$queryRawUnsafe(
      `SELECT id FROM conversations WHERE user_id = $1 AND client_number = $2 AND title = 'WhatsApp' AND is_archived = FALSE ORDER BY created_at DESC LIMIT 1`,
      userId, params.clientNumber,
    ) as any[];

    let webConvId: number;
    if (webConvs.length) {
      webConvId = webConvs[0].id;
    } else {
      const newConv = await prisma.$queryRawUnsafe(
        `INSERT INTO conversations (client_number, user_id, title, provider, message_count, created_at, updated_at)
         VALUES ($1, $2, 'WhatsApp', 'gemini-flash', 0, NOW(), NOW()) RETURNING id`,
        params.clientNumber, userId,
      ) as any[];
      webConvId = newConv[0].id;
    }

    // Save both user message and assistant response to web messages table
    await prisma.$executeRawUnsafe(
      `INSERT INTO messages (client_number, conversation_id, role, content, provider, source, created_at)
       VALUES ($1, $2, 'user', $3, 'gemini-flash', 'whatsapp', NOW())`,
      params.clientNumber, webConvId, queryText,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO messages (client_number, conversation_id, role, content, provider, source, created_at)
       VALUES ($1, $2, 'assistant', $3, 'gemini-flash', 'whatsapp', NOW())`,
      params.clientNumber, webConvId, responseText,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE conversations SET message_count = message_count + 2, updated_at = NOW() WHERE id = $1`, webConvId,
    );
  } catch (e: any) {
    log.error('Failed to sync to web chat history', { error: e.message });
    // Non-fatal — WhatsApp reply still sent
  }

  // Send reply
  await sendReply(params, responseText);
  log.info('Inbound processing completed', {
    userId, messageId: params.waMessageId, type: params.messageType,
    elapsedMs: Date.now() - startedAt,
  });
}

// ─── Send reply via provider or direct replyFn ────────────────────────────────

async function sendReply(params: InboundParams, text: string): Promise<void> {
  // Strip markdown formatting — WhatsApp has its own formatting (*bold*, _italic_)
  let clean = text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')    // **bold** → *bold* (WhatsApp native bold)
    .replace(/^#{1,6}\s+/gm, '')           // Remove ## headers
    .replace(/```[\s\S]*?```/g, '')        // Remove code blocks
    .replace(/`([^`]+)`/g, '$1')           // Remove inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
    .replace(/^[-*]\s/gm, '• ')           // - item → • item
    .replace(/\n{3,}/g, '\n\n')           // Max 2 consecutive newlines
    .trim();

  // Ensure complete sentences — never cut mid-sentence
  if (clean.length > 4000) {
    clean = clean.slice(0, 3900);
    const lastPeriod = clean.lastIndexOf('.');
    const lastNewline = clean.lastIndexOf('\n');
    const cutAt = Math.max(lastPeriod, lastNewline);
    if (cutAt > 3000) clean = clean.slice(0, cutAt + 1);
    else clean += '...';
  }

  // Resolve the audit owner before sending. The row itself is written only
  // AFTER the wire attempt so the Admin panel never claims `sent` for a reply
  // that threw before leaving the process.
  let logUserId = params._resolvedUserId;
  if (!logUserId) {
    const sa = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM users WHERE client_number = $1 AND is_active = TRUE
         AND user_type IN ('SA','AD') ORDER BY user_type, id LIMIT 1`,
      params.clientNumber,
    ).catch(() => [] as any[]);
    logUserId = sa[0]?.id;
  }
  let status: 'sent' | 'sent_unconfirmed' | 'failed' = 'sent_unconfirmed';
  let messageId: string | null = null;
  let sendError: string | null = null;
  try {
    if (params.replyFn) {
      const outcome = await params.replyFn(clean);
      if (outcome && !outcome.success) throw new Error(outcome.error ?? 'reply provider rejected send');
      messageId = outcome?.messageId ?? null;
      status = messageId ? 'sent' : 'sent_unconfirmed';
      // REQ-009: this reply went out over webjs and WhatsApp accepted it —
      // hard evidence that outbound transport is alive. Feed it back into
      // the liveness budget. Without this the 07-24 outage was terminal:
      // Brain answered the owner over this exact path for four days while
      // the probe budget stayed exhausted and every send to a counterpart
      // was refused. Never promotes status — only restores the right to
      // reprobe (see recordOutboundProof).
      if (messageId) {
        try {
          const { recordOutboundProof } = await import('./webjsLiveness');
          recordOutboundProof(params.clientNumber);
        } catch { /* liveness bookkeeping must never break a reply */ }
      }
    } else {
      const { sendTenantWhatsAppText } = await import('../notifications/tenantWhatsappSender');
      const outcome = await sendTenantWhatsAppText(
        params.clientNumber, params.fromNumber, clean, logUserId ?? 0,
      );
      if (!outcome.ok) throw new Error(outcome.error ?? 'reply provider rejected send');
      messageId = outcome.waMessageId ?? null;
      status = messageId ? 'sent' : 'sent_unconfirmed';
    }
  } catch (err: any) {
    status = 'failed';
    sendError = err?.message ?? 'unknown reply send error';
  }

  try {
    if (logUserId) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO whatsapp_messages
           (client_number, user_id, direction, from_number, to_number,
            content, wa_message_id, status, error_message, created_at)
         VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7, $8, NOW())`,
        params.clientNumber, logUserId, '', params.fromNumber, clean,
        messageId, status, sendError,
      );
    }
  } catch (err: any) {
    log.warn('outbound log insert failed', { error: err.message });
  }

  if (status === 'failed') throw new Error(sendError ?? 'reply send failed');
}
