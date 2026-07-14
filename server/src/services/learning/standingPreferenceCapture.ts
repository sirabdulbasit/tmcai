/**
 * standingPreferenceCapture — in-chat learning (2026-07-14).
 *
 * The deliberately-deferred half of the learning loop, now built with
 * its safety story intact. A living assistant learns from PASSING
 * REMARKS — "always cc finance on delegations", "never disturb me
 * after 8pm", "Yousaf prefers WhatsApp" — said mid-conversation, not
 * through a feedback button.
 *
 * Safety design (why this was deferred until now): auto-learning a
 * wrong rule is worse than asking twice. So this NEVER activates a
 * rule by itself:
 *   1. PRE-FILTER (mechanics, not judgement): cheap keyword check for
 *      durability markers (always / never / from now on / hamesha…).
 *      Most messages exit here at zero LLM cost.
 *   2. DISTILL (LLM judgement, per the no-hardcoded-judgement rule):
 *      is this a durable standing preference, or one-off content?
 *      Below-threshold confidence → dropped silently.
 *   3. PROPOSE — createdByBrain memories land as pending_approval in
 *      the existing governed-memory pipeline. ONLY the user's approval
 *      (Settings → Brain → Memories) activates them. Same governance
 *      as the correction distiller.
 *
 * Called fire-and-forget from the chat success paths (WhatsApp inbound
 * + web post-processing) — a capture failure never touches the reply.
 */
import createLogger from '../../utils/logger';

const log = createLogger('standing-pref-capture');

/** Durability markers — English + Roman-Urdu. PRE-FILTER ONLY: decides
 *  whether to spend an LLM call, never whether the rule is real. */
const DURABILITY_RE = /\b(always|never|from now on|going forward|every time|whenever|by default|prefer(?:red)? that|make sure (?:to|you) always|hamesha|kabhi (?:nahi|nahin|mat)|aage se|har (?:bar|baar|dafa))\b/i;

const CONFIDENCE_FLOOR = 0.6;

const DISTILL_SYSTEM = `You detect durable standing preferences in a user's chat message to their AI assistant.

A standing preference is an instruction meant to apply to ALL future situations of a kind — e.g. "always cc finance when delegating", "never message anyone after 8pm", "from now on reply in English", "Yousaf prefers WhatsApp over email".

NOT standing preferences: one-off requests ("send this now", "cc finance on this one"), questions, facts about a single event, or corrections of a single value (a name, a date).

Return JSON only:
{"isStanding": true|false, "title": "<short imperative rule, max 80 chars>", "content": "<1-2 sentence instruction the assistant can follow in future>", "confidence": <0..1>}

Be conservative: when unsure whether it generalizes, return isStanding=false or confidence below ${CONFIDENCE_FLOOR}.`;

export interface CaptureResult {
  proposed: boolean;
  memoryId?: string;
  reason: 'no_marker' | 'not_standing' | 'low_confidence' | 'proposed' | 'error';
}

export async function captureStandingPreference(input: {
  clientNumber: string;
  userId: number;
  userMessage: string;
  /** Injectable for tests; defaults to learningService.proposeMemory. */
  proposeMemory?: (args: any) => Promise<{ id: string; status: string }>;
  /** Injectable for tests; defaults to llmRouter.callLLM. */
  callLlm?: (sys: string, user: string, opts: any) => Promise<{ text: string }>;
}): Promise<CaptureResult> {
  const msg = (input.userMessage ?? '').trim();
  // Pre-filter: no durability marker → no LLM spend, no proposal.
  if (!msg || msg.length < 12 || !DURABILITY_RE.test(msg)) {
    return { proposed: false, reason: 'no_marker' };
  }

  try {
    const call = input.callLlm ?? (await import('../llmRouter')).callLLM;
    const r = await call(DISTILL_SYSTEM, `User message:\n"""${msg.slice(0, 800)}"""`, {
      maxTokens: 220,
      userId: input.userId,
      clientNumber: input.clientNumber,
      purpose: 'standing_pref_capture',
    });
    const jsonMatch = /\{[\s\S]*\}/.exec(r.text ?? '');
    if (!jsonMatch) return { proposed: false, reason: 'not_standing' };
    const parsed = JSON.parse(jsonMatch[0]);
    if (parsed?.isStanding !== true) return { proposed: false, reason: 'not_standing' };
    const confidence = Number(parsed.confidence ?? 0);
    if (!(confidence >= CONFIDENCE_FLOOR)) return { proposed: false, reason: 'low_confidence' };
    const title = String(parsed.title ?? '').slice(0, 80).trim();
    const content = String(parsed.content ?? '').slice(0, 400).trim();
    if (!title || !content) return { proposed: false, reason: 'not_standing' };

    const propose = input.proposeMemory ?? (await import('./learningService')).proposeMemory;
    const mem = await propose({
      clientNumber: input.clientNumber,
      userId: input.userId,
      memoryScope: 'user',
      memoryType: 'standing_preference',
      title,
      content,
      confidenceScore: confidence,
      sourceType: 'chat_standing_preference',
      // createdByBrain forces pending_approval — the user's yes in
      // Settings activates it; the brain never activates its own rule.
      createdByBrain: true,
    });
    log.info('standing preference proposed', { userId: input.userId, memoryId: mem.id, title });
    return { proposed: true, memoryId: mem.id, reason: 'proposed' };
  } catch (e: any) {
    log.warn('capture failed (non-fatal)', { userId: input.userId, error: e?.message });
    return { proposed: false, reason: 'error' };
  }
}
