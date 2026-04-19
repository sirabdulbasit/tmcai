import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import prisma from '../../../../db/prisma';
import * as openItemsService from '../../../openItemsService';

export class ArchiveHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'archive', category: 'lifecycle', description: 'Soft-delete an open item from active view', version: '1.0' };
  }
  schema() {
    return { type: 'object', properties: { reason: { type: 'string' } } };
  }
  auditFields() { return ['openItemId', 'reason']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    if (!ctx.openItemId) return { valid: false, errors: ['openItemId required'] };
    return { valid: true };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return { wouldSucceed: v.valid, preview: { openItemId: ctx.openItemId, willSetStatus: 'archived' }, warnings: v.errors };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const previous = await openItemsService.getItem(ctx.openItemId!, ctx.clientNumber);
    if (!previous) return { ok: false, error: 'open item not found' };
    await prisma.openItem.update({
      where: { id: ctx.openItemId! },
      data: {
        status: 'done',
        metadata: { ...((previous.metadata as object) ?? {}), archivedAt: new Date().toISOString(), archiveReason: ctx.payload.reason ?? '' } as any,
      },
    });
    return { ok: true, output: { openItemId: ctx.openItemId, previousStatus: previous.status } };
  }
  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { previousStatus: string };
    return { handler: 'archive.revert', payload: { openItemId: ctx.openItemId, restoreStatus: o.previousStatus } };
  }
}
