/**
 * The time zone the host application works in.
 *
 * Periods ("has this month ended?"), schedules and every time shown to a person
 * are read in ONE zone, set once by the host at start-up. A server running in
 * UTC would otherwise file a run at 02:00 local time on the 1st into the
 * previous month.
 */
let zone = process.env.AI_INTEGRATION_TIME_ZONE || 'UTC';

/** Set the IANA time zone (e.g. 'Asia/Karachi', 'Europe/London'). Call once at start-up. */
export const setTimeZone = (tz: string): void => {
  // Throws RangeError for an unknown zone — better at boot than at the first run.
  new Intl.DateTimeFormat('en-GB', { timeZone: tz });
  zone = tz;
};

export const getTimeZone = (): string => zone;

export interface ZonedParts { year: number; month: number; day: number; hour: number; minute: number; weekday: number }

/** The calendar fields of an instant, in the configured zone. */
export const zonedParts = (at: Date): ZonedParts => {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hourCycle: 'h23', weekday: 'short',
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(at)) p[x.type] = x.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday ?? '');
  return { year: +p.year!, month: +p.month!, day: +p.day!, hour: +p.hour!, minute: +p.minute!, weekday: wd };
};

/** "14:05:09" in the configured zone — for job progress shown to a person. */
export const clockTime = (at: Date): string => new Intl.DateTimeFormat('en-GB', {
  timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(at);
