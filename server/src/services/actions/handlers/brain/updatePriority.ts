import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import prisma from '../../../../db/prisma';
import * as openItemsService from '../../../openItemsService';

export class UpdatePriorityHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'update_priority', category: 'brain', description: 'Change the priority score of an open item', version: '1.0' };
  }
  schema() {
    return { type: 'object', required: ['priorityScore'], properties: { priorityScore: { type: 'number' }, reason: { type: 'string' } } };
  }
  auditFields() { return ['openItemId', 'previousScore', 'newScore']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.openItemId) errors.push('openItemId required');
    if (typeof ctx.payload.priorityScore !== 'number') errors.push('priorityScore (number) required');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return { wouldSucceed: v.valid, preview: { openItemId: ctx.openItemId, newScore: ctx.payload.priorityScore }, warnings: v.errors };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const item = await openItemsService.getItem(ctx.openItemId!, ctx.clientNumber);
    if (!item) return { ok: false, error: 'open item not found' };
    const newScore = ctx.payload.priorityScore as number;
    await prisma.openItem.update({ where: { id: ctx.openItemId! }, data: { priorityScore: newScore } });
    return { ok: true, output: { openItemId: ctx.openItemId, previousScore: item.priorityScore, newScore } };
  }
  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { previousScore: number | null };
    return { handler: 'update_priority', payload: { openItemId: ctx.openItemId, priorityScore: o.previousScore ?? 0.5 } };
  }
}
