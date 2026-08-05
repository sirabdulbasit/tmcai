/**
 * LLM-with-context relevance gate for prompt-queue reply consumption
 * (Section 32B, reviewer-approved design 2026-07-22).
 *
 * Production incident: with an action-status prompt awaiting, the
 * user's casual "Whatsup?" passed the hardcoded looksLikeAnswer regex
 * (it lists "hi/hello/hey" but not "whatsup") and was recorded as the
 * prompt's answer, dragging a greeting through blocker/intervention
 * interpretation. Regex is allowed to PREFILTER (fast fall-through for
 * obvious new-chat commands) but must not make the final consumption
 * decision — that is judgment, and judgment is LLM-with-context.
 *
 * Contract: only a sufficiently confident 'answers_pending_prompt'
 * verdict may mutate the prompt/open item. 'new_conversation_turn',
 * 'ambiguous', low confidence, malformed output, and classifier
 * failure ALL fall through to the normal Brain conversation with no
 * prompt mutation — a delayed prompt answer costs one turn; a stolen
 * conversation turn costs trust.
 */
import { callLLM } from '../llmRouter';
import createLogger from '../../utils/logger';

const log = createLogger('prompt-reply-relevance');

export type PromptReplyRelevance =
  | 'answers_pending_prompt'
  | 'partially_answers'
  | 'new_conversation_turn'
  | 'ambiguous';

export interface RelevanceVerdict {
  relevance: PromptReplyRelevance;
  confidence: number; // 0..1
  /**
   * DEF-017 (2026-08-05, 3rd recurrence of `pending-prompt-eats-command`).
   *
   * The verdict used to be BINARY over the whole message, so a compound
   * instruction was either swallowed whole or dropped whole. Real example:
   * "Priority High, due date today and delegate to Hamna Latif" — the
   * priority answered the pending question, so the entire string was
   * consumed: the deadline became a fabricated 2024-03-29, a junk task
   * titled "Priority High" appeared, and the delegation vanished.
   *
   * `partially_answers` splits it: `answerPart` is recorded against the
   * prompt, and `residual` continues through the NORMAL compose path —
   * the same one every other turn uses. (The pre-existing piggyback
   * rescue could not do this: it fed the leftover to a second, weaker
   * extractor whose intent vocabulary has no open-item delegate.)
   */
  answerPart?: string;
  residual?: string;
}

/** Bounded protocol constant (not business policy): the minimum
 *  confidence at which a verdict may consume the inbound as a prompt
 *  answer. Below it we fall through to chat. */
export const RELEVANCE_CONFIDENCE_THRESHOLD = 0.7;

/** Strict parse of the classifier's JSON. Anything malformed → null
 *  (treated as classifier failure → no mutation). Exported for tests. */
export function parseRelevanceVerdict(raw: unknown): RelevanceVerdict | null {
  try {
    const match = String(raw ?? '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const relevance = String(parsed?.relevance ?? '');
    if (!['answers_pending_prompt', 'partially_answers', 'new_conversation_turn', 'ambiguous'].includes(relevance)) {
      return null;
    }
    const confidence = Number(parsed?.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
    if (relevance === 'partially_answers') {
      // A partial split is only usable with BOTH halves. Missing either one
      // would mean silently dropping content — the very failure being fixed —
      // so an incomplete split is treated as classifier failure: no mutation,
      // whole message falls through to normal chat.
      const answerPart = String(parsed?.answerPart ?? '').trim();
      const residual = String(parsed?.residual ?? '').trim();
      if (!answerPart || !residual) return null;
      return { relevance: 'partially_answers', confidence, answerPart, residual };
    }
    return { relevance: relevance as PromptReplyRelevance, confidence };
  } catch {
    return null;
  }
}

/** May the inbound be consumed as the pending prompt's answer? Pure
 *  decision rule over a verdict — exported for tests. */
export function mayConsumeAsAnswer(verdict: RelevanceVerdict | null): boolean {
  return verdict !== null
    && verdict.relevance === 'answers_pending_prompt'
    && verdict.confidence >= RELEVANCE_CONFIDENCE_THRESHOLD;
}

/** May the inbound be split — part recorded as the answer, part forwarded to
 *  normal chat? Requires the same confidence bar AND both halves present. */
export function mayConsumePartially(verdict: RelevanceVerdict | null): boolean {
  return verdict !== null
    && verdict.relevance === 'partially_answers'
    && verdict.confidence >= RELEVANCE_CONFIDENCE_THRESHOLD
    && !!verdict.answerPart?.trim()
    && !!verdict.residual?.trim();
}

const SYSTEM_PROMPT = `You judge whether a user's WhatsApp message answers a specific pending question their assistant asked earlier, or is a new/unrelated conversational turn.

Reply with ONLY a JSON object:
{"relevance":"answers_pending_prompt"|"partially_answers"|"new_conversation_turn"|"ambiguous","confidence":0.0-1.0,"answerPart":"…","residual":"…"}

Rules:
- "answers_pending_prompt": the WHOLE message responds to the pending question given its expected answer kind (a date for a due-date question, a person for an ownership question, a status/blocker description for an action-status question, etc.). Short answers like "done", "friday", "waiting on finance" count when they fit the question. Answers may be in any language, including Urdu/roman Urdu. Omit answerPart/residual.
- "partially_answers": PART of the message answers the pending question and the REST is a separate instruction or question. Set "answerPart" to just the piece that answers, and "residual" to the remaining instruction, rewritten as a standalone request that makes sense on its own. Use this whenever the user has bundled several things together — it is common in dictated voice notes.
  Example — pending question "what priority for Vision Metric Integration?", message "Priority High, due date today and delegate to Hamna Latif":
  {"relevance":"partially_answers","confidence":0.9,"answerPart":"High","residual":"Set the due date of Vision Metric Integration to today and delegate it to Hamna Latif"}
- "new_conversation_turn": greetings and small talk ("hi", "whatsup?", "kya haal hai"), new commands or questions, or anything starting a different topic. NONE of it answers the pending question.
- "ambiguous": genuinely unclear either way.
- Judge by MEANING against the pending question, not by keywords.
- Never invent content that is not in the message. If you cannot cleanly separate the two halves, use "ambiguous" instead of guessing — dropping part of a user's instruction is the worst outcome.`;

export async function classifyPromptReplyRelevance(input: {
  pendingQuestion: string;
  sideEffectKind: string;
  openItemTitle?: string | null;
  inboundText: string;
  clientNumber?: string;
  userId?: number;
}): Promise<RelevanceVerdict | null> {
  const userMessage = JSON.stringify({
    pendingQuestion: input.pendingQuestion.slice(0, 500),
    expectedAnswerKind: input.sideEffectKind,
    linkedItemTitle: (input.openItemTitle ?? '').slice(0, 200) || null,
    userMessage: input.inboundText.slice(0, 500),
  });
  try {
    const result = await callLLM(SYSTEM_PROMPT, userMessage, { maxTokens: 100, timeoutMs: 8_000 });
    const verdict = parseRelevanceVerdict(result.text);
    if (!verdict) {
      log.warn('relevance classifier returned unparseable output — no mutation', {
        clientNumber: input.clientNumber, userId: input.userId,
        sideEffectKind: input.sideEffectKind,
      });
    }
    return verdict;
  } catch (error: any) {
    log.warn('relevance classifier failed — no mutation', {
      clientNumber: input.clientNumber, userId: input.userId,
      sideEffectKind: input.sideEffectKind, error: String(error?.message ?? error).slice(0, 200),
    });
    return null;
  }
}
