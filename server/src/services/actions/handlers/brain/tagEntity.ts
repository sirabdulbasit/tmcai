import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import prisma from '../../../../db/prisma';
import * as openItemsService from '../../../openItemsService';

export class TagEntityHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'tag_entity', category: 'brain', description: 'Attach an entity reference to an open item', version: '1.0' };
  }
  schema() {
    return { type: 'object', required: ['entityId'], properties: { entityId: { type: 'string' } } };
  }
  auditFields() { return ['openItemId', 'entityId', 'previousEntityId']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.openItemId) errors.push('openItemId required');
    if (!ctx.payload.entityId) errors.push('entityId required');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return { wouldSucceed: v.valid, preview: { openItemId: ctx.openItemId, entityId: ctx.payload.entityId }, warnings: v.errors };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const item = await openItemsService.getItem(ctx.openItemId!, ctx.clientNumber);
    if (!item) return { ok: false, error: 'open item not found' };
    const newEntityId = ctx.payload.entityId as string;
    await prisma.openItem.update({ where: { id: ctx.openItemId! }, data: { entityId: newEntityId } });
    return { ok: true, output: { openItemId: ctx.openItemId, previousEntityId: item.entityId, newEntityId } };
  }
  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // B2 read-back: the tag only counts if the OpenItem row in this tenant now
    // points at the exact entity execute() wrote. Fail closed on a missing row
    // or a different entityId (concurrent re-tag or a write that never landed).
    const o = output as { openItemId?: string; newEntityId?: string } | null;
    if (!o?.openItemId || !o.newEntityId) return false;
    const row = await prisma.openItem.findFirst({
      where: { id: o.openItemId, clientNumber: ctx.clientNumber },
      select: { entityId: true },
    });
    return row !== null && row.entityId === o.newEntityId;
  }
  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { previousEntityId: string | null };
    return { handler: 'tag_entity', payload: { openItemId: ctx.openItemId, entityId: o.previousEntityId ?? null } };
  }
}
