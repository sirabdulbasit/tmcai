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
    // The preview names the status execute() actually writes. It said 'archived'
    // — a value no code path has ever written — which is DEF-044's class: a
    // preview describing something other than what the result will be.
    return { wouldSucceed: v.valid, preview: { openItemId: ctx.openItemId, willSetStatus: 'CANCELLED' }, warnings: v.errors };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const previous = await openItemsService.getItem(ctx.openItemId!, ctx.clientNumber);
    if (!previous) return { ok: false, error: 'open item not found' };
    // DEF-129 — this wrote the LEGACY LOWERCASE 'done', which is not in the v15
    // vocabulary, so `transitionStatus` refused every item this handler had ever
    // archived: a user-facing action that quietly made its own target permanently
    // unmovable. Now it goes THROUGH the matrix, with the archive breadcrumb
    // travelling in the same transaction as the status and the ledger row.
    //
    // CANCELLED, not CLOSED: "soft-delete from active view" is a withdrawal from
    // the plate, not completed work — and it is the reachable one, since
    // NEW -> CLOSED requires an approval this handler has no way to supply,
    // while NEW -> CANCELLED needs only the reason it already has.
    const { transitionStatus } = await import('../../../itemLifecycle/lifecycleService');
    const r = await transitionStatus(ctx.openItemId!, 'CANCELLED', {
      clientNumber: ctx.clientNumber,
      actor: ctx.executedByAgent ? `agent:${ctx.executedByAgent}` : `user:${ctx.userId}`,
      reason: `archived: ${ctx.payload.reason ?? 'no reason given'}`,
      itemData: {
        metadata: { ...((previous.metadata as object) ?? {}), archivedAt: new Date().toISOString(), archiveReason: ctx.payload.reason ?? '' } as any,
      },
    });
    // A refusal is reported as a failure rather than swallowed — DEF-128's rule.
    if (!r.ok) return { ok: false, error: r.error ?? 'archive refused by the lifecycle matrix' };
    return { ok: true, output: { openItemId: ctx.openItemId, previousStatus: previous.status } };
  }
  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // Read-back (B2): execute() sets CANCELLED PLUS an archivedAt breadcrumb in
    // metadata — assert both, because status alone can't distinguish an archive
    // from any other cancellation.
    const o = output as { openItemId?: string } | null;
    const id = o?.openItemId ?? ctx.openItemId;
    if (!id) return false; // nothing to verify → fail closed
    const row = await prisma.openItem.findFirst({
      where: { id, clientNumber: ctx.clientNumber },
      select: { status: true, metadata: true },
    });
    if (!row || row.status !== 'CANCELLED') return false;
    const meta = (row.metadata as Record<string, unknown> | null) ?? {};
    return typeof meta.archivedAt === 'string' && meta.archivedAt.length > 0;
  }

  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { previousStatus: string };
    return { handler: 'archive.revert', payload: { openItemId: ctx.openItemId, restoreStatus: o.previousStatus } };
  }
}
