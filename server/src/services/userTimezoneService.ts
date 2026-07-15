/**
 * userTimezoneService — per-user timezone lookups and offset
 * computation. Sprint 4A (2026-05-21).
 *
 * Replaces the hardcoded Asia/Karachi (+05:00) that worked for the
 * single-tenant pilot but breaks on first non-PKT user. Reads from
 * User.timezone (IANA name); falls back to 'Asia/Karachi' for
 * existing rows where the column hasn't been set.
 *
 * Two public helpers:
 *   getUserTimezone(userId)   → IANA name string
 *   getUserTimezoneOffset(userId, asOfDate?) → "+HH:MM" string
 *
 * The offset is recomputed per-date because DST regions like
 * America/New_York shift between +HH offsets across the year.
 * For non-DST zones (Asia/Karachi, Asia/Tokyo) the offset is
 * constant year-round.
 *
 * Cached for 5 minutes via Redis to avoid hot-path DB hits.
 */
import prisma from '../db/prisma';
import createLogger from '../utils/logger';

const log = createLogger('user-timezone');

/** Operator default for legacy rows — matches the schema default on
 *  User.timezone, so behavior is unchanged for existing users. Override
 *  per deployment with NEXEO_DEFAULT_TIMEZONE. */
const DEFAULT_TZ = 'Asia/Karachi';
const TZ_CACHE_TTL_SEC = 300;

/** True when Intl recognises the IANA zone name. */
export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; }
  catch { return false; }
}

/** Deployment-wide default zone: NEXEO_DEFAULT_TIMEZONE if valid, else
 *  the documented operator default. */
export function systemDefaultTimezone(): string {
  const envTz = process.env.NEXEO_DEFAULT_TIMEZONE;
  if (envTz) {
    if (isValidTimezone(envTz)) return envTz;
    log.warn('NEXEO_DEFAULT_TIMEZONE is not a valid IANA zone — ignoring', { envTz });
  }
  return DEFAULT_TZ;
}

/** Walk candidates in priority order (user → tenant → system default),
 *  take the first VALID one, warn on any set-but-invalid value, and
 *  fall back to UTC if nothing survives. Pure — exported for tests. */
export function pickTimezone(
  candidates: Array<{ source: string; tz: string | null | undefined }>,
): { tz: string; source: string } {
  for (const c of candidates) {
    if (!c.tz) continue;
    if (isValidTimezone(c.tz)) return { tz: c.tz, source: c.source };
    log.warn('invalid IANA timezone configured — skipping', { source: c.source, tz: c.tz });
  }
  return { tz: 'UTC', source: 'fallback_utc' };
}

/** Resolve the effective timezone for a user:
 *  EXPLICIT User.timezone → tenant config 'tenant_timezone' → system
 *  default → UTC. Invalid values at any level are skipped with a
 *  warning, never used.
 *
 *  #13 (2026-07-14): the old User.timezone column DEFAULT made every
 *  legacy row look user-chosen, which silently blocked tenant fallback
 *  forever. Semantics now: the user's zone participates ONLY when
 *  timezone_is_explicit = true (set by the profile write path). Legacy
 *  rows (explicit=false) inherit tenant → system — which today is the
 *  same Asia/Karachi they had, so no existing schedule changes. */
export async function resolveUserTimezone(userId: number): Promise<string> {
  try {
    const { getOrCompute } = await import('../utils/redisClient');
    return await getOrCompute(`usertz:${userId}`, TZ_CACHE_TTL_SEC, async () => {
      const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { timezone: true, clientNumber: true, timezoneIsExplicit: true } as any,
      }) as any;
      let tenantTz: string | null = null;
      if (row?.clientNumber) {
        const { getConfig } = await import('./configService');
        tenantTz = await getConfig(row.clientNumber, 'tenant_timezone').catch(() => null);
      }
      return pickTimezone([
        { source: 'user', tz: row?.timezoneIsExplicit ? row?.timezone : null },
        { source: 'tenant', tz: tenantTz },
        { source: 'system', tz: systemDefaultTimezone() },
      ]).tz;
    });
  } catch {
    return systemDefaultTimezone();
  }
}

/** Persist an EXPLICIT user timezone selection (profile/settings write
 *  path). Only this setter makes User.timezone participate in
 *  resolution. Invalid names are rejected, not stored. */
export async function setUserTimezone(userId: number, tz: string): Promise<boolean> {
  if (!isValidTimezone(tz)) {
    log.warn('rejected invalid timezone selection', { userId, tz });
    return false;
  }
  await prisma.user.update({
    where: { id: userId },
    data: { timezone: tz, timezoneIsExplicit: true } as any,
  });
  try {
    const { del } = await import('../utils/redisClient') as any;
    if (typeof del === 'function') await del(`usertz:${userId}`);
  } catch { /* 5-min TTL bounds staleness */ }
  return true;
}

/** Look up a user's IANA timezone (back-compat name — now the full
 *  user → tenant → system → UTC resolver). */
export async function getUserTimezone(userId: number): Promise<string> {
  return resolveUserTimezone(userId);
}

/** Compute the timezone offset for a given IANA zone as a string
 *  like "+05:00" or "-04:00". Date-aware so DST shifts produce the
 *  correct offset on the date in question.
 *
 *  Uses Intl.DateTimeFormat with timeZoneName: 'longOffset' which
 *  yields strings like "GMT+05:00". We parse out the numeric part. */
