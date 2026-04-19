import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';

export class RescheduleEventHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'reschedule_event', category: 'calendar', description: 'Move an existing calendar event to a new time window', version: '1.0', requiresConnector: 'google_calendar' };
  }
  schema() {
    return {
      type: 'object',
      required: ['eventId', 'newStartTime', 'newEndTime'],
      properties: {
        eventId: { type: 'string' },
        newStartTime: { type: 'string', format: 'date-time' },
        newEndTime: { type: 'string', format: 'date-time' },
        reason: { type: 'string' },
      },
    };
  }
  auditFields() { return ['eventId', 'previousStart', 'newStart']; }
  riskLevel() { return 'MEDIUM' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.payload.eventId) errors.push('eventId required');
    if (!ctx.payload.newStartTime) errors.push('newStartTime required');
    if (!ctx.payload.newEndTime) errors.push('newEndTime required');
    if (ctx.payload.newStartTime && ctx.payload.newEndTime && new Date(ctx.payload.newStartTime as string) >= new Date(ctx.payload.newEndTime as string)) {
      errors.push('newStartTime must be before newEndTime');
    }
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return { wouldSucceed: v.valid, preview: { eventId: ctx.payload.eventId, newStartTime: ctx.payload.newStartTime, newEndTime: ctx.payload.newEndTime }, warnings: v.errors };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    return { ok: true, output: { eventId: ctx.payload.eventId, previousStart: null, newStart: ctx.payload.newStartTime, newEnd: ctx.payload.newEndTime } };
  }
  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { eventId: string; previousStart: string | null };
    if (!o.previousStart) {
      return { handler: 'reschedule_event', payload: { eventId: o.eventId }, note: 'cannot revert — previous start not captured by stub execute' };
    }
    return { handler: 'reschedule_event', payload: { eventId: o.eventId, newStartTime: o.previousStart } };
  }
}
