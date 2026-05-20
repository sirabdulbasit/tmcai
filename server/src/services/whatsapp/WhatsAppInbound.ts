// ═════════════════════════════════════════════════════════════════════════════
// WhatsAppInbound — Handles incoming WhatsApp messages (2-way communication)
//
// Flow: Inbound message → identify user → load/create session → call TMCAI
//       chat pipeline → send reply via WhatsApp
// ═════════════════════════════════════════════════════════════════════════════

import prisma from '../../db/prisma';
import { sendWhatsAppMessage } from './WhatsAppManager';
import createLogger from '../../utils/logger';

const log = createLogger('whatsapp:inbound');

export interface InboundParams {
  clientNumber: string;
  fromNumber: string;       // E.164: +923001234567
  messageBody: string;
  messageType: 'text' | 'image' | 'voice' | 'document';
  mediaUrl?: string;
  replyFn?: (text: string) => Promise<void>;
  typingFn?: () => Promise<void>;  // Shows "typing..." indicator in WhatsApp
  /** Set by handleInboundMessage after identity resolution; used by
   *  sendReply so the outbound whatsapp_messages row carries a valid
   *  user_id (column is NOT NULL — previously the insert failed silently). */
  _resolvedUserId?: number;
}

// Dedup: prevent processing same message twice (WhatsApp Web.js can fire duplicate events)
const recentMessages = new Map<string, number>(); // key → timestamp
const DEDUP_WINDOW_MS = 5000; // 5 seconds

