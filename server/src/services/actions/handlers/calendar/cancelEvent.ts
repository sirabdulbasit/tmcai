import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';

export class CancelEventHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'cancel_event', category: 'calendar', description: 'Cancel an existing event and notify attendees', version: '1.0', requiresConnector: 'google_calendar' };
  }
  schema() {
    return {
      type: 'object',
      required: ['eventId'],
      properties: {
        eventId: { type: 'string' },
        notifyAttendees: { type: 'boolean', default: true },
        reason: { type: 'string' },
      },
    };
  }
  auditFields() { return ['eventId', 'notifyAttendees']; }
  riskLevel() { return 'MEDIUM' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    if (!ctx.payload.eventId) return { valid: false, errors: ['eventId required'] };
    return { valid: true };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    return { wouldSucceed: true, preview: { eventId: ctx.payload.eventId, notifyAttendees: ctx.payload.notifyAttendees !== false } };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    return { ok: true, output: { eventId: ctx.payload.eventId, cancelledAt: new Date().toISOString() } };
  }
  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { eventId: string };
    return { handler: 'create_event', payload: { restoreFromEventId: o.eventId }, note: 'must recreate event; cancellation typically destroys attendees list' };
  }
}
