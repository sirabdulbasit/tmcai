import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import { getEvents } from '../../../adapters/calendarAdapter';

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
  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // Provider read-back: the event must exist at the NEW time window with a
    // non-cancelled status. NOTE: execute() is currently a stub (no Calendar
    // API write), so this read-back will return false until the real move
    // lands — that is the intended fail-closed behaviour, not a bug.
    const o = output as { eventId?: string; newStart?: string; newEnd?: string } | null | undefined;
    if (!o || typeof o.eventId !== 'string' || o.eventId.length === 0) return false;
    const eventId = o.eventId;
    try {
      const newStart = new Date(String(o.newStart));
      const newEnd = new Date(String(o.newEnd));
      if (isNaN(newStart.getTime()) || isNaN(newEnd.getTime())) return false;
      const r = await getEvents(ctx.userId, new Date(newStart.getTime() - 60_000), new Date(newEnd.getTime() + 60_000), 50);
      if (r.error) return false;
      return r.events.some(e => {
        if (e.id !== eventId && !e.id.startsWith(`${eventId}_`)) return false;
        if (e.status === 'cancelled') return false;
        // Start must actually be the new start (±60s tolerance for formatting)
        const start = new Date(e.start).getTime();
        return Math.abs(start - newStart.getTime()) <= 60_000;
      });
    } catch {
      return false;
    }
  }
  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { eventId: string; previousStart: string | null };
    if (!o.previousStart) {
      return { handler: 'reschedule_event', payload: { eventId: o.eventId }, note: 'cannot revert — previous start not captured by stub execute' };
    }
    return { handler: 'reschedule_event', payload: { eventId: o.eventId, newStartTime: o.previousStart } };
  }
}
