import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import prisma from '../../../../db/prisma';

export class FreezeRuleHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'freeze_rule', category: 'governance', description: 'Freeze a SHADOW or ACTIVE rule so it no longer executes or promotes', version: '1.0' };
  }
  schema() {
    return {
      type: 'object',
      required: ['ruleId', 'reason'],
      properties: { ruleId: { type: 'string' }, reason: { type: 'string' } },
    };
  }
  auditFields() { return ['ruleId', 'previousState', 'reason']; }
  riskLevel() { return 'HIGH' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.payload.ruleId) errors.push('ruleId required');
    if (!ctx.payload.reason) errors.push('reason required');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return { wouldSucceed: v.valid, preview: { ruleId: ctx.payload.ruleId, willFreeze: true, reason: ctx.payload.reason }, warnings: v.errors };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const rule = await prisma.ruleLifecycle.findUnique({ where: { id: ctx.payload.ruleId as string } });
    if (!rule) return { ok: false, error: 'rule not found' };
    if (rule.clientNumber !== ctx.clientNumber) return { ok: false, error: 'rule belongs to a different tenant' };
    await prisma.ruleLifecycle.update({
      where: { id: rule.id },
      data: { frozen: true, frozenReason: ctx.payload.reason as string },
    });
    return { ok: true, output: { ruleId: rule.id, previousState: rule.state, previousFrozen: rule.frozen } };
  }
  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { ruleId: string; previousFrozen: boolean };
    return {
      handler: 'freeze_rule.revert',
      payload: { ruleId: o.ruleId, restoreFrozen: o.previousFrozen },
      note: 'unfreeze requires governance re-approval in practice',
    };
  }
}
