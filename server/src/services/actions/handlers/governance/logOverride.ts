import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, HandlerMetadata } from '../../handlerBase';
import { record as recordDecision } from '../../../decisions/decisionLogService';
import prisma from '../../../../db/prisma';

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
  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // B2 read-back: the override only counts if the L3 DecisionLog row (the
    // Postgres operational layer, our system of record here) exists for this
    // tenant + user and carries the decision we recorded. The BQ archive
    // (archivedToBq) is best-effort by design — its absence must not fail a
    // decision that IS in Postgres, so we deliberately don't gate on it.
    const o = output as { decisionLogId?: string } | null;
    if (!o?.decisionLogId) return false;
    const row = await prisma.decisionLog.findFirst({
      where: {
        id: o.decisionLogId,
        clientNumber: ctx.clientNumber,
        userId: ctx.userId,
        userDecision: String(ctx.payload.userDecision),
      },
      select: { id: true },
    });
    return row !== null;
  }
}
