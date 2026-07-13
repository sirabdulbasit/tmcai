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
  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // Read-back (B2): assert the priority bump landed on the row, and —
    // when a supervisor notification was part of the action — that the
    // queue row exists too. A half-applied escalation (priority written,
    // notification lost) must not read as confirmed.
    const o = output as { openItemId?: string; newPriority?: string; notifyUserId?: number | null } | null;
    const id = o?.openItemId ?? ctx.openItemId;
    if (!id || !o?.newPriority) return false; // no receipt to verify → fail closed
    const item = await openItemsService.getItem(id, ctx.clientNumber);
    if (!item || item.priority !== o.newPriority) return false;
    if (o.notifyUserId) {
      const notif = await prisma.notificationQueue.findFirst({
        where: {
          clientNumber: ctx.clientNumber,
          recipientId: o.notifyUserId,
          channel: 'in_app',
          // JSON path filter — the queue row execute() wrote carries the
          // escalated item's id inside its payload.
          payload: { path: ['openItemId'], equals: id },
        },
        select: { id: true },
      });
      if (!notif) return false;
    }
    return true;
  }

  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { previousPriority: string };
    return { handler: 'demote', payload: { openItemId: ctx.openItemId, targetPriority: o.previousPriority } };
  }
}
