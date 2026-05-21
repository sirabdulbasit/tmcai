/**
 * turnRelationReducer — deterministic classification of how this turn
 * relates to any active pending action.
 *
 * Sprint 1 (2026-05-21). Replaces the scattered heuristics
 * (userMessageLooksLikeSlotFill, userMessageIsActionImperative,
 * etc.) with a single source of truth that examines:
 *   - the user's current message
 *   - the active PendingAction (if any)
 *   - the most recent Brain message (its shape, not its content)
 *
 * Output is a discriminated union of TurnRelation. The compose pipeline
 * consumes this to decide whether to short-circuit (continue an
 * existing flow) or run the full composer for a new task.
 *
 * Design choices:
 *   - DETERMINISTIC where possible — regex / shape checks, no LLM
 *     call. The reducer is on every turn's hot path and must be fast.
 *   - LLM-assist only as a tie-breaker, not the primary path.
 *   - Fail safely toward "new_task" when ambiguous — the full
 *     composer is the correct fallback because it has the broadest
 *     context.
 */
import type { PendingAction } from './pendingActionService';
import type { ComposerHistoryTurn } from './brainComposer';

export type TurnRelation =
  | { type: 'new_task' }
  | { type: 'continue_task'; pendingId: string }
  | { type: 'confirm_preview'; pendingId: string }
  | { type: 'correct_preview'; pendingId: string }
  | { type: 'cancel_pending'; pendingId: string }
  | { type: 'answer_question' }
  | { type: 'casual' }
  | { type: 'ambiguous' };

/** Closed-vocabulary confirmation patterns. Must match the WHOLE
 *  trimmed message (anchored ^...$) to avoid "yes I know him" being
 *  mistaken for a preview confirmation. Length-capped at 30 chars
 *  for the same reason. */
const CONFIRMATION_RE =
  /^(yes|yep|yeah|yes\s+send|send|send\s+it|send\s+invite|go\s+ahead|do\s+it|please\s+do|confirm|confirmed|ok|okay|ok\s+do\s+it|ok\s+send|proceed|approved|approve|yes\s+please|sure)\.?$/i;

/** Closed-vocabulary cancellation patterns. */
const CANCELLATION_RE =
  /^(no|nope|don'?t|cancel|cancel\s+it|stop|nevermind|never\s+mind|abort|forget\s+it|skip\s+it|no\s+don'?t|no\s+thanks)\.?$/i;

/** Correction patterns — "change X to Y", "make it Z", "actually use ...".
 *  Length-capped to avoid matching long stories. */
const CORRECTION_RE =
  /^(change|update|make\s+it|actually|instead|use|change\s+to|set\s+to|move\s+to|push\s+to)\b/i;

/** Imperative leading verbs that start a new action task (NOT a
 *  continuation of the pending). When the user fires off "schedule X
 *  with Y" while a pending exists, the new request displaces the
 *  pending. */
const NEW_TASK_IMPERATIVE_RE =
  /^(send|schedule|reschedule|cancel|delete|remove|book|set|create|add|delegate|email|tell|notify|ping|invite|push|shift|move|forward|reply|draft|remind)\b/i;

/** Trigger the reducer's LLM-assist path only when deterministic
 *  classification yields 'ambiguous'. */
export function reduceTurn(args: {
  question: string;
  pending: PendingAction | null;
  history: ComposerHistoryTurn[];
}): TurnRelation {
  const q = args.question.trim();
  const lower = q.toLowerCase();

  // No active pending → it's either a new task, a question, or casual.
  if (!args.pending) {
    if (NEW_TASK_IMPERATIVE_RE.test(lower)) return { type: 'new_task' };
    if (lower.endsWith('?')) return { type: 'answer_question' };
    if (lower.length <= 20 && /^(hi|hello|hey|thanks|thank you|good morning|good evening|good afternoon|good night|bye)\b/i.test(lower)) {
      return { type: 'casual' };
    }
    return { type: 'new_task' };  // default to action-likely if not casual/question
  }

  // ── Pending exists ───────────────────────────────────────────────
  const pid = args.pending.id;

  // Cancellation — short, closed vocabulary.
  if (lower.length <= 30 && CANCELLATION_RE.test(lower)) {
    return { type: 'cancel_pending', pendingId: pid };
  }

  // Confirmation — only valid when status is 'preview_shown'. Outside
  // that status, a bare "yes" is ambiguous (could be agreeing with a
  // factual statement, not confirming an action).
  if (args.pending.status === 'preview_shown' && lower.length <= 30 && CONFIRMATION_RE.test(lower)) {
    return { type: 'confirm_preview', pendingId: pid };
  }

  // Correction — pattern starts with change / actually / make it /
  // etc. AND we have a preview shown. The user is editing slots
  // before confirming.
  if (args.pending.status === 'preview_shown' && CORRECTION_RE.test(lower)) {
    return { type: 'correct_preview', pendingId: pid };
  }

  // New imperative mid-pending → treat as new_task (will displace
  // the pending in compose). User chose to switch focus.
  if (NEW_TASK_IMPERATIVE_RE.test(lower)) {
    return { type: 'new_task' };
  }

  // Short message + status is collecting_slots → slot-fill continuation.
  // The exact field being filled is determined later by the slot
  // extractor reading the next missingSlot.
  if (args.pending.status === 'collecting_slots' && q.length <= 80) {
    return { type: 'continue_task', pendingId: pid };
  }

  // Question mark → user asking about something (likely about the
  // pending or related context). Route to answer flow, not action.
  if (lower.endsWith('?')) return { type: 'answer_question' };

  // Default: ambiguous. Caller may decide to fall through to full
  // compose or call an LLM tiebreaker.
  return { type: 'ambiguous' };
}

