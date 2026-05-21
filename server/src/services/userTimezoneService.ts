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

const DEFAULT_TZ = 'Asia/Karachi';
const TZ_CACHE_TTL_SEC = 300;

/** Look up a user's IANA timezone. Falls back to Asia/Karachi for
 *  legacy rows (existing users predate this column). */
export async function getUserTimezone(userId: number): Promise<string> {
  try {
    const { getOrCompute } = await import('../utils/redisClient');
    return await getOrCompute(`usertz:${userId}`, TZ_CACHE_TTL_SEC, async () => {
      const row = await prisma.user.findUnique({
        where: { id: userId },
        select: { timezone: true },
      });
      return row?.timezone || DEFAULT_TZ;
    });
  } catch {
    return DEFAULT_TZ;
  }
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
