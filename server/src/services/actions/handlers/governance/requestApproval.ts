import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, HandlerMetadata } from '../../handlerBase';
import { createPendingApproval } from '../../../risk/approvalWorkflow';
import type { RiskTier, RiskEvaluation } from '../../../risk/riskGatingService';
import prisma from '../../../../db/prisma';

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
  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // B2 read-back: "approval requested" means the gate row created by
    // createPendingApproval actually exists — an AgentAction in this tenant,
    // for the target action, flagged requiresApproval, still awaiting a
    // human ('pending'). The push notification is fire-and-forget and is
    // deliberately NOT part of the confirmation. Fail closed if the row is
    // missing or already left the awaiting state before we could verify it.
    const o = output as { approvalId?: number } | null;
    if (typeof o?.approvalId !== 'number') return false;
    const row = await prisma.agentAction.findFirst({
      where: {
        id: o.approvalId,
        clientNumber: ctx.clientNumber,
        actionType: String(ctx.payload.targetAction),
        requiresApproval: true,
        status: 'pending',
      },
      select: { id: true },
    });
    return row !== null;
  }
}
