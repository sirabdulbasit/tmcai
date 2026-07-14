/**
 * Canonical view: today's calendar.
 *
 * The ONE place calendar events for "today's brief" come from. Web UI's
 * day-brief calendar tile, Brain Chat composer's calendar block,
 * WhatsApp Day Brief — all read through this function so the calendar
 * time on every surface is the same time in the same timezone.
 *
 * Per Basit 2026-05-20: web UI showed "Wed May 20 3pm-4pm (GMT+5)" for
 * the HR Kickoff meeting; Brain's WA brief said "10:00 Objective
 * Setting". Same event, 5-hour error. The Brain side rendered
 * toISOString() (UTC) and the LLM read the hour digits literally. Fixed
 * here: render in the user's configured timezone (default Asia/Karachi).
 */
import prisma from '../../db/prisma';
import { formatLocalDate, zonedDayBounds, systemDefaultTimezone } from '../userTimezoneService';

export interface CalendarEventRow {
  /** feed_event id, stable for cross-surface matching. */
  feedEventId: string;
  /** Event start in the user's timezone, formatted HH:MM (24h). */
  localTime: string;
  /** Event start as a Date (UTC instant) — kept for sorting / linking. */
  startUtc: Date;
  /** Event end as a Date (UTC instant). May be null for all-day events. */
  endUtc: Date | null;
  title: string;
  location: string | null;
  /** Attendee email addresses. May be empty. */
  attendees: string[];
  /** Whether this is an all-day event. */
  isAllDay: boolean;
}

export interface GetTodayCalendarOpts {
  /** IANA timezone for the "today" window and rendering localTime.
   *  Callers should pass the resolved per-user zone; falls back to the
   *  deployment default (systemDefaultTimezone). */
  timezone?: string;
  /** Hard cap on events returned. Default 50 — enough for any realistic
   *  single day. */
  limit?: number;
}

/** Today's [start, end) UTC instants in a given IANA timezone.
 *  Delegates to the shared DST-correct helper. The previous local
 *  implementation folded negative offsets through a (…)%(24*60) trick
 *  that landed a full day early for every zone west of UTC. */
function todayBoundsInZone(timezone: string): { startUtc: Date; endUtc: Date } {
  const today = formatLocalDate(timezone, new Date());
  const { fromUtc, toUtc } = zonedDayBounds(timezone, today);
  return { startUtc: fromUtc, endUtc: new Date(toUtc.getTime() + 1) };
}

/**
 * Returns today's calendar events for the user, in the user's local
 * timezone. `localTime` is formatted HH:MM in 24h, ready for display.
 *
 * Data source: feed_events with sourceType='gcal'. Calendar events are
 * stored as feed_events on ingest via the gcal poller — the same rows
 * the UI Day Brief tile reads.
 */
export async function getTodayCalendar(args: {
  clientNumber: string;
  userId: number;
  opts?: GetTodayCalendarOpts;
}): Promise<CalendarEventRow[]> {
  const { clientNumber, userId, opts } = args;
  const timezone = opts?.timezone || systemDefaultTimezone();
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 100);

  const { startUtc, endUtc } = todayBoundsInZone(timezone);

  // Pull a wider createdAt window than today so backfilled events
  // (gcal ingests up to 60d ahead) can match. The actual today-filter
  // runs in JS over rawPayload.start since JSONB indexing isn't set up.
  const rows = await prisma.feedEvent.findMany({
    where: {
      clientNumber, userId,
      sourceType: 'gcal' as any,
      createdAt: { gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
    },
    select: { id: true, rawPayload: true },
    take: 200,
  }).catch(() => [] as Array<{ id: string; rawPayload: unknown }>);

  const timeFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false,
  });

  const events: CalendarEventRow[] = [];
  for (const r of rows) {
    const p = (r.rawPayload as Record<string, unknown> | null) ?? {};
    const startObj = (p as any).start;
    const endObj = (p as any).end;
    const startIso = typeof startObj === 'string'
      ? startObj
      : (startObj?.dateTime ?? startObj?.date ?? null);
    const endIso = typeof endObj === 'string'
      ? endObj
      : (endObj?.dateTime ?? endObj?.date ?? null);
    if (!startIso) continue;
    const startDate = new Date(startIso);
    if (Number.isNaN(startDate.getTime())) continue;
    if (startDate < startUtc || startDate >= endUtc) continue;
    const endDate = endIso ? new Date(endIso) : null;
    const isAllDay = typeof startObj === 'object' && startObj && !startObj.dateTime && !!startObj.date;
    const attendeesRaw = Array.isArray((p as any).attendees) ? (p as any).attendees : [];
    const attendees = attendeesRaw
      .map((a: any) => (typeof a === 'string' ? a : a?.email))
      .filter((e: unknown): e is string => typeof e === 'string' && e.includes('@'));
    events.push({
      feedEventId: r.id,
      localTime: isAllDay ? 'all-day' : timeFmt.format(startDate),
      startUtc: startDate,
      endUtc: endDate && !Number.isNaN(endDate.getTime()) ? endDate : null,
      title: String((p as any).summary ?? (p as any).title ?? '(no title)').slice(0, 200),
      location: typeof (p as any).location === 'string' ? (p as any).location : null,
      attendees,
      isAllDay,
    });
  }
  events.sort((a, b) => a.startUtc.getTime() - b.startUtc.getTime());
  return events.slice(0, limit);
}
