import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata, ConfirmationCapability } from '../../handlerBase';
import { findEventById } from '../../../adapters/calendarAdapter';

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
    // Was a STUB (fabricated receipt, moved nothing) until 2026-07-09 —
    // exposed when B2's confirm() started failing it (F1 gap-fill, same
    // class as cancel_event). Real provider patch now. Payload times arrive
    // as ISO strings WITH offset (registry payloads are normalized upstream;
    // contrast instructionDispatcher's reschedule_meeting case, which must
    // normalize raw voice-parsed times itself) — so we pass them through
    // untouched rather than re-normalizing and double-shifting the event.
    const eventId = String(ctx.payload.eventId);
    const newStart = String(ctx.payload.newStartTime);
    const newEnd = String(ctx.payload.newEndTime);
    try {
      // Best-effort capture of the CURRENT start before we overwrite it —
      // undo() below is useless without it (the stub always returned null,
      // forcing undo to give up). A failed read must not block the move, so
      // any error here degrades to previousStart:null. Scan now → +180 days:
      // the payload carries no event time and the adapter has no
      // single-event get.
      let previousStart: string | null = null;
      try {
        // Fix 5 dedupe — helper handles the 180d default window and
        // recurrence-suffix matching.
        const pre = await findEventById(ctx.userId, eventId);
        if (!pre.error && pre.event) previousStart = pre.event.start;
      } catch { /* read-before-write is best-effort only */ }

      const { updateEvent } = await import('../../../calendarService');
      const r = await updateEvent(ctx.userId, eventId, { startTime: newStart, endTime: newEnd });
      if (r.error || !r.event) return { ok: false, error: r.error ?? 'calendar update returned no event' };
      return { ok: true, output: { eventId, previousStart, newStart, newEnd } };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }
  confirmationCapability(): ConfirmationCapability {
    return 'provider_confirmed'; // confirm() reads back from the provider / delivery log
  }

  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // Provider read-back: the event must exist at the NEW time window with a
    // non-cancelled status. execute() above performs the real Calendar API
    // patch; this verifies the move actually stuck on the provider side.
    const o = output as { eventId?: string; newStart?: string; newEnd?: string } | null | undefined;
    if (!o || typeof o.eventId !== 'string' || o.eventId.length === 0) return false;
    const eventId = o.eventId;
    try {
      const newStart = new Date(String(o.newStart));
      const newEnd = new Date(String(o.newEnd));
      if (isNaN(newStart.getTime()) || isNaN(newEnd.getTime())) return false;
      // Fix 5 dedupe — narrow ±60s window keeps the API call cheap
      // and hits recurrence instances near the new time.
      const r = await findEventById(ctx.userId, eventId, {
        start: new Date(newStart.getTime() - 60_000),
        end: new Date(newEnd.getTime() + 60_000),
      });
      if (r.error || !r.event) return false;
      // Start must actually be the new start (±60s tolerance for formatting).
      const start = new Date(r.event.start).getTime();
      return Math.abs(start - newStart.getTime()) <= 60_000;
    } catch {
      return false;
    }
  }
  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { eventId: string; previousStart: string | null };
    if (!o.previousStart) {
      return { handler: 'reschedule_event', payload: { eventId: o.eventId }, note: 'cannot revert — previous start could not be read before the move' };
    }
    return { handler: 'reschedule_event', payload: { eventId: o.eventId, newStartTime: o.previousStart } };
  }
}
