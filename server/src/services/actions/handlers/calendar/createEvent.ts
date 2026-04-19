import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import { createEvent as createEventBreakered } from '../../../adapters/calendarAdapter';

export class CreateEventHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return {
      name: 'create_event',
      category: 'calendar',
      description: 'Book a new calendar event with attendees',
      version: '1.0',
      requiresConnector: 'google_calendar',
    };
  }
  schema() {
    return {
      type: 'object',
      required: ['summary', 'startTime', 'endTime'],
      properties: {
        summary: { type: 'string' },
        startTime: { type: 'string', format: 'date-time' },
        endTime: { type: 'string', format: 'date-time' },
        attendees: { type: 'array', items: { type: 'string', format: 'email' } },
        description: { type: 'string' },
        location: { type: 'string' },
      },
    };
  }
  auditFields() { return ['eventId', 'summary', 'startTime', 'endTime', 'attendees']; }
  riskLevel() { return 'MEDIUM' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.payload.summary) errors.push('summary required');
    if (!ctx.payload.startTime) errors.push('startTime required');
    if (!ctx.payload.endTime) errors.push('endTime required');
    if (ctx.payload.startTime && ctx.payload.endTime) {
      if (new Date(ctx.payload.startTime as string) >= new Date(ctx.payload.endTime as string)) {
        errors.push('startTime must be before endTime');
      }
    }
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return {
      wouldSucceed: v.valid,
      preview: {
        summary: ctx.payload.summary,
        startTime: ctx.payload.startTime,
        endTime: ctx.payload.endTime,
        attendees: ctx.payload.attendees ?? [],
      },
      warnings: v.errors,
    };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    try {
      const r = await createEventBreakered(ctx.userId, {
        title: String(ctx.payload.summary),
        description: (ctx.payload.description as string) ?? undefined,
        location: (ctx.payload.location as string) ?? undefined,
        startTime: String(ctx.payload.startTime),
        endTime: String(ctx.payload.endTime),
        attendees: (ctx.payload.attendees as string[]) ?? undefined,
      });
      if (r.error || !r.event?.id) {
        return { ok: false, error: r.error ?? 'calendar create returned no event id' };
      }
      return { ok: true, output: { eventId: r.event.id, htmlLink: (r.event as any).htmlLink, createdAt: new Date().toISOString() } };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }
  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { eventId: string };
    return { handler: 'cancel_event', payload: { eventId: o.eventId }, note: 'cancel the event + notify attendees' };
  }
}
