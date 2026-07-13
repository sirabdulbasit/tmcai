import { getEvents, type CalendarEvent } from './calendarService';

/**
 * findEventById — dedupes 6 handler-local scans (Fix 5, 2026-07-09).
 *
 * Six handlers (cancelEvent, rescheduleEvent×2, addAttendee×2,
 * createEvent) each hand-rolled the same pattern: getEvents(now→+180d,
 * 250) then find(e => e.id === id || e.id.startsWith(`${id}_`))
 * filtered by status !== 'cancelled'. The Google Calendar adapter
 * has no single-event get, so scan-and-match is the mechanism — but
 * six copies drift (each subtly different window / cancellation
 * handling), and a bug in one has to be found five more times.
 *
 * Callers pass an explicit window when the event's rough time is
 * known (createEvent.confirm, rescheduleEvent.confirm — narrow ±1
 * min around the new start); otherwise the default matches the
 * copies (now → +180 days, maxResults 250).
 *
 * The `_` id-suffix match is Google Calendar's recurrence-instance
 * convention: a recurring event's occurrences carry ids of shape
 * `<masterId>_<yyyymmddThhmmssZ>`. Matching that prefix ensures
 * scheduling ops against a recurrence master still hit the concrete
 * instance the caller cared about.
 *
 * Return shape:
 *   `event`    — first non-cancelled id match (or null).
 *   `anyMatch` — first id match regardless of status (or null).
 * cancelEvent.confirm uses `!event` to assert absence-OR-cancelled
 * ("the cancellation stuck"). Other callers use `event` as their
 * live handle; `anyMatch` is available for observers that want to
 * distinguish "never existed" from "was cancelled".
 *
 * Lives OUTSIDE calendarService.ts on purpose: keeping it in a
 * separate module means test mocks of getEvents intercept correctly
 * (a same-file getEvents call would use the local reference, not
 * the mocked export).
 */
export async function findEventById(
  userId: number,
  eventId: string,
  window?: { start: Date; end: Date },
): Promise<{ event: CalendarEvent | null; anyMatch: CalendarEvent | null; error?: string }> {
  const start = window?.start ?? new Date();
  const end = window?.end ?? new Date(start.getTime() + 180 * 24 * 3600_000);
  // Narrow-window callers know the event's rough time — cap results
  // low to keep the API call cheap. The 180-day default needs the
  // wider bucket because we can't pre-filter by time.
  const maxResults = window ? 50 : 250;
  const r = await getEvents(userId, start, end, maxResults);
  if (r.error) return { event: null, anyMatch: null, error: r.error };
  const matchesId = (e: CalendarEvent) => e.id === eventId || e.id.startsWith(`${eventId}_`);
  const anyMatch = r.events.find(matchesId) ?? null;
  const event = r.events.find((e) => matchesId(e) && e.status !== 'cancelled') ?? null;
  return { event, anyMatch };
}
