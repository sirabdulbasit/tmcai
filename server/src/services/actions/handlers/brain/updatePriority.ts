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
  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // B2 read-back: "priority updated" only counts if the OpenItem row now
    // carries the exact score execute() wrote, in this tenant. Fail closed on
    // a missing row or a mismatched score (e.g. a concurrent writer raced us).
    const o = output as { openItemId?: string; newScore?: number } | null;
    if (!o?.openItemId || typeof o.newScore !== 'number') return false;
    const row = await prisma.openItem.findFirst({
      where: { id: o.openItemId, clientNumber: ctx.clientNumber },
      select: { priorityScore: true },
    });
    return row !== null && row.priorityScore === o.newScore;
  }
  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { previousScore: number | null };
    return { handler: 'update_priority', payload: { openItemId: ctx.openItemId, priorityScore: o.previousScore ?? 0.5 } };
  }
}