export async function handleInboundMessage(params: InboundParams): Promise<void> {
  // Dedup check
  const dedupKey = `${params.fromNumber}:${params.messageBody}`;
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

  // Log inbound message. We don't have the resolved userId yet (that's
  // the next step), so fall back to a tenant SA to satisfy the
  // NOT NULL constraint. The resolution-based update-to-correct-user_id
  // is a nice-to-have follow-up but not essential — the from_number is
  // the authoritative identity signal anyway.
  try {
    const sa = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM users WHERE client_number = $1 AND is_active = TRUE
         AND user_type IN ('SA','AD') ORDER BY user_type, id LIMIT 1`,
      params.clientNumber,
    ).catch(() => [] as any[]);
    const logUserId = sa[0]?.id;
    if (logUserId) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO whatsapp_messages (client_number, user_id, direction, from_number, to_number, content, message_type, status, created_at)
         VALUES ($1, $2, 'inbound', $3, '', $4, $5, 'received', NOW())`,
        params.clientNumber, logUserId, params.fromNumber, params.messageBody, params.messageType,
      );
    }
  } catch (err: any) {
    log.warn('inbound log insert failed', { error: err.message });
  }

  // ── Step 1: Check if sender's number is registered ────────────────────────
  // Normalize number for matching: strip +, leading 0, try multiple formats
  const rawNum = params.fromNumber.replace(/[^\d]/g, ''); // digits only
  const numVariants = [
    params.fromNumber,                          // original: +923226288256
    rawNum,                                     // digits: 923226288256
    '+' + rawNum,                               // +923226288256
    '0' + rawNum.slice(rawNum.startsWith('92') ? 2 : 0), // 03226288256 (local)
  ];

  // Tenant filter lives on the USER row — not on whatsapp_connections —
  // because `wc.client_number` is allowed to be null (historical bug;
  // see smoke log). The user's client_number is the authoritative
  // tenant binding and is NOT NULL on every row.
  const connections = await prisma.$queryRawUnsafe(
    `SELECT wc.user_id, wc.id as connection_id, wc.display_name, u.name as user_name, u.client_number, u.department
     FROM whatsapp_connections wc JOIN users u ON u.id = wc.user_id
     WHERE u.client_number = $1 AND wc.status = 'active' AND u.is_active = TRUE
       AND (wc.phone_number = $2 OR wc.phone_number = $3 OR wc.phone_number = $4 OR wc.phone_number = $5)`,
    params.clientNumber, numVariants[0], numVariants[1], numVariants[2], numVariants[3],
  ) as any[];

  // Unknown number — silently drop the message.
  //
  // Why ignore instead of replying with a registration prompt:
  //   1. Privacy — replying confirms to the sender that this is an
  //      automated business number, attracting spam/scrapers.
  //   2. Quota — every reply consumes a slot from the tenant's daily
  //      cap; auto-replying to wrong-number / spam senders burns it.
  //   3. UX — a real user who needs to register will be onboarded by
  //      their admin via the Settings page; they don't need a reply
  //      from the bot to figure that out.
  //
  // Still logged so admins can audit unknown-number traffic in the
  // server log if they ever need to investigate.
  if (!connections.length) {
    log.info('Unregistered number — ignored', {
      from: params.fromNumber,
      clientNumber: params.clientNumber,
    });
    return;
  }

  const conn = connections[0];
  const userId = conn.user_id;
  const userName = conn.display_name || conn.user_name || 'there';
  let queryText = params.messageBody;

  // Thread the resolved userId onto params so sendReply's log insert
  // carries it — whatsapp_messages.user_id is NOT NULL and the outbound
  // row was previously being swallowed by an empty catch.
  params._resolvedUserId = userId;

  log.info('Identified user', { from: params.fromNumber, userId, name: userName });

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
        await sendReply(params, r.ackMessage);
      }
      return;  // do NOT continue to chat router
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
    await sendReply(params, `[session ended — send any message to resume]`);
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
        // End agent session with goodbye
        const agentName = session.active_agent_name;
        await prisma.$executeRawUnsafe(
          `UPDATE whatsapp_sessions SET active_agent_id = NULL, active_agent_name = NULL WHERE id = $1`, session.id,
        );

        // Detect language of user's message for goodbye
        const isUrdu = /[\u0600-\u06FF]/.test(queryText);
        const isRomanUrdu = /\b(kia|kaise|hai|hain|ho|kar|rahi|batao|dekho|mujhe)\b/i.test(lower);

        const goodbye = isUrdu
          ? `*${agentName}*: شکریہ Sir! میری بات ختم ہو رہی ہے۔ اگر دوبارہ بات کرنی ہو تو "${agentName}" کہہ کر مجھے بلا لیں۔`
          : isRomanUrdu
          ? `*${agentName}*: Shukriya Sir! Meri conversation yahan khatam ho rahi hai. Agar dobara baat karni ho to "${agentName}" keh kar mujhe bula lein.`
          : `*${agentName}*: Thank you Sir! Our conversation is ending now. If you need me again, just say "${agentName}" to start.`;

        await sendReply(params, goodbye);
        // Continue to process current message as main AI
      } else {
        // Session still active — check if user wants to leave
        const switchingAway = /\b(main ai|tmc ai|exit|back|leave|stop|bye|shukriya|thanks|theek hai)\b/i.test(lower);
        if (switchingAway) {
          const agentName = session.active_agent_name;
          await prisma.$executeRawUnsafe(
            `UPDATE whatsapp_sessions SET active_agent_id = NULL, active_agent_name = NULL WHERE id = $1`, session.id,
          );
          const isUrdu = /[\u0600-\u06FF]/.test(queryText) || /\b(shukriya|theek)\b/i.test(lower);
          const goodbye = isUrdu
            ? `*${agentName}*: جی Sir، اگر کوئی اور بات ہو تو بتائیں۔ اللہ حافظ!`
            : `*${agentName}*: Sure Sir, I'm here whenever you need me. Take care!`;
          await sendReply(params, goodbye);
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
  let responseText: string;
  try {
    const { answerAsBrain } = await import('../../routes/brainAskRoutes');
    // Map WA session history (role:user|assistant, content) to Brain's
    // shape (role:user|brain, text). Without this, every WA message was
    // a context-less standalone — Brain just sent a Day Brief listing
    // "Numair: Google credits email", then on "add the google email to
    // open items" it ran a fresh Gmail search and asked which Google
    // email the user meant (security alerts, calendar invites, etc.)
    // because it couldn't see what it had just said.
    const brainHistory = history.map((h: any) => ({
      role: h.role === 'assistant' ? ('brain' as const) : ('user' as const),
      text: String(h.content ?? ''),
    }));
    const r = await answerAsBrain(params.clientNumber, userId, queryText, brainHistory, { channel: 'whatsapp' });
    responseText = r.answer;
    log.info('Brain reply composed', { userId, queryLen: queryText.length, answerLen: responseText.length, sources: r.sources?.length ?? 0, historyTurns: brainHistory.length });
  } catch (error: any) {
    log.warn('answerAsBrain failed — falling back to legacy pipeline', { error: error.message, userId });
    try {
      responseText = await processWhatsAppQuery(userId, params.clientNumber, queryText, history);
    } catch (err2: any) {
      log.error('Query processing failed', { error: err2.message, userId });
      // System marker, not a fake-Brain apology. When BOTH the primary
      // Brain composer AND the legacy fallback throw, the user gets a
      // clearly bracketed status message — not a hardcoded sentence
      // pretending to be Brain.
      responseText = `[Brain unavailable — ${err2?.message ?? 'unknown error'}. Try again in a moment or use the web.]`;
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

  // Log outbound message. `whatsapp_messages.user_id` is NOT NULL — if
  // the resolver upstream didn't set one (edge case: reply before
  // identity resolution, e.g., the "unregistered number" prompt), fall
  // back to the tenant's first active SA so the log row is valid.
  let logUserId = params._resolvedUserId;
  if (!logUserId) {
    const sa = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM users WHERE client_number = $1 AND is_active = TRUE
         AND user_type IN ('SA','AD') ORDER BY user_type, id LIMIT 1`,
      params.clientNumber,
    ).catch(() => [] as any[]);
    logUserId = sa[0]?.id;
  }
  try {
    if (logUserId) {
      await prisma.$executeRawUnsafe(
        `INSERT INTO whatsapp_messages (client_number, user_id, direction, from_number, to_number, content, status, created_at)
         VALUES ($1, $2, 'outbound', $3, $4, $5, 'sent', NOW())`,
        params.clientNumber, logUserId, '', params.fromNumber, clean,
      );
    }
  } catch (err: any) {
    log.warn('outbound log insert failed', { error: err.message });
  }

  if (params.replyFn) {
    // Provider-supplied reply path (legacy webjs uses MessageMedia for
    // voice). When inbound came over Meta webhook, no replyFn is passed
    // and we route through the unified tenant-WhatsApp sender — which
    // picks Meta Notifier when configured, falls back to webjs otherwise.
    await params.replyFn(clean);
  } else {
    const { sendTenantWhatsAppText } = await import('../notifications/tenantWhatsappSender');
    await sendTenantWhatsAppText(
      params.clientNumber,
      params.fromNumber,
      clean,
      logUserId ?? 0,
    );
  }
}

// ─── Process query through TMCAI pipeline (same AI as web, mobile-optimized output) ──

async function processWhatsAppQuery(
  userId: number,
  clientNumber: string,
  query: string,
  conversationHistory: any[],
): Promise<string> {
  const { classifyIntent, buildIntentDirective } = await import('../intentService');
  const { getAIConfig } = await import('../aiConfigService');
  const { retrieveData } = await import('../../controllers/chat/dataRetrieval');
  const { buildMemoryPromptBlocks } = await import('../memoryService');
  const { getUserProfile } = await import('../userProfileService');
  const { getUserLearnings } = await import('../learningService');
  const { learnFromMessage } = await import('../learningService');

  const aiConfig = await getAIConfig(clientNumber);
  const recentTurns = conversationHistory.slice(-6);

  // ── Same pipeline as web: intent + memory + profile + learnings ──────────
  const [intent, memoryBlocks, userProfile, userLearnings] = await Promise.all([
    classifyIntent(query, undefined, recentTurns.length > 0 ? recentTurns : undefined),
    buildMemoryPromptBlocks(userId),
    getUserProfile(userId),
    getUserLearnings(userId),
  ]);

  const aiName = memoryBlocks.aiName || 'TMCAI';

  // ── WhatsApp output rules (the ONLY difference from web) ────────────────
  const WHATSAPP_RULES = [
    '── WHATSAPP FORMAT ──',
    'Responding on WhatsApp. Keep it mobile-friendly.',
    '',
    'RULES:',
    '• Be concise but COMPLETE. Never leave a sentence unfinished.',
    '• Give the key answer first, then brief supporting details.',
    '• Use plain text. For emphasis: *bold* (single asterisk). No markdown ## or **.',
    '• For stats: ONLY use exact numbers from the DATA section. Do NOT count rows yourself — use totals stated in the data source.',
    '• For lists: show top 5 items max. Mention total count.',
    '• Always finish every sentence. If answer is getting long, summarize and offer:',
    '  "Want the full report by email? Or check tai.tmcltd.com"',
    '• Match the user\'s tone — casual or formal.',
    '• LANGUAGE MATCHING: If user writes in Urdu → respond in Urdu. If English → respond in English. If mixed → respond in the same mix.',
    '• For Urdu: use Urdu script (نستعلیق). Example: "آپ کے 47 ایکٹو پروجیکٹس ہیں۔"',
    '• For Roman Urdu: respond in Roman Urdu. Example: "Aap ke 47 active projects hain."',
    '── END FORMAT ──\n',
  ].join('\n');

  // ── Build user profile block (same as web) ──────────────────────────────
  let profileBlock = '';
  if (userProfile) {
    const parts: string[] = [];
    if (userProfile.jobDescription) parts.push(`User's JD: ${userProfile.jobDescription}`);
    if (userProfile.aboutMe) parts.push(`About user: ${userProfile.aboutMe}`);
    if (userProfile.instructions) parts.push(`Custom instructions: ${userProfile.instructions}`);
    if (userProfile.preferredTitle) parts.push(`Address the user as: ${userProfile.preferredTitle}`);
    if (parts.length > 0) {
      profileBlock = '── USER PROFILE ──\n' + parts.join('\n') +
        '\nADAPTIVE TONE: Mirror the user\'s communication style. If casual, be casual. If formal, be formal.\n\n';
    }
  }

  // ── Learned patterns (same as web) ──────────────────────────────────────
  let learningBlock = '';
  if (userLearnings.length > 0) {
    learningBlock = '── LEARNED PATTERNS ──\n' + userLearnings.join('\n') + '\nUse these silently.\n\n';
  }

  // ── Memory blocks (same as web) ─────────────────────────────────────────
  let memoryBlock = '';
  if (memoryBlocks.userMemoryBlock) memoryBlock += memoryBlocks.userMemoryBlock + '\n';
  if (memoryBlocks.aiMemoryBlock) memoryBlock += memoryBlocks.aiMemoryBlock + '\n';
  if (memoryBlocks.contextBlock) memoryBlock += memoryBlocks.contextBlock + '\n';

  // ── Data retrieval (skip for conversational) ────────────────────────────
  let dataBlock = '';
  if (intent.type !== 'conversational') {
    const { context } = await retrieveData(
      query, intent, 'gemini-flash', aiConfig, Date.now(),
      () => {}, () => false, userId, ['org'], recentTurns,
    );

    // Always include data_summary for accurate total counts (prevents LLM from counting rows)
    let summaryLine = '';
    try {
      const { retrieveContext } = await import('../../pipeline/gcpRetrieval');
      const summaryResult = await retrieveContext('how many total');
      if (summaryResult.context && summaryResult.context.includes('Summary')) {
        summaryLine = summaryResult.context;
      }
    } catch {}

    const allContext = [summaryLine, context].filter(Boolean).join('\n\n---\n\n');
    if (allContext) dataBlock = `── DATA (use ONLY these numbers, do NOT count rows yourself) ──\n${allContext}\n── END DATA ──\n`;
  }

  // ── Assemble full prompt (same structure as web, with WA rules on top) ──
  const directive = buildIntentDirective(intent);
  const systemPrompt = [
    WHATSAPP_RULES,
    profileBlock,
    learningBlock,
    memoryBlock ? `── MEMORY ──\n${memoryBlock}── END MEMORY ──\n` : '',
    directive,
    dataBlock,
  ].filter(Boolean).join('\n');

  // Conversation turns (same as web)
  const turns = recentTurns.map((t: any) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`).join('\n');
  const fullPrompt = turns
    ? `${systemPrompt}\n── CONVERSATION ──\n${turns}\n\nUser: ${query}`
    : `${systemPrompt}\nUser: ${query}`;

  // ── Generate response ───────────────────────────────────────────────────
  const { getGenAI } = await import('../genaiClient');
  const ai = getGenAI();
  // Read max tokens from tenant's WhatsApp config (admin-configurable)
  const waConfig = await prisma.$queryRawUnsafe(
    `SELECT max_tokens_chat, max_tokens_data FROM whatsapp_config WHERE client_number = $1`, clientNumber,
  ) as any[];
  const maxTokensChat = waConfig[0]?.max_tokens_chat || 150;
  const maxTokensData = waConfig[0]?.max_tokens_data || 400;
  const maxTokens = intent.type === 'conversational' ? maxTokensChat : maxTokensData;
  const result = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: fullPrompt,
    config: { maxOutputTokens: maxTokens },
  });

  const response = (result.text ?? '').trim() || `[LLM returned empty response — try again]`;

  // ── Self-learning (same as web — tracks on WhatsApp too) ────────────────
  learnFromMessage(clientNumber, userId, query, intent.type).catch(() => {});

  return response;
}
