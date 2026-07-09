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
    // Was a STUB (fabricated receipt, added nobody) until 2026-07-09 —
    // exposed when B2's confirm() started failing it (F1 gap-fill, same
    // class as cancel_event). There is no attendee-append primitive in
    // calendarService — updateEvent's `attendees` patch is a FULL
    // REPLACEMENT of the list — so a blind write would silently drop every
    // existing attendee. Hence read-modify-write: fetch the live event via
    // the adapter, append the email, patch back the whole list.
    const eventId = String(ctx.payload.eventId);
    const email = String(ctx.payload.email);
    try {
      // Scan now → +180 days: the payload carries no event time and the
      // adapter has no single-event get (same window confirm() uses below).
      const now = new Date();
      const horizon = new Date(now.getTime() + 180 * 24 * 3600_000);
      const r = await getEvents(ctx.userId, now, horizon, 250);
      if (r.error) return { ok: false, error: r.error };
      const event = r.events.find(e => (e.id === eventId || e.id.startsWith(`${eventId}_`)) && e.status !== 'cancelled');
      // Fail closed rather than write blind: patching an event we cannot see
      // would clobber an attendee list we never read.
      if (!event) return { ok: false, error: `event ${eventId} not found on calendar (next 180 days)` };
      // Idempotent: already invited → success without a provider write (a
      // duplicate patch would re-send invites to everyone via sendUpdates).
      if (event.attendees.some(a => a.toLowerCase() === email.toLowerCase())) {
        return { ok: true, output: { eventId, addedEmail: email, alreadyPresent: true, at: new Date().toISOString() } };
      }
      const { updateEvent } = await import('../../../calendarService');
      // Patch the REAL provider id (event.id — may carry a recurrence
      // suffix), not the caller-supplied prefix.
      const u = await updateEvent(ctx.userId, event.id, { attendees: [...event.attendees, email] });
      if (u.error || !u.event) return { ok: false, error: u.error ?? 'calendar update returned no event' };
      return { ok: true, output: { eventId, addedEmail: email, at: new Date().toISOString() } };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }
  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // Provider read-back: find the event on the user's calendar (now → +180
    // days; payload carries no event time and the adapter has no single-event
    // get) and require the added email to appear in its attendee list. Event
    // not found, attendee missing, or read error → false. execute() above
    // performs the real Calendar API patch; this verifies it stuck.
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
