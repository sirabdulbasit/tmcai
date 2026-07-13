import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import prisma from '../../../../db/prisma';
import * as openItemsService from '../../../openItemsService';

const PRIORITY_LADDER = ['low', 'medium', 'high', 'critical'] as const;

export class DemoteHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'demote', category: 'lifecycle', description: 'Lower the priority of an open item', version: '1.0' };
  }
  schema() {
    return { type: 'object', properties: { targetPriority: { type: 'string', enum: [...PRIORITY_LADDER] } } };
  }
  auditFields() { return ['openItemId', 'previousPriority', 'newPriority']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    if (!ctx.openItemId) return { valid: false, errors: ['openItemId required'] };
    return { valid: true };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return { wouldSucceed: v.valid, preview: { openItemId: ctx.openItemId, targetPriority: ctx.payload.targetPriority ?? 'one-step-lower' }, warnings: v.errors };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const item = await openItemsService.getItem(ctx.openItemId!, ctx.clientNumber);
    if (!item) return { ok: false, error: 'open item not found' };
    let newPriority: string;
    if (ctx.payload.targetPriority && PRIORITY_LADDER.includes(ctx.payload.targetPriority as any)) {
      newPriority = ctx.payload.targetPriority as string;
    } else {
      const curIdx = PRIORITY_LADDER.indexOf(item.priority as any);
      newPriority = PRIORITY_LADDER[Math.max(curIdx - 1, 0)];
    }
    await prisma.openItem.update({ where: { id: ctx.openItemId! }, data: { priority: newPriority } });
    return { ok: true, output: { openItemId: ctx.openItemId, previousPriority: item.priority, newPriority } };
  }
  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // Read-back (B2): the only side effect is the priority write —
    // re-fetch the row and assert it now carries exactly the priority
    // execute() reported. Missing row or drift → fail closed.
    const o = output as { openItemId?: string; newPriority?: string } | null;
    const id = o?.openItemId ?? ctx.openItemId;
    if (!id || !o?.newPriority) return false;
    const item = await openItemsService.getItem(id, ctx.clientNumber);
    return item?.priority === o.newPriority;
  }

  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { previousPriority: string };
    return { handler: 'escalate.revert', payload: { openItemId: ctx.openItemId, targetPriority: o.previousPriority } };
  }
}
