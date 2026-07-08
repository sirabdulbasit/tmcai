import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import { getEvents } from '../../../adapters/calendarAdapter';

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
  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // Provider read-back: find the event on the user's calendar (now → +180
    // days; payload carries no event time and the adapter has no single-event
    // get) and require the added email to appear in its attendee list. Event
    // not found, attendee missing, or read error → false. NOTE: execute() is
    // currently a stub (no Calendar API write), so this returns false until
    // the real patch lands — intended fail-closed behaviour.
    const o = output as { eventId?: string; addedEmail?: string } | null | undefined;
    const eventId = o?.eventId;
    const email = o?.addedEmail;
    if (typeof eventId !== 'string' || eventId.length === 0) return false;
    if (typeof email !== 'string' || email.length === 0) return false;
    try {
      const now = new Date();
      const horizon = new Date(now.getTime() + 180 * 24 * 3600_000);
      const r = await getEvents(ctx.userId, now, horizon, 250);
      if (r.error) return false;
      const event = r.events.find(e => (e.id === eventId || e.id.startsWith(`${eventId}_`)) && e.status !== 'cancelled');
      if (!event) return false;
      return event.attendees.some(a => a.toLowerCase() === email.toLowerCase());
    } catch {
      return false;
    }
  }
  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { eventId: string; addedEmail: string };
    return { handler: 'remove_attendee', payload: { eventId: o.eventId, email: o.addedEmail } };
  }
}
