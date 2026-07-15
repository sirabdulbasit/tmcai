import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata, ConfirmationCapability } from '../../handlerBase';
import { findEventById } from '../../../adapters/calendarAdapter';

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
    // Was a STUB (fabricated receipt, deleted nothing) until 2026-07-08 —
    // exposed when B2's confirm() started failing it and B5 routed voice
    // cancel_meeting here. Real provider call now; confirm() below verifies
    // the event is actually gone.
    try {
      const { deleteEvent } = await import('../../../calendarService');
      const r = await deleteEvent(ctx.userId, String(ctx.payload.eventId));
      if (!r.success) return { ok: false, error: r.error ?? 'calendar delete failed' };
      return { ok: true, output: { eventId: ctx.payload.eventId, cancelledAt: new Date().toISOString() } };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }
  confirmationCapability(): ConfirmationCapability {
    return 'provider_confirmed'; // confirm() reads back from the provider / delivery log
  }

  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // Provider read-back where ABSENCE is the success state: scan the user's
    // calendar (now → +180 days; the payload carries no event time, and there
    // is no single-event get in the adapter) and confirm the event is either
    // gone or status=cancelled. Finding it still live means the cancellation
    // did not stick → false. A read error means we cannot verify → false.
    const o = output as { eventId?: string } | null | undefined;
    const eventId = o?.eventId ?? (ctx.payload.eventId as string | undefined);
    if (typeof eventId !== 'string' || eventId.length === 0) return false;
    try {
      // Fix 5 dedupe — cancellation stuck iff no LIVE match exists
      // (helper's `event` excludes cancelled rows; `anyMatch` would
      // still surface the cancelled row for observers).
      const r = await findEventById(ctx.userId, eventId);
      if (r.error) return false;
      return r.event === null;
    } catch {
      return false;
    }
  }
  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { eventId: string };
    return { handler: 'create_event', payload: { restoreFromEventId: o.eventId }, note: 'must recreate event; cancellation typically destroys attendees list' };
  }
}
