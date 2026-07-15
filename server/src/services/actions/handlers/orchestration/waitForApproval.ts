import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, HandlerMetadata } from '../../handlerBase';
import { createPendingApproval } from '../../../risk/approvalWorkflow';
import type { RiskEvaluation } from '../../../risk/riskGatingService';
import prisma from '../../../../db/prisma';

export class WaitForApprovalHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return {
      name: 'wait_for_approval',
      category: 'orchestration',
      description: 'Create a pending-approval record; downstream handler runs after human approves',
      version: '1.0',
    };
  }
  schema() {
    return {
      type: 'object',
      required: ['downstreamAction', 'reason'],
      properties: {
        downstreamAction: { type: 'string' },
        downstreamPayload: { type: 'object' },
        reason: { type: 'string' },
        riskTier: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'], default: 'HIGH' },
      },
    };
  }
  auditFields() { return ['downstreamAction', 'riskTier', 'approvalId']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.payload.downstreamAction) errors.push('downstreamAction required');
    if (!ctx.payload.reason) errors.push('reason required');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return {
      wouldSucceed: v.valid,
      preview: {
        willCreatePendingApproval: true,
        downstreamAction: ctx.payload.downstreamAction,
        riskTier: ctx.payload.riskTier ?? 'HIGH',
      },
      warnings: v.errors,
    };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const tier = (ctx.payload.riskTier as 'LOW' | 'MEDIUM' | 'HIGH') ?? 'HIGH';
    const evaluation: RiskEvaluation = {
      tier,
      reasons: [String(ctx.payload.reason)],
      policy: tier === 'LOW' ? 'auto_execute' : tier === 'MEDIUM' ? 'confirm' : 'full_review',
    };
    // Stash the parent action id so that when the downstream action eventually runs
    // through executeViaRegistry, it can record the dependency edge back to this one.
    const downstreamPayload = {
      ...((ctx.payload.downstreamPayload as Record<string, unknown>) ?? {}),
      _parentActionId: ctx.rootActionId ?? null,
      _parentDependencyGraphId: ctx.dependencyGraphId ?? null,
    };
    const approvalId = await createPendingApproval({
      ctx: {
        clientNumber: ctx.clientNumber,
        userId: ctx.userId,
        actionType: String(ctx.payload.downstreamAction),
        openItemId: ctx.openItemId,
        entityId: ctx.entityId,
        payload: downstreamPayload,
      },
      evaluation,
      draft: undefined,
    });
    return {
      ok: true,
      output: {
        approvalId,
        status: 'pending',
        linkedParentActionId: ctx.rootActionId ?? null,
      },
    };
  }
  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // B2 read-back: this handler's own side effect is the WAIT GATE, not the
    // downstream action — so confirm() verifies the pending-approval row
    // exists (tenant-scoped, right actionType, requiresApproval, still
    // 'pending'). It deliberately does NOT wait for the human to approve or
    // for the downstream action to run; that happens later via the approval
    // inbox / push flow. Fail closed if the gate row cannot be found awaiting.
    const o = output as { approvalId?: number } | null;
    if (typeof o?.approvalId !== 'number') return false;
    const row = await prisma.agentAction.findFirst({
      where: {
        id: o.approvalId,
        clientNumber: ctx.clientNumber,
        actionType: String(ctx.payload.downstreamAction),
        requiresApproval: true,
        status: 'pending',
      },
      select: { id: true },
    });
    return row !== null;
  }
}
