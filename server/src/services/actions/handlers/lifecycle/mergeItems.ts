import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import * as openItemsService from '../../../openItemsService';

export class MergeItemsHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'merge_items', category: 'lifecycle', description: 'Combine duplicate open items into a single canonical item', version: '1.0' };
  }
  schema() {
    return {
      type: 'object',
      required: ['keepItemId', 'duplicateItemIds'],
      properties: {
        keepItemId: { type: 'string' },
        duplicateItemIds: { type: 'array', minItems: 1, items: { type: 'string' } },
        reason: { type: 'string' },
      },
    };
  }
  auditFields() { return ['keepItemId', 'mergedIds']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.payload.keepItemId) errors.push('keepItemId required');
    const dups = ctx.payload.duplicateItemIds as unknown;
    if (!Array.isArray(dups) || dups.length < 1) errors.push('duplicateItemIds must be a non-empty array');
    if (Array.isArray(dups) && dups.includes(ctx.payload.keepItemId)) errors.push('keepItemId cannot appear in duplicateItemIds');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return {
      wouldSucceed: v.valid,
      preview: {
        keepItemId: ctx.payload.keepItemId,
        willMergeCount: (ctx.payload.duplicateItemIds as string[] | undefined)?.length ?? 0,
      },
      warnings: v.errors,
    };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const keepId = ctx.payload.keepItemId as string;
    const dups = (ctx.payload.duplicateItemIds as string[]) ?? [];
    const previousStatuses: Record<string, string> = {};
    for (const id of dups) {
      const prev = await openItemsService.getItem(id, ctx.clientNumber);
      if (prev) {
        previousStatuses[id] = prev.status;
        await openItemsService.changeStatus(
          id,
          ctx.clientNumber,
          'CLOSED' as any,
          `merged into ${keepId}`,
          ctx.executedByAgent ? `agent:${ctx.executedByAgent}` : `user:${ctx.userId}`,
        );
        await openItemsService.addNote(keepId, ctx.clientNumber, `merged item ${id}: ${prev.title}`, ctx.userId);
      }
    }
    return { ok: true, output: { keepItemId: keepId, mergedIds: dups, previousStatuses } };
  }
  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // Read-back (B2): the survivor must still exist, and every item
    // execute() claims it merged (previousStatuses keys — the duplicates
    // it actually found) must now sit at CLOSED. Zero merged rows means
    // no side effect happened, which must never read as a confirmed
    // merge — fail closed.
    const o = output as { keepItemId?: string; previousStatuses?: Record<string, string> } | null;
    const keepId = o?.keepItemId ?? (ctx.payload.keepItemId as string | undefined);
    const mergedIds = Object.keys(o?.previousStatuses ?? {});
    if (!keepId || mergedIds.length === 0) return false;
    const survivor = await openItemsService.getItem(keepId, ctx.clientNumber);
    if (!survivor) return false;
    for (const id of mergedIds) {
      const row = await openItemsService.getItem(id, ctx.clientNumber);
      if (row?.status !== 'CLOSED') return false;
    }
    return true;
  }

  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { mergedIds: string[]; previousStatuses: Record<string, string> };
    return { handler: 'merge_items.revert', payload: { restore: o.previousStatuses }, note: 'restore each merged item to its previous status' };
  }
}
