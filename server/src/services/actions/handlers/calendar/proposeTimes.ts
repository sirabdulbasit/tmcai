import {ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, HandlerMetadata, ConfirmationCapability } from '../../handlerBase';
import { getEvents } from '../../../adapters/calendarAdapter';

// Working-hours window for proposals (local server time), matching the
// convention already established by calendarService.findFreeTime (9 AM–6 PM).
const WORK_START_HOUR = 9;
const WORK_END_HOUR = 18;
// Proposals snap to :00/:30 boundaries — humans schedule on the half hour.
const SLOT_ALIGN_MS = 30 * 60_000;
// Hard cap on the day-scan so a pathological rangeEnd can't spin the loop.
const MAX_SCAN_DAYS = 62;

/** Ceil a timestamp to the next LOCAL :00/:30 boundary (identity if already
 *  aligned). Local-time arithmetic, not epoch rounding, so half-hour
 *  timezone offsets don't skew the boundaries. */
function alignUpToHalfHour(t: number): number {
  const d = new Date(t);
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil(d.getMinutes() / 30) * 30);
  let ms = d.getTime();
  if (ms < t) ms += SLOT_ALIGN_MS; // seconds/millis were truncated below t
  return ms;
}

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
    // Was a STUB (fabricated "tomorrow / day after / day after that" slots
    // with NO free/busy check — could propose times the user is provably
    // busy) until 2026-07-09 (F1 gap-fill, same class as cancel_event).
    // Real availability now: read the user's calendar over the requested
    // window and propose only genuinely-free slots. Pure read + deterministic
    // computation — no provider write, so confirm() below stays a
    // shape-check of this output.
    const max = (ctx.payload.maxSuggestions as number | undefined) ?? 3;
    const durationMs = (ctx.payload.durationMinutes as number) * 60_000;
    const now = Date.now();
    // Payload hints win; default window is the next 7 days.
    const windowStart = ctx.payload.rangeStart ? new Date(String(ctx.payload.rangeStart)) : new Date(now);
    const windowEnd = ctx.payload.rangeEnd ? new Date(String(ctx.payload.rangeEnd)) : new Date(windowStart.getTime() + 7 * 24 * 3600_000);
    if (isNaN(windowStart.getTime()) || isNaN(windowEnd.getTime()) || windowStart >= windowEnd) {
      return { ok: false, error: 'invalid rangeStart/rangeEnd window' };
    }
    try {
      const r = await getEvents(ctx.userId, windowStart, windowEnd, 250);
      if (r.error) return { ok: false, error: r.error };
      // Busy = timed, non-cancelled events. All-day entries (birthdays,
      // OOO banners) are excluded — treating them as busy would blank out
      // whole days for events that don't actually occupy time.
      const busy = r.events
        .filter(e => e.status !== 'cancelled' && !e.isAllDay)
        .map(e => ({ start: new Date(e.start).getTime(), end: new Date(e.end).getTime() }))
        .filter(b => !isNaN(b.start) && !isNaN(b.end))
        .sort((a, b) => a.start - b.start);

      const suggestions: { start: string; end: string }[] = [];
      const windowEndMs = windowEnd.getTime();
      for (let d = 0; d < MAX_SCAN_DAYS && suggestions.length < max; d++) {
        // Clamp each scanned day to working hours (local server time).
        const dayStart = new Date(windowStart.getFullYear(), windowStart.getMonth(), windowStart.getDate() + d, WORK_START_HOUR, 0);
        const dayEnd = new Date(windowStart.getFullYear(), windowStart.getMonth(), windowStart.getDate() + d, WORK_END_HOUR, 0);
        if (dayStart.getTime() > windowEndMs) break;
        // Never propose the past: cursor starts at the latest of workday
        // start, requested window start, and now.
        let cursor = alignUpToHalfHour(Math.max(dayStart.getTime(), windowStart.getTime(), now));
        const limit = Math.min(dayEnd.getTime(), windowEndMs);
        while (cursor + durationMs <= limit && suggestions.length < max) {
          const conflict = busy.find(b => b.start < cursor + durationMs && b.end > cursor);
          if (conflict) {
            // Jump past the blocking event and re-align, rather than
            // creeping forward in fixed steps.
            cursor = alignUpToHalfHour(conflict.end);
            continue;
          }
          suggestions.push({ start: new Date(cursor).toISOString(), end: new Date(cursor + durationMs).toISOString() });
          // Advance by the full duration so proposals never overlap each other.
          cursor = alignUpToHalfHour(cursor + durationMs);
        }
      }
      // Fail closed on an empty result: "propose times" with zero times is
      // not a success, and confirm() would (rightly) reject it anyway.
      if (suggestions.length === 0) {
        return { ok: false, error: `no free ${ctx.payload.durationMinutes}-minute slots found between ${windowStart.toISOString()} and ${windowEnd.toISOString()}` };
      }
      return { ok: true, output: { suggestions, generatedAt: new Date().toISOString() } };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }
  confirmationCapability(): ConfirmationCapability {
    // Pure computation — no external write happens, so the produced
    // proposal itself is the system of record. Declared explicitly so
    // the external-category parity test doesn't read this as relying
    // on the inherited default.
    return 'locally_confirmed';
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
