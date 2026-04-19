import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import * as openItemsService from '../../../openItemsService';

interface SubItemSpec {
  title: string;
  description?: string;
  priority?: string;
  type?: string;
}

export class SplitItemHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'split_item', category: 'lifecycle', description: 'Break one open item into multiple sub-items', version: '1.0' };
  }
  schema() {
    return {
      type: 'object',
      required: ['subItems'],
      properties: {
        subItems: { type: 'array', minItems: 2, items: { type: 'object', required: ['title'], properties: { title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string' }, type: { type: 'string' } } } },
        closeOriginal: { type: 'boolean', default: true },
      },
    };
  }
  auditFields() { return ['openItemId', 'createdIds']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.openItemId) errors.push('openItemId required');
    const sub = ctx.payload.subItems as unknown;
    if (!Array.isArray(sub) || sub.length < 2) errors.push('subItems must be an array of 2+ items');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    const sub = (ctx.payload.subItems as SubItemSpec[]) ?? [];
    return {
      wouldSucceed: v.valid,
      preview: { openItemId: ctx.openItemId, willCreate: sub.length, closeOriginal: ctx.payload.closeOriginal !== false },
      warnings: v.errors,
    };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const parent = await openItemsService.getItem(ctx.openItemId!, ctx.clientNumber);
    if (!parent) return { ok: false, error: 'parent item not found' };
    const sub = (ctx.payload.subItems as SubItemSpec[]) ?? [];
    const createdIds: string[] = [];
    for (const s of sub) {
      const created = await openItemsService.createItem(ctx.userId, ctx.clientNumber, {
        title: s.title,
        description: s.description,
        type: (s.type as any) ?? parent.type,
        priority: (s.priority as any) ?? parent.priority,
        sourceFeed: 'manual',
        entityId: parent.entityId ?? undefined,
        metadata: { splitFromId: parent.id } as any,
      } as any);
      createdIds.push((created as any).id);
    }
    if (ctx.payload.closeOriginal !== false) {
      await openItemsService.changeStatus(
        ctx.openItemId!,
        ctx.clientNumber,
        'CLOSED' as any,
        `split into ${createdIds.length} items`,
        ctx.executedByAgent ? `agent:${ctx.executedByAgent}` : `user:${ctx.userId}`,
      );
    }
    return { ok: true, output: { openItemId: ctx.openItemId, createdIds, closedOriginal: ctx.payload.closeOriginal !== false } };
  }
  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { createdIds: string[]; closedOriginal: boolean };
    return {
      handler: 'split_item.revert',
      payload: { deleteIds: o.createdIds, restoreOriginal: o.closedOriginal ? { id: ctx.openItemId, status: 'open' } : null },
      note: 'delete the children; restore the original status',
    };
  }
}