/** Convenience predicate — does this relation type need the full
 *  composer call, or can the pending path handle it deterministically? */
export function needsFullComposer(rel: TurnRelation): boolean {
  return rel.type === 'new_task' || rel.type === 'answer_question' || rel.type === 'ambiguous';
}

/** LLM-assisted tiebreaker for 'ambiguous' classifications. Used when
 *  deterministic reduceTurn returns 'ambiguous' AND a pending exists —
 *  the relation matters enough to spend a small Flash call disambiguating.
 *
 *  Examples this catches that regex doesn't:
 *    "yes but change to 4"      → correct_preview (not confirm)
 *    "ship it"                  → confirm_preview
 *    "looks good, fire it off"  → confirm_preview
 *    "actually hold on"         → cancel_pending
 *    "make it 30 mins instead"  → correct_preview
 *    "do it but loop in Asad"   → correct_preview (slot added)
 *
 *  Output schema is ONLY the relation type — the slot extraction
 *  happens elsewhere. This keeps the call tight (~80 tokens) and
 *  the JSON narrow. */
export async function resolveAmbiguousWithLlm(args: {
  question: string;
  pending: import('./pendingActionService').PendingAction;
  lastBrainText: string;
}): Promise<TurnRelation> {
  try {
    const { callGemini } = await import('../geminiService');
    const systemPrompt = `You are a turn classifier. Given:
- a user's current message
- the in-progress pending action's status and slots
- Brain's last message (likely a preview or question)

decide which of these relations best fits the user's message:

- "confirm_preview": user is approving the previewed action as-is
- "correct_preview": user is approving but wants ONE OR MORE slots changed
- "cancel_pending": user wants to abort the pending action entirely
- "continue_task": user is providing a missing slot Brain asked about
- "new_task": user has switched to a new, unrelated request
- "answer_question": user is asking Brain a question (not acting on the pending)

Examples:
- "yes" + status=preview_shown → confirm_preview
- "ship it" → confirm_preview
- "yes but make it 4" → correct_preview
- "actually hold on" → cancel_pending
- "what's on my calendar tomorrow?" → answer_question
- "schedule another with Bob" → new_task

Output ONLY a JSON object:
{ "relation": "confirm_preview" | "correct_preview" | "cancel_pending" | "continue_task" | "new_task" | "answer_question", "rationale": "<one short sentence>" }`;

    const userPayload = `User's message: ${args.question}

Pending action: ${args.pending.actionKind} (status=${args.pending.status})
Pending slots: ${JSON.stringify(args.pending.slots)}

Brain's last message: ${args.lastBrainText.slice(0, 600)}`;

    const raw = await callGemini(systemPrompt, userPayload, {
      maxTokens: 256,
      flash: true,
      responseMimeType: 'application/json',
    });
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    const relation = String(parsed.relation ?? '').trim();
    const valid = ['confirm_preview', 'correct_preview', 'cancel_pending', 'continue_task', 'new_task', 'answer_question'];
    if (!valid.includes(relation)) return { type: 'ambiguous' };
    if (relation === 'new_task') return { type: 'new_task' };
    if (relation === 'answer_question') return { type: 'answer_question' };
    if (relation === 'cancel_pending') return { type: 'cancel_pending', pendingId: args.pending.id };
    if (relation === 'confirm_preview') return { type: 'confirm_preview', pendingId: args.pending.id };
    if (relation === 'correct_preview') return { type: 'correct_preview', pendingId: args.pending.id };
    if (relation === 'continue_task') return { type: 'continue_task', pendingId: args.pending.id };
    return { type: 'ambiguous' };
  } catch (e: any) {
    console.warn('[turn-reducer] llm tiebreaker failed', { error: e?.message });
    return { type: 'ambiguous' };
  }
}
