import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, HandlerMetadata } from '../../handlerBase';
import { record as recordDecision } from '../../../decisions/decisionLogService';

export class LogOverrideHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'log_override', category: 'governance', description: 'Record that the user overrode an AI suggestion, for calibration / training', version: '1.0' };
  }
  schema() {
    return {
      type: 'object',
      required: ['suggestedAction', 'userDecision'],
      properties: {
        suggestedAction: { type: 'string' },
        userDecision: { type: 'string', enum: ['approved', 'overrode', 'delegated', 'snoozed', 'dismissed'] },
        actionTaken: { type: 'string' },
        overrideReason: { type: 'string' },
        sessionType: { type: 'string' },
        itemType: { type: 'string' },
        entityId: { type: 'string' },
        connectorSlug: { type: 'string' },
        confidenceScore: { type: 'number' },
        riskTier: { type: 'string' },
        durationMs: { type: 'number' },
        openItemId: { type: 'string' },
      },
    };
  }
  auditFields() { return ['decisionLogId', 'userDecision']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.payload.suggestedAction) errors.push('suggestedAction required');
    if (!ctx.payload.userDecision) errors.push('userDecision required');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return { wouldSucceed: v.valid, preview: { userDecision: ctx.payload.userDecision, riskTier: ctx.payload.riskTier ?? null }, warnings: v.errors };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const result = await recordDecision({
      userId: ctx.userId,
      clientNumber: ctx.clientNumber,
      sessionType: (ctx.payload.sessionType as string) ?? 'intraday',
      itemType: (ctx.payload.itemType as string) ?? 'manual',
      entityId: ctx.payload.entityId as string | undefined,
      connectorSlug: ctx.payload.connectorSlug as string | undefined,
      suggestedAction: ctx.payload.suggestedAction as string,
      userDecision: ctx.payload.userDecision as any,
      actionTaken: ctx.payload.actionTaken as string | undefined,
      isMatch: ctx.payload.userDecision === 'approved',
      overrideReason: ctx.payload.overrideReason as string | undefined,
      openItemId: ctx.openItemId ?? (ctx.payload.openItemId as string | undefined),
      confidenceScore: ctx.payload.confidenceScore as number | undefined,
      riskTier: ctx.payload.riskTier as any,
      durationMs: ctx.payload.durationMs as number | undefined,
      traceId: ctx.traceId,
      agentId: ctx.executedByAgent,
    });
    return { ok: true, output: { decisionLogId: result.id, archivedToBq: result.archivedToBq } };
  }
}
