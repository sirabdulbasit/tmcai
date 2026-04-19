import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, HandlerMetadata } from '../../handlerBase';
import { createPendingApproval } from '../../../risk/approvalWorkflow';
import type { RiskTier, RiskEvaluation } from '../../../risk/riskGatingService';

export class RequestApprovalHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'request_approval', category: 'governance', description: 'Put any action into the approval queue explicitly', version: '1.0' };
  }
  schema() {
    return {
      type: 'object',
      required: ['targetAction', 'reason'],
      properties: {
        targetAction: { type: 'string' },
        targetPayload: { type: 'object' },
        riskTier: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
        reason: { type: 'string' },
      },
    };
  }
  auditFields() { return ['targetAction', 'approvalId']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.payload.targetAction) errors.push('targetAction required');
    if (!ctx.payload.reason) errors.push('reason required');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return {
      wouldSucceed: v.valid,
      preview: { willCreateApproval: true, targetAction: ctx.payload.targetAction, riskTier: ctx.payload.riskTier ?? 'MEDIUM' },
      warnings: v.errors,
    };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const tier = (ctx.payload.riskTier as RiskTier) ?? 'MEDIUM';
    const evaluation: RiskEvaluation = {
      tier,
      reasons: [String(ctx.payload.reason)],
      policy: tier === 'LOW' ? 'auto_execute' : tier === 'MEDIUM' ? 'confirm' : 'full_review',
    };
    const approvalId = await createPendingApproval({
      ctx: {
        clientNumber: ctx.clientNumber,
        userId: ctx.userId,
        actionType: String(ctx.payload.targetAction),
        openItemId: ctx.openItemId,
        entityId: ctx.entityId,
        payload: (ctx.payload.targetPayload as Record<string, unknown>) ?? {},
      },
      evaluation,
    });
    return { ok: true, output: { approvalId, status: 'pending', riskTier: tier } };
  }
}