export function getTimezoneOffset(tz: string, asOf: Date = new Date()): string {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      timeZoneName: 'longOffset',
    });
    const parts = fmt.formatToParts(asOf);
    const tzName = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    // "GMT+05:00", "UTC+5", "GMT-04:00", "GMT" (= +00:00)
    const m = tzName.match(/([+-])(\d{1,2})(?::?(\d{2}))?/);
    if (!m) {
      // "GMT" alone = UTC
      return tzName.startsWith('GMT') || tzName.startsWith('UTC') ? '+00:00' : '+00:00';
    }
    const sign = m[1];
    const hh = m[2].padStart(2, '0');
    const mm = (m[3] ?? '00').padStart(2, '0');
    return `${sign}${hh}:${mm}`;
  } catch {
    return '+00:00';
  }
}

/** Convenience: user's offset on a given date. */
export async function getUserTimezoneOffset(userId: number, asOf: Date = new Date()): Promise<string> {
  const tz = await getUserTimezone(userId);
  return getTimezoneOffset(tz, asOf);
}

/** Today's date in the user's local frame, formatted YYYY-MM-DD.
 *  Used by compose to anchor "today/tomorrow/yesterday" resolution.
 *  Previously this was UTC, which broke at PKT 02:23 when the user
 *  said "tomorrow" and Brain saw "today = UTC May 20" instead of
 *  "today = PKT May 21" → off by one day. */
export async function getUserLocalDate(userId: number, asOf: Date = new Date()): Promise<string> {
  const tz = await getUserTimezone(userId);
  return formatLocalDate(tz, asOf);
}

/** Format a date as YYYY-MM-DD in a specific timezone. Exported
 *  for callers that already have the tz string (e.g., dispatcher
 *  paths where tz is resolved upstream). */
export function formatLocalDate(tz: string, asOf: Date = new Date()): string {
  try {
    // en-CA emits ISO-shaped "YYYY-MM-DD" by default.
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(asOf);
  } catch {
    return asOf.toISOString().slice(0, 10);
  }
}

/** Format an instant as "YYYY-MM-DD HH:mm" wall-clock in a zone. */
export function formatInZone(tz: string, asOf: Date): string {
  try {
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(asOf);
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(asOf);
    return `${date} ${time}`;
  } catch {
    return asOf.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
}

/** Signed offset minutes east of UTC for a zone at an instant
 *  (e.g. Karachi +300, New York −300 in winter / −240 in summer). */
export function offsetMinutesInZone(tz: string, at: Date): number {
  const s = getTimezoneOffset(tz, at); // "+05:00" | "-04:00"
  const m = s.match(/^([+-])(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const min = parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
  return m[1] === '-' ? -min : min;
}

/** UTC instant at which a zone's wall clock reads `ymd hms`. Two-pass
 *  so the offset used is the one in force AT that local time — correct
 *  across DST transitions (a naive single pass picks the offset in
 *  force at the UTC guess, which is wrong within the shift window). */
export function utcInstantForLocal(tz: string, ymd: string, hms = '00:00:00'): Date {
  const base = Date.parse(`${ymd}T${hms}.000Z`);
  let guess = new Date(base);
  for (let i = 0; i < 2; i++) {
    guess = new Date(base - offsetMinutesInZone(tz, guess) * 60_000);
  }
  return guess;
}

/** [start, end] UTC instants of one local calendar day in a zone.
 *  End = last ms of the day. DST-correct: a 23h/25h local day yields
 *  bounds exactly 23h/25h apart. */
export function zonedDayBounds(tz: string, ymd: string): { fromUtc: Date; toUtc: Date } {
  const fromUtc = utcInstantForLocal(tz, ymd);
  const toUtc = new Date(utcInstantForLocal(tz, addDaysYmd(ymd, 1)).getTime() - 1);
  return { fromUtc, toUtc };
}

/** Add n calendar days to a YYYY-MM-DD string (pure date math). */
export function addDaysYmd(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export type CalendarRange = { fromUtc: Date; toUtc: Date; label: string };

/** Resolve a user-facing range keyword to UTC bounds in a zone.
 *  Week semantics are the established rolling-7-day window (this_week
 *  = today..+6, next_week = +7..+13), unchanged from the old logic.
 *  Returns null for an unrecognised range. Pure — exported for tests. */
export function calendarRangeBounds(range: string, tz: string, now: Date = new Date()): CalendarRange | null {
  const today = formatLocalDate(tz, now);
  if (range === 'today') return { ...zonedDayBounds(tz, today), label: today };
  if (range === 'tomorrow') {
    const d = addDaysYmd(today, 1);
    return { ...zonedDayBounds(tz, d), label: d };
  }
  if (range === 'this_week' || range === 'next_week') {
    const start = range === 'next_week' ? addDaysYmd(today, 7) : today;
    const end = addDaysYmd(start, 6);
    return {
      fromUtc: zonedDayBounds(tz, start).fromUtc,
      toUtc: zonedDayBounds(tz, end).toUtc,
      label: `${start} → ${end}`,
    };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(range)) return { ...zonedDayBounds(tz, range), label: range };
  return null;
}
