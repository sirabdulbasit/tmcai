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
  /** Injectable for tests; defaults to the real LLM extractor + dispatcher. */
  deps?: {
    extract?: (a: { text: string; clientNumber: string; userId: number }) => Promise<ExtractedInstruction>;
    dispatch?: (a: { instruction: ExtractedInstruction; clientNumber: string; userId: number }) => Promise<DispatchResult>;
  };
}): Promise<{ dispatched: boolean; ackMessage?: string }> {
  try {
    const extract = args.deps?.extract
      ?? (await import('../instructions/instructionExtractor')).extractInstruction;
    const ix = await extract({ text: args.text, clientNumber: args.clientNumber, userId: args.userId });

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
