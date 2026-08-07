// ═════════════════════════════════════════════════════════════════════════════
// piggybackedInstruction — rescue directives embedded in prompt replies.
//
// A6 (2026-07-08): when Brain is awaiting a prompt answer, the inbound
// message is consumed as the answer and the chat/instruction path is
// skipped. "Tomorrow, and always remind me at 5pm" was parsed only as a
// date — the directive silently lost. After the prompt side-effect
// resolves, we hand the FULL message to the LLM instruction extractor
// (no regex stripping — the LLM is the decision boundary, per the
// no-hardcoded-judgement rule). Plain answers come back intent='none';
// confident directives get dispatched and acked separately.
// ═════════════════════════════════════════════════════════════════════════════

import type { ExtractedInstruction } from '../instructions/instructionExtractor';
import type { DispatchResult } from '../instructions/instructionDispatcher';
import createLogger from '../../utils/logger';

const log = createLogger('brain-prompts:piggyback');

const CONFIDENCE_THRESHOLD = 0.6;

export async function handlePiggybackedInstruction(args: {
  text: string;
  clientNumber: string;
  userId: number;
  /**
   * DEF-093 — the question this text has just answered.
   *
   * The header above says "plain answers come back intent='none'", and that was
   * the design. It could not hold, because the extractor was handed the bare
   * message with no idea a question was outstanding. "High immediate" in
   * isolation is a plausible task title; "High immediate" as the answer to
   * "what priority and deadline?" plainly is not.
   */
  answeredQuestion?: string | null;
  /** Injectable for tests; defaults to the real LLM extractor + dispatcher. */
  deps?: {
    extract?: (a: { text: string; clientNumber: string; userId: number; answeredQuestion?: string | null }) => Promise<ExtractedInstruction>;
    dispatch?: (a: { instruction: ExtractedInstruction; clientNumber: string; userId: number }) => Promise<DispatchResult>;
  };
}): Promise<{ dispatched: boolean; ackMessage?: string }> {
  try {
    const extract = args.deps?.extract
      ?? (await import('../instructions/instructionExtractor')).extractInstruction;
    const ix = await extract({
      text: args.text,
      clientNumber: args.clientNumber,
      userId: args.userId,
      answeredQuestion: args.answeredQuestion ?? null,
    });

    if (ix.intent === 'none' || ix.confidence < CONFIDENCE_THRESHOLD) {
      return { dispatched: false };
    }

    const dispatch = args.deps?.dispatch
      ?? (await import('../instructions/instructionDispatcher')).dispatchInstruction;
    const result = await dispatch({ instruction: ix, clientNumber: args.clientNumber, userId: args.userId });
    log.info('piggybacked directive dispatched', {
      userId: args.userId, intent: ix.intent, ok: result.ok,
    });
    return { dispatched: result.ok, ackMessage: result.message };
  } catch (err: any) {
    // Never let directive rescue break the prompt-reply ack.
    log.warn('piggyback extraction failed — directive not rescued', { err: err?.message });
    return { dispatched: false };
  }
}
