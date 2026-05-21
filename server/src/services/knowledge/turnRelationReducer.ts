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
