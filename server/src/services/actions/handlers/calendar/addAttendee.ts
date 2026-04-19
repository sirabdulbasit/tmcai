import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';

export class AddAttendeeHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'add_attendee', category: 'calendar', description: 'Add a person to an existing event', version: '1.0', requiresConnector: 'google_calendar' };
  }
  schema() {
    return {
      type: 'object',
      required: ['eventId', 'email'],
      properties: { eventId: { type: 'string' }, email: { type: 'string', format: 'email' }, optional: { type: 'boolean' } },
    };
  }
  auditFields() { return ['eventId', 'email']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.payload.eventId) errors.push('eventId required');
    if (!ctx.payload.email) errors.push('email required');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return { wouldSucceed: v.valid, preview: { eventId: ctx.payload.eventId, email: ctx.payload.email }, warnings: v.errors };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    return { ok: true, output: { eventId: ctx.payload.eventId, addedEmail: ctx.payload.email, at: new Date().toISOString() } };
  }
  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { eventId: string; addedEmail: string };
    return { handler: 'remove_attendee', payload: { eventId: o.eventId, email: o.addedEmail } };
  }
}
