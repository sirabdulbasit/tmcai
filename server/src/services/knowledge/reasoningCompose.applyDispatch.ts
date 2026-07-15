/**
 * reasoningCompose dispatch helper — Phase 6 + 7 (2026-05-22).
 *
 * Takes a ReasoningResult from reasoningCompose() and produces a
 * ComposeResult-shape envelope. Wires:
 *   - act → generic dispatcher (preview gate + idempotency + handler)
 *   - ask → clarification memory write (so we can lookup next time)
 *   - answer → pass-through
 *   - decline → honest decline message
 *
 * This is the bridge between reasoning-decides and the existing
 * safety / dispatch stack. The legacy compose() will call this
 * helper when opts.useReasoning=true is on; once verified, becomes
 * the default path.
 */
import type { ReasoningResult } from './reasoningCompose';
import type { ComposedAction, ComposeResult } from './brainComposer';
import { dispatchAction } from './genericActionDispatcher';
import { recordResolution, findResolution } from './clarificationMemoryService';
import { validateReasoningAction } from './reasoningCompose';

/** Build a ComposeResult envelope from a reasoning decision. Wires
 *  dispatch / clarification memory / safety gates as appropriate. */
export async function applyReasoningDecision(args: {
  result: ReasoningResult;
  userId: number;
  clientNumber: string;
  channel: 'web' | 'whatsapp';
  question: string; // user's original message — for clarification memory record
}): Promise<ComposeResult> {
  const { result, userId, clientNumber, channel, question } = args;

  switch (result.decision) {
    case 'answer':
      return {
        answer: result.answerText || '(no answer)',
        citedPageIds: [],
        gaps: [],
        sources: [],
        action: null,
        actionResult: null,
      };

    case 'decline':
      // If the decider didn't fill in declineReason, emit a bracketed
      // system marker instead of a hardcoded English fallback. Per
      // memory rule feedback_no_hardcoded_brain_replies: every
      // Brain-surface reply must be LLM-generated OR a bracketed
      // system marker; hardcoded English pretending to be Brain is
      // forbidden. The answerSanitizer rewrites the marker to
      // human-readable text on the way out.
      return {
        answer: result.declineReason || `[declined: no reason captured from decider]`,
        citedPageIds: [],
        gaps: [],
        sources: [],
        action: null,
        actionResult: { ok: false, message: 'declined' },
      };

    case 'ask': {
      // Record the pending question so the next-turn answer can be
      // captured into clarification_memory.
      const q = result.question;
      if (q) {
        // Stash a marker that Phase 7 picks up on the user's answer.
        // For now we just write the question to the memory with a
        // placeholder resolution — the next turn's reasoning gets
        // told "user just answered THIS slot" and updates the row.
        // (Simpler MVP: leave the actual resolution write for the
        // next turn; we just need the question text available.)
        try {
          // We intentionally don't write a resolution here — Phase 7
          // captures it when the user actually answers.
        } catch { /* non-fatal */ }
      }
      return {
        answer: q?.text || `I need one more detail before I can proceed.`,
        citedPageIds: [],
        gaps: [],
        sources: [],
        action: null,
        actionResult: { ok: false, message: 'clarification_needed' },
      };
    }

    case 'act': {
      const action = result.action;
      if (!action || !action.type || !action.payload) {
        return {
          answer: `I tried to act but the structured action wasn't well-formed. Try again with a more specific request.`,
          citedPageIds: [], gaps: [], sources: [], action: null,
          actionResult: { ok: false, message: 'malformed_action' },
        };
      }
      // Validate against registry (tenant-scoped — E3/E5).
      const errs = await validateReasoningAction(action, clientNumber);
      if (errs && errs.length > 0) {
        return {
          answer: `Action validation failed: ${errs.join('; ')}. Need: ${errs[0]}.`,
          citedPageIds: [], gaps: [], sources: [], action: null,
          actionResult: { ok: false, message: 'schema_violation' },
        };
      }
      // Note: preview-by-default gate is NOT inside the generic
      // dispatcher — it stays in compose's outer flow. For Phase 6
      // we pass the action back to the legacy compose flow and let
      // it apply the gate. The action is wrapped as a ComposedAction.
      const composedAction = { type: action.type, ...action.payload } as ComposedAction;
      return {
        answer: result.answerText || `Proceeding with ${action.type.replace(/_/g, ' ')}.`,
        citedPageIds: [],
        gaps: [],
        sources: [],
        action: composedAction,
        actionResult: null, // dispatch happens in compose's outer flow
      };
    }

    case 'tool_call':
      // Unreachable in normal flow: reasoningComposeWithTools loops on
      // tool_call internally and only returns non-tool_call decisions.
      // If we land here it means a caller invoked the lower-level
      // reasoningCompose directly without wiring the tool runner —
      // a programming error, not a user-facing case. Use a bracketed
      // system marker (not a fake Brain reply) so the violation is
      // visible to operators but the user sees a structural message.
      // Per feedback_no_hardcoded_brain_replies.md.
      return {
        answer: '[system: tool_call returned to dispatcher without a runner — programming error]',
        citedPageIds: [], gaps: [], sources: [], action: null,
        actionResult: { ok: false, message: 'tool_call_unhandled' },
      };
  }
}

