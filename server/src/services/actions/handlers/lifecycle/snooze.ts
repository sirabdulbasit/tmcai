import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import * as openItemsService from '../../../openItemsService';
import prisma from '../../../../db/prisma';

export class SnoozeHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return {
      name: 'snooze',
      category: 'lifecycle',
      description: 'Defer an open item until a future date',
      version: '1.0',
    };
  }

  schema() {
    return {
      type: 'object',
      required: ['snoozeUntil'],
      properties: {
        snoozeUntil: { type: 'string', format: 'date-time' },
      },
    };
  }

  auditFields() {
    return ['openItemId', 'snoozeUntil'];
  }

  riskLevel() {
    return 'LOW' as const;
  }

  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.openItemId) errors.push('openItemId required');
    const snoozeUntil = ctx.payload.snoozeUntil;
    if (!snoozeUntil || typeof snoozeUntil !== 'string') {
      errors.push('snoozeUntil (ISO datetime) required');
    } else if (new Date(snoozeUntil) <= new Date()) {
      errors.push('snoozeUntil must be in the future');
    }
    return { valid: errors.length === 0, errors };
  }

  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return {
      wouldSucceed: v.valid,
      preview: { openItemId: ctx.openItemId, snoozeUntil: ctx.payload.snoozeUntil, newStatus: 'open', newDueDate: ctx.payload.snoozeUntil },
      warnings: v.errors,
    };
  }

  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const snoozeUntil = new Date(ctx.payload.snoozeUntil as string);
    const previous = await openItemsService.getItem(ctx.openItemId!, ctx.clientNumber);
    if (!previous) return { ok: false, error: 'open item not found' };

    // v15 L2 — transition to SNOOZED; lifecycleService guards require snooze_until.
    const { transitionStatus } = await import('../../../itemLifecycle/lifecycleService');
    const r = await transitionStatus(ctx.openItemId!, 'SNOOZED', {
      clientNumber: ctx.clientNumber,
      actor: ctx.executedByAgent ? `agent:${ctx.executedByAgent}` : `user:${ctx.userId}`,
      reason: 'snoozed via action handler',
      snoozeUntil,
      traceId: ctx.traceId,
    });
    if (!r.ok) return { ok: false, error: r.error ?? 'snooze transition rejected' };
    await prisma.openItem.update({
      where: { id: ctx.openItemId! },
      data: {
        dueDate: snoozeUntil,
        metadata: { snoozedAt: new Date().toISOString(), snoozedBy: ctx.userId } as any,
      },
    });

    return {
      ok: true,
      output: {
        openItemId: ctx.openItemId,
        snoozeUntil: snoozeUntil.toISOString(),
        previousStatus: previous.status,
        previousDueDate: previous.dueDate?.toISOString() ?? null,
      },
    };
  }

  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // Read-back (B2): the OpenItem row IS the system of record here.
    // execute() makes TWO separate writes (status via lifecycleService,
    // then dueDate via a plain update) — so status alone is not proof the
    // snooze fully landed; assert both. Missing row / drift → fail closed.
    const o = output as { openItemId?: string; snoozeUntil?: string } | null;
    const id = o?.openItemId ?? ctx.openItemId;
    if (!id || !o?.snoozeUntil) return false; // no receipt to verify → fail closed
    const row = await prisma.openItem.findFirst({
      where: { id, clientNumber: ctx.clientNumber },
      select: { status: true, dueDate: true },
    });
    if (!row) return false;
    return row.status === 'SNOOZED' && row.dueDate?.getTime() === new Date(o.snoozeUntil).getTime();
  }

  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { previousStatus: string; previousDueDate: string | null };
    return {
      handler: 'snooze.revert',
      payload: {
        openItemId: ctx.openItemId,
        restoreStatus: o.previousStatus,
        restoreDueDate: o.previousDueDate,
      },
      note: 'restore prior status and due date',
    };
  }
}
