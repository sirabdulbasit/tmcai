import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import * as openItemsService from '../../../openItemsService';

export class CloseHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'close', category: 'lifecycle', description: 'Mark an open item as done', version: '1.0' };
  }
  schema() {
    return { type: 'object', properties: { outcome: { type: 'string' } } };
  }
  auditFields() { return ['openItemId', 'outcome']; }
  riskLevel() { return 'LOW' as const; }

  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    if (!ctx.openItemId) return { valid: false, errors: ['openItemId required'] };
    return { valid: true };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return { wouldSucceed: v.valid, preview: { openItemId: ctx.openItemId, newStatus: 'done' }, warnings: v.errors };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const previous = await openItemsService.getItem(ctx.openItemId!, ctx.clientNumber);
    if (!previous) return { ok: false, error: 'open item not found' };
    const outcome = (ctx.payload.outcome as string) ?? 'closed via action handler';
    await openItemsService.changeStatus(
      ctx.openItemId!,
      ctx.clientNumber,
      'CLOSED' as any,
      outcome,
      ctx.executedByAgent ? `agent:${ctx.executedByAgent}` : `user:${ctx.userId}`,
    );
    return { ok: true, output: { openItemId: ctx.openItemId, previousStatus: previous.status, outcome } };
  }
  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // Read-back (B2): re-fetch the row and assert the CLOSED transition
    // actually stuck. changeStatus() throws on rejection, but we never
    // trust the in-memory success path — only what the row says now.
    const o = output as { openItemId?: string } | null;
    const id = o?.openItemId ?? ctx.openItemId;
    if (!id) return false; // nothing to verify → fail closed
    const item = await openItemsService.getItem(id, ctx.clientNumber);
    return item?.status === 'CLOSED';
  }

  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { previousStatus: string };
    return { handler: 'close.revert', payload: { openItemId: ctx.openItemId, restoreStatus: o.previousStatus } };
  }
}