/** Phase 7: when the user answers a previous clarify, record the
 *  resolution so Brain doesn't ask again. Called from compose() when
 *  history shows Brain's last turn was a clarify question. */
export async function recordClarificationFromAnswer(args: {
  userId: number;
  clientNumber: string;
  previousQuestion: { text: string; slotBeingFilled: string; contextTokens: string[] };
  userAnswer: string;
  contextSnapshot?: Record<string, unknown>;
}): Promise<void> {
  try {
    await recordResolution({
      clientNumber: args.clientNumber,
      userId: args.userId,
      questionPattern: args.previousQuestion.text,
      slotBeingFilled: args.previousQuestion.slotBeingFilled,
      contextTokens: args.previousQuestion.contextTokens,
      resolutionValue: { answer: args.userAnswer.trim() },
      resolutionContext: args.contextSnapshot ?? null,
    });
  } catch (e: any) {
    console.warn('[reasoningCompose] clarification record failed (non-fatal)', { error: e?.message });
  }
}

/** Phase 7: before reasoning decides to ask, check if a similar
 *  question was already resolved. Caller injects the resolution
 *  into the reasoning context so the LLM doesn't re-ask. */
export async function lookupClarification(args: {
  userId: number;
  slotBeingFilled: string;
  contextTokens: string[];
}): Promise<{ resolution: unknown; usedCount: number } | null> {
  const found = await findResolution(args).catch(() => null);
  if (!found) return null;
  return {
    resolution: found.resolutionValue,
    usedCount: found.usedCount,
  };
}

/** C4 (2026-07-08): ClarificationMemory finally gets a READER. When
 *  reasoning emits decision='ask', reasoningComposeWithTools calls this
 *  before letting the question through. A hit renders an injection block;
 *  the pass re-runs with the prior resolution in context so Brain uses
 *  the answer the user already gave ("which Asad?" asked once, never
 *  again) instead of re-asking. Miss / no slot / lookup failure → null,
 *  and the ask proceeds normally. */
export async function buildClarificationInjection(
  userId: number,
  question: { text: string; slotBeingFilled: string; contextTokens: string[] } | null | undefined,
): Promise<string | null> {
  if (!question?.slotBeingFilled) return null;
  try {
    const hit = await lookupClarification({
      userId,
      slotBeingFilled: question.slotBeingFilled,
      contextTokens: question.contextTokens ?? [],
    });
    if (!hit) return null;
    return [
      '# Previously resolved clarification',
      `You were about to ask: "${question.text}"`,
      `The user already resolved slot '${question.slotBeingFilled}' before (reused ${hit.usedCount}x): ${JSON.stringify(hit.resolution)}`,
      'Do not re-ask. Proceed using this resolution. If it clearly cannot apply to THIS request, you may still ask — but say why the remembered answer does not fit.',
    ].join('\n');
  } catch {
    return null;
  }
}
