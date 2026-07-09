import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, HandlerMetadata, ReverseOperation } from '../../handlerBase';
import prisma from '../../../../db/prisma';

/**
 * notify_user_risk — proactive outreach when the risk radar flags something.
 *
 * D3 (2026-07-08): the daily RiskFlagDoc was computed and FILED, never
 * surfaced — risks were discovered and silently archived. This handler is
 * the bridge: riskRadarService calls it through executeViaRegistry with
 * initiator:'brain', which makes the outreach
 *   1. autonomy-gated (D1): observe_only proposes, drafts_only drafts,
 *      supervised queues for preview, full_auto sends;
 *   2. audited: an AgentAction row with executor-owned status;
 *   3. confirmed (B2): read-back against the brain prompt queue.
 * Delivery itself rides brainPromptQueueService — dedup, TTL, criticality
 * ordering, voice-call cooldown all apply as with any Brain prompt.
 */
export class NotifyUserRiskHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'notify_user_risk', category: 'brain', description: 'Proactively notify the user of high-severity risk flags via the Brain prompt queue', version: '1.0' };
  }
  schema() {
    return {
      type: 'object',
      required: ['docId', 'summary'],
      properties: {
        docId: { type: 'string' },
        summary: { type: 'string' },
        highSeverityCount: { type: 'number' },
      },
    };
  }
  auditFields() { return ['docId', 'dedupKey', 'status']; }
  riskLevel() { return 'LOW' as const; } // outreach to the user themselves, not outward-facing
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (typeof ctx.payload.docId !== 'string' || !ctx.payload.docId) errors.push('docId required');
    if (typeof ctx.payload.summary !== 'string' || !ctx.payload.summary) errors.push('summary required');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return { wouldSucceed: v.valid, preview: { question: this.renderQuestion(ctx) }, warnings: v.errors };
  }
  private renderQuestion(ctx: HandlerContext): string {
    // Bracketed framing keeps this an honest radar digest; the summary text
    // itself is LLM-narrated upstream (riskRadarService), not hardcoded prose.
    return `⚠️ Risk radar: ${String(ctx.payload.summary)}\n\nReply here or open the Day Brief for details.`;
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const dedupKey = `risk-outreach:${String(ctx.payload.docId)}`;
    try {
      const { enqueueBrainPrompt } = await import('../../../brainPrompts/brainPromptQueueService');
      const r = await enqueueBrainPrompt({
        userId: ctx.userId,
        clientNumber: ctx.clientNumber,
        question: this.renderQuestion(ctx),
        criticality: 'high',
        dedupKey,
        sideEffect: { kind: 'noop' },
        metadata: { source: 'risk_radar', docId: ctx.payload.docId, highSeverityCount: ctx.payload.highSeverityCount ?? null },
      });
      // 'duplicate' is success — the radar re-ran the same day and the risk
      // is already queued/surfaced; notifying twice would be noise.
      return { ok: true, output: { dedupKey, status: r.status, promptId: (r as any).promptId ?? null } };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }
  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // B2 read-back: outreach only counts if a prompt row with our dedupKey
    // actually exists in the queue for this user. Fail closed.
    const o = output as { dedupKey?: string } | null;
    if (!o?.dedupKey) return false;
    const row = await prisma.brainPromptQueue.findFirst({
      where: { userId: ctx.userId, clientNumber: ctx.clientNumber, dedupKey: o.dedupKey },
      select: { id: true },
    }).catch(() => null);
    return row !== null;
  }
  async undo(_ctx: HandlerContext, _output: unknown): Promise<ReverseOperation | null> {
    return null; // a queued notification isn't meaningfully reversible
  }
}
