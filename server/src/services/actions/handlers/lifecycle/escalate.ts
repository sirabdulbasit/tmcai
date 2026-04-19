import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import prisma from '../../../../db/prisma';
import * as openItemsService from '../../../openItemsService';

const PRIORITY_LADDER = ['low', 'medium', 'high', 'critical'] as const;

export class EscalateHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'escalate', category: 'lifecycle', description: 'Raise priority and optionally notify a supervisor', version: '1.0' };
  }
  schema() {
    return {
      type: 'object',
      properties: {
        notifyUserId: { type: 'number' },
        reason: { type: 'string' },
      },
    };
  }
  auditFields() { return ['openItemId', 'previousPriority', 'newPriority', 'notifyUserId']; }
  riskLevel() { return 'MEDIUM' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    if (!ctx.openItemId) return { valid: false, errors: ['openItemId required'] };
    return { valid: true };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return { wouldSucceed: v.valid, preview: { openItemId: ctx.openItemId, willRaisePriority: true, willNotify: ctx.payload.notifyUserId }, warnings: v.errors };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const item = await openItemsService.getItem(ctx.openItemId!, ctx.clientNumber);
    if (!item) return { ok: false, error: 'open item not found' };
    const curIdx = PRIORITY_LADDER.indexOf(item.priority as any);
    const nextIdx = Math.min(curIdx + 1, PRIORITY_LADDER.length - 1);
    const newPriority = PRIORITY_LADDER[nextIdx];
    await prisma.openItem.update({ where: { id: ctx.openItemId! }, data: { priority: newPriority } });
    let notifyId: number | null = null;
    if (ctx.payload.notifyUserId) {
      notifyId = Number(ctx.payload.notifyUserId);
      await prisma.notificationQueue.create({
        data: {
          clientNumber: ctx.clientNumber,
          recipientId: notifyId,
          channel: 'in_app',
          payload: { kind: 'escalation', openItemId: ctx.openItemId, reason: ctx.payload.reason ?? '' } as any,
        },
      });
    }
    return { ok: true, output: { openItemId: ctx.openItemId, previousPriority: item.priority, newPriority, notifyUserId: notifyId } };
  }
  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { previousPriority: string };
    return { handler: 'demote', payload: { openItemId: ctx.openItemId, targetPriority: o.previousPriority } };
  }
}
