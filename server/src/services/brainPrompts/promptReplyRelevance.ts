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
  | 'new_conversation_turn'
  | 'ambiguous';

export interface RelevanceVerdict {
  relevance: PromptReplyRelevance;
  confidence: number; // 0..1
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
    if (!['answers_pending_prompt', 'new_conversation_turn', 'ambiguous'].includes(relevance)) {
      return null;
    }
    const confidence = Number(parsed?.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
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

const SYSTEM_PROMPT = `You judge whether a user's WhatsApp message answers a specific pending question their assistant asked earlier, or is a new/unrelated conversational turn.

Reply with ONLY a JSON object:
{"relevance":"answers_pending_prompt"|"new_conversation_turn"|"ambiguous","confidence":0.0-1.0}

Rules:
- "answers_pending_prompt": the message plausibly responds to the pending question given its expected answer kind (a date for a due-date question, a person for an ownership question, a status/blocker description for an action-status question, etc.). Short answers like "done", "friday", "waiting on finance" count when they fit the question. Answers may be in any language, including Urdu/roman Urdu.
- "new_conversation_turn": greetings and small talk ("hi", "whatsup?", "kya haal hai"), new commands or questions, or anything starting a different topic.
- "ambiguous": genuinely unclear either way.
- Judge by MEANING against the pending question, not by keywords.`;

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
