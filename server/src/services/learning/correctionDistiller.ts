// ═════════════════════════════════════════════════════════════════════════════
// correctionDistiller — turns a user's correctedOutput into durable learning.
//
// C3 (2026-07-08): BrainFeedback.correctedOutput — the user literally
// rewriting Brain's output, the strongest correction signal there is — was
// written and never read. The distiller compares Brain's original output
// against the user's rewrite (LLM judgment, never regex — per the
// no-hardcoded-judgement rule) and extracts the durable preference behind
// the edit.
//
// Distilled preferences become GOVERNED MEMORY PROPOSALS: createdByBrain
// forces pending_approval, the user approves in Settings, and the active
// memory is injected on every prompt via governedMemoriesBlock (C1).
// Human approval replaces a statistical corroboration threshold — one
// strong correction may PROPOSE; the user gates whether it sticks.
// ═════════════════════════════════════════════════════════════════════════════

import prisma from '../../db/prisma';
import { callLLM } from '../llmRouter';
import createLogger from '../../utils/logger';

const log = createLogger('correction-distiller');

const CONFIDENCE_FLOOR = 0.5;

const DISTILL_PROMPT = `You compare an AI assistant's original output with the user's hand-corrected version and extract the DURABLE PREFERENCE behind the edit — the rule the user would want applied to all future outputs, not the one-off content fix.

Return JSON only:
{"title": "<short imperative rule, max 80 chars>", "content": "<1-3 sentence instruction the assistant can follow next time>", "confidence": <0..1 — how clearly the edit expresses a repeatable preference rather than a one-off factual fix>}

If the correction is purely factual/one-off (a name, a date, a number) with no repeatable pattern, return confidence below 0.5.`;

export interface DistillInput {
  clientNumber: string;
  userId: number;
  feedbackId: string;
  correctedOutput: string;
  feedbackComment?: string | null;
  interactionId?: string | null;
  /** Injectable for tests; defaults to learningService.proposeMemory. */
  proposeMemory?: (args: any) => Promise<{ id: string; status: string }>;
}

export async function distillCorrection(input: DistillInput): Promise<{ proposed: boolean; memoryId?: string }> {
  const corrected = (input.correctedOutput ?? '').trim();
  if (!corrected) return { proposed: false };

  try {
    // Pull the original exchange when the feedback is linked to one — the
    // diff between brainResponse and the rewrite is where the signal lives.
    let original = '';
    let prompt = '';
    if (input.interactionId) {
      const ix = await prisma.brainInteractionLearningLog.findFirst({
        where: { id: input.interactionId, userId: input.userId },
        select: { userPrompt: true, brainResponse: true },
      }).catch(() => null);
      original = ix?.brainResponse ?? '';
      prompt = ix?.userPrompt ?? '';
    }

    const userMsg = [
      prompt ? `User's request:\n${prompt}\n` : '',
      original ? `Assistant's original output:\n${original}\n` : '(original output unavailable)\n',
      `User's corrected version:\n${corrected}`,
      input.feedbackComment ? `\nUser's comment: ${input.feedbackComment}` : '',
      '\nJSON:',
    ].filter(Boolean).join('\n');

    const r = await callLLM(DISTILL_PROMPT, userMsg, {
      maxTokens: 400,
      providers: ['gemini-flash', 'gemini', 'claude'],
      userId: input.userId,
      clientNumber: input.clientNumber,
      purpose: 'correction_distill',
      timeoutMs: 15_000,
    });
    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) return { proposed: false };
    const obj = JSON.parse(m[0]);
    const confidence = Math.max(0, Math.min(1, Number(obj.confidence) || 0));
    if (confidence < CONFIDENCE_FLOOR || !obj.title || !obj.content) {
      log.info('correction not distilled (one-off or unclear)', { feedbackId: input.feedbackId, confidence });
      return { proposed: false };
    }

    const propose = input.proposeMemory
      ?? (await import('./learningService')).proposeMemory;
    const created = await propose({
      clientNumber: input.clientNumber,
      userId: input.userId,
      memoryScope: 'user',
      memoryType: 'correction_pattern',
      title: String(obj.title).slice(0, 200),
      content: String(obj.content).slice(0, 2000),
      sourceType: 'brain_feedback',
      sourceReferenceId: input.feedbackId,
      confidenceScore: confidence,
      createdByBrain: true, // governance: always pending_approval
    });
    log.info('correction distilled → governed memory proposal', {
      feedbackId: input.feedbackId, memoryId: created.id, confidence,
    });
    return { proposed: true, memoryId: created.id };
  } catch (err: any) {
    // Learning must never break the feedback write path.
    log.warn('correction distillation failed', { feedbackId: input.feedbackId, err: err?.message });
    return { proposed: false };
  }
}
