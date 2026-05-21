/**
 * availabilityService — check the user's own calendar for conflicts
 * before Brain proposes a meeting time.
 *
 * Quality Sprint 5a (2026-05-21). Per third-party review #21 ("add
 * availability checking carefully"): scope to the USER's own calendar
 * only — attendee calendars require consent + cross-user permissions
 * we don't have. We warn but never silently move; the user decides.
 *
 * Single function: checkUserAvailability(userId, whenIso, durationMin)
 *   returns events that overlap the proposed window. Empty array
 *   means the slot is free.
 */
import { getEvents } from '../calendarService';
import { getUserTimezoneOffset } from '../userTimezoneService';

export interface ConflictEvent {
  id: string;
  title: string;
  start: string;
  end: string;
}

/** Check whether the user already has events overlapping the
 *  proposed window. Returns conflicting events (typically 0 or 1).
 *  Errors are swallowed — availability check is advisory, never
 *  blocks the user. */
export async function checkUserAvailability(
  userId: number,
  whenIso: string,
  durationMin: number,
): Promise<ConflictEvent[]> {
  if (!whenIso) return [];
  // Normalize naive whenIso to user's local offset so the resulting
  // Date represents the same instant we'll dispatch on. Mirrors the
  // dispatcher's normalizeWhenIsoToLocalTz logic.
  const offset = await getUserTimezoneOffset(userId).catch(() => '+05:00');
  let normalized = whenIso;
  if (!/[Zz]|[+-]\d{2}:?\d{2}$/.test(whenIso)) {
    if (/T\d{2}:\d{2}$/.test(whenIso)) normalized = whenIso + ':00';
    normalized = normalized + offset;
  }
  const start = new Date(normalized);
  if (Number.isNaN(start.getTime())) return [];
  const end = new Date(start.getTime() + Math.max(1, durationMin) * 60_000);
  // Pull events in a window that includes anything overlapping
  // [start, end] — i.e., events whose end > start and start < end.
  // Google's freebusy or events.list with timeMin/timeMax handles this.
  const dayPad = 0; // events.list filters by start range; broaden by ±30 min to catch boundary cases
  const windowStart = new Date(start.getTime() - 30 * 60_000);
  const windowEnd = new Date(end.getTime() + 30 * 60_000);
  const r = await getEvents(userId, windowStart, windowEnd, 20).catch(() => null);
  if (!r || !r.events) return [];
  const conflicts: ConflictEvent[] = [];
  for (const e of r.events) {
    if (!e.start || !e.end) continue;
    const eStart = new Date(e.start).getTime();
    const eEnd = new Date(e.end).getTime();
    if (Number.isNaN(eStart) || Number.isNaN(eEnd)) continue;
    // Overlap iff eStart < end AND eEnd > start.
    if (eStart < end.getTime() && eEnd > start.getTime()) {
      conflicts.push({
        id: e.id ?? '',
        title: e.title ?? '(no title)',
        start: e.start,
        end: e.end,
      });
    }
  }
  return conflicts;
}
