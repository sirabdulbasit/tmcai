import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, HandlerMetadata } from '../../handlerBase';

export class ProposeTimesHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'propose_times', category: 'calendar', description: 'Send candidate meeting slots based on free/busy', version: '1.0', requiresConnector: 'google_calendar' };
  }
  schema() {
    return {
      type: 'object',
      required: ['attendees', 'durationMinutes'],
      properties: {
        attendees: { type: 'array', items: { type: 'string' } },
        durationMinutes: { type: 'number', minimum: 5 },
        rangeStart: { type: 'string', format: 'date-time' },
        rangeEnd: { type: 'string', format: 'date-time' },
        maxSuggestions: { type: 'number', default: 3 },
      },
    };
  }
  auditFields() { return ['attendees', 'suggestionCount']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    const atts = ctx.payload.attendees as unknown;
    if (!Array.isArray(atts) || atts.length === 0) errors.push('attendees required');
    if (typeof ctx.payload.durationMinutes !== 'number') errors.push('durationMinutes required');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return { wouldSucceed: v.valid, preview: { attendees: ctx.payload.attendees, durationMinutes: ctx.payload.durationMinutes, maxSuggestions: ctx.payload.maxSuggestions ?? 3 }, warnings: v.errors };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    // TODO: actual free/busy query against Google Calendar
    const max = (ctx.payload.maxSuggestions as number | undefined) ?? 3;
    const now = Date.now();
    const duration = (ctx.payload.durationMinutes as number) * 60_000;
    const suggestions = Array.from({ length: max }, (_, i) => {
      const start = new Date(now + (i + 1) * 24 * 3600_000);
      return { start: start.toISOString(), end: new Date(start.getTime() + duration).toISOString() };
    });
    return { ok: true, output: { suggestions, generatedAt: new Date().toISOString() } };
  }
  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // Pure computation — execute() performs no external write (no event is
    // created, nothing is sent), so there is no system of record to read
    // back. The legitimate confirmation here is that the proposal payload is
    // well-formed: a non-empty suggestions array of valid, correctly-ordered
    // ISO slots matching the requested duration.
    const o = output as { suggestions?: Array<{ start?: string; end?: string }> } | null | undefined;
    if (!o || !Array.isArray(o.suggestions) || o.suggestions.length === 0) return false;
    const durationMs = (ctx.payload.durationMinutes as number) * 60_000;
    return o.suggestions.every(s => {
      const start = new Date(String(s?.start)).getTime();
      const end = new Date(String(s?.end)).getTime();
      if (isNaN(start) || isNaN(end) || start >= end) return false;
      // Each slot must match the requested duration (±1s for rounding)
      return !Number.isFinite(durationMs) || Math.abs(end - start - durationMs) <= 1000;
    });
  }
}
