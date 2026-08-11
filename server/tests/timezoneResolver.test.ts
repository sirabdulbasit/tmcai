import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isValidTimezone,
  pickTimezone,
  systemDefaultTimezone,
  offsetMinutesInZone,
  utcInstantForLocal,
  zonedDayBounds,
  addDaysYmd,
  calendarRangeBounds,
  formatLocalDate,
  formatInZone,
  getTimezoneOffset,
} from '../src/services/userTimezoneService';

// Hardening audit 2026-07-14, item #1 — hardcoded Asia/Karachi (+5h
// offset math) replaced by an IANA resolver chain:
//   user → tenant → system default → UTC
// These tests lock the pure layer: validation, candidate picking, and
// DST-correct day/range boundary math.

afterEach(() => {
  delete process.env.NEXEO_DEFAULT_TIMEZONE;
  vi.restoreAllMocks();
});

describe('isValidTimezone', () => {
  it('accepts real IANA zones and rejects junk', () => {
    expect(isValidTimezone('Asia/Karachi')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Mars/Olympus_Mons')).toBe(false);
    // Was `true` when written on 2026-07-14: ES2022 Intl accepted explicit
    // offset zones. Node 20.20.2's ICU rejects them —
    // `new Intl.DateTimeFormat('en', { timeZone: '+05:00' })` throws "Invalid
    // time zone specified". Rejecting is the correct answer now: the function's
    // contract is "can Intl format with this zone?", and anything that says yes
    // to a zone Intl will throw on hands a crash to every caller downstream.
    // No stored timezone uses this shape (checked: both users are Asia/Karachi),
    // so this is a runtime change recorded, not a behaviour change chosen.
    expect(isValidTimezone('+05:00')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone(null)).toBe(false);
  });
});

describe('pickTimezone — the resolver chain', () => {
  it('user setting wins over tenant and system', () => {
    const r = pickTimezone([
      { source: 'user', tz: 'America/New_York' },
      { source: 'tenant', tz: 'Europe/London' },
      { source: 'system', tz: 'Asia/Karachi' },
    ]);
    expect(r).toEqual({ tz: 'America/New_York', source: 'user' });
  });

  it('tenant applies when user is unset', () => {
    const r = pickTimezone([
      { source: 'user', tz: null },
      { source: 'tenant', tz: 'Europe/London' },
      { source: 'system', tz: 'Asia/Karachi' },
    ]);
    expect(r).toEqual({ tz: 'Europe/London', source: 'tenant' });
  });

  it('an INVALID user value is skipped (with a warning), not used', () => {
    const r = pickTimezone([
      { source: 'user', tz: 'Not/A_Zone' },
      { source: 'tenant', tz: null },
      { source: 'system', tz: 'Asia/Karachi' },
    ]);
    expect(r).toEqual({ tz: 'Asia/Karachi', source: 'system' });
  });

  it('falls all the way to UTC when nothing valid is configured', () => {
    const r = pickTimezone([
      { source: 'user', tz: 'garbage' },
      { source: 'tenant', tz: undefined },
      { source: 'system', tz: 'also-garbage' },
    ]);
    expect(r).toEqual({ tz: 'UTC', source: 'fallback_utc' });
  });

  it('two users in the same tenant can resolve to different zones', () => {
    const tenant = { source: 'tenant', tz: 'Asia/Karachi' };
    const a = pickTimezone([{ source: 'user', tz: 'America/New_York' }, tenant]);
    const b = pickTimezone([{ source: 'user', tz: null }, tenant]);
    expect(a.tz).toBe('America/New_York');
    expect(b.tz).toBe('Asia/Karachi');
  });
});

describe('systemDefaultTimezone', () => {
  it('honours a valid NEXEO_DEFAULT_TIMEZONE', () => {
    process.env.NEXEO_DEFAULT_TIMEZONE = 'Europe/Berlin';
    expect(systemDefaultTimezone()).toBe('Europe/Berlin');
  });
  it('ignores an invalid env value and keeps the documented default', () => {
    process.env.NEXEO_DEFAULT_TIMEZONE = 'Pluto/Nowhere';
    expect(systemDefaultTimezone()).toBe('Asia/Karachi');
  });
});

describe('day boundaries — Karachi / New York (DST both ways) / UTC', () => {
  it('Asia/Karachi (+05:00, no DST): local day starts 5h before UTC midnight', () => {
    const { fromUtc, toUtc } = zonedDayBounds('Asia/Karachi', '2026-07-14');
    expect(fromUtc.toISOString()).toBe('2026-07-13T19:00:00.000Z');
    expect(toUtc.toISOString()).toBe('2026-07-14T18:59:59.999Z');
  });

  it('America/New_York in WINTER (EST, -05:00)', () => {
    const { fromUtc, toUtc } = zonedDayBounds('America/New_York', '2026-01-15');
    expect(fromUtc.toISOString()).toBe('2026-01-15T05:00:00.000Z');
    expect(toUtc.toISOString()).toBe('2026-01-16T04:59:59.999Z');
  });

  it('America/New_York in SUMMER (EDT, -04:00)', () => {
    const { fromUtc, toUtc } = zonedDayBounds('America/New_York', '2026-07-15');
    expect(fromUtc.toISOString()).toBe('2026-07-15T04:00:00.000Z');
    expect(toUtc.toISOString()).toBe('2026-07-16T03:59:59.999Z');
  });

  it('the spring-forward day is 23 hours long (2026-03-08 in New York)', () => {
    const { fromUtc, toUtc } = zonedDayBounds('America/New_York', '2026-03-08');
    const hours = (toUtc.getTime() + 1 - fromUtc.getTime()) / 3_600_000;
    expect(hours).toBe(23);
  });

  it('the fall-back day is 25 hours long (2026-11-01 in New York)', () => {
    const { fromUtc, toUtc } = zonedDayBounds('America/New_York', '2026-11-01');
    const hours = (toUtc.getTime() + 1 - fromUtc.getTime()) / 3_600_000;
    expect(hours).toBe(25);
  });

  it('UTC: day bounds are exactly the ISO day', () => {
    const { fromUtc, toUtc } = zonedDayBounds('UTC', '2026-07-14');
    expect(fromUtc.toISOString()).toBe('2026-07-14T00:00:00.000Z');
    expect(toUtc.toISOString()).toBe('2026-07-14T23:59:59.999Z');
  });
});

describe('offset helpers', () => {
  it('offsetMinutesInZone is signed and DST-aware', () => {
    expect(offsetMinutesInZone('Asia/Karachi', new Date('2026-07-14T12:00:00Z'))).toBe(300);
    expect(offsetMinutesInZone('America/New_York', new Date('2026-01-15T12:00:00Z'))).toBe(-300);
    expect(offsetMinutesInZone('America/New_York', new Date('2026-07-15T12:00:00Z'))).toBe(-240);
    expect(offsetMinutesInZone('UTC', new Date())).toBe(0);
  });

  it('getTimezoneOffset strings match', () => {
    expect(getTimezoneOffset('America/New_York', new Date('2026-01-15T12:00:00Z'))).toBe('-05:00');
    expect(getTimezoneOffset('America/New_York', new Date('2026-07-15T12:00:00Z'))).toBe('-04:00');
  });

  it('utcInstantForLocal round-trips through formatInZone', () => {
    const inst = utcInstantForLocal('America/New_York', '2026-07-15', '09:30:00');
    expect(formatInZone('America/New_York', inst)).toBe('2026-07-15 09:30');
  });
});

describe('calendarRangeBounds — the fetch_calendar ranges', () => {
  // Fixed "now": 2026-07-14 02:30 UTC. In Karachi that is already
  // July 14 (07:30 local); in New York it is still July 13 (22:30).
  const now = new Date('2026-07-14T02:30:00Z');

  it('"today" differs by zone at the same instant', () => {
    expect(calendarRangeBounds('today', 'Asia/Karachi', now)!.label).toBe('2026-07-14');
    expect(calendarRangeBounds('today', 'America/New_York', now)!.label).toBe('2026-07-13');
  });

  it('"tomorrow" is the next LOCAL day with local-midnight bounds', () => {
    const r = calendarRangeBounds('tomorrow', 'Asia/Karachi', now)!;
    expect(r.label).toBe('2026-07-15');
    expect(r.fromUtc.toISOString()).toBe('2026-07-14T19:00:00.000Z');
  });

  it('weeks keep the rolling-7-day semantics', () => {
    const w = calendarRangeBounds('this_week', 'Asia/Karachi', now)!;
    expect(w.label).toBe('2026-07-14 → 2026-07-20');
    const n = calendarRangeBounds('next_week', 'Asia/Karachi', now)!;
    expect(n.label).toBe('2026-07-21 → 2026-07-27');
    // Bounds cover exactly 7 local days.
    expect((n.toUtc.getTime() + 1 - n.fromUtc.getTime()) / 86_400_000).toBe(7);
  });

  it('explicit YYYY-MM-DD and invalid input', () => {
    const d = calendarRangeBounds('2026-08-01', 'UTC', now)!;
    expect(d.fromUtc.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(calendarRangeBounds('someday', 'UTC', now)).toBeNull();
  });
});

describe('addDaysYmd / formatLocalDate', () => {
  it('crosses month and year boundaries', () => {
    expect(addDaysYmd('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDaysYmd('2026-03-01', -1)).toBe('2026-02-28');
  });
  it('formatLocalDate falls back to ISO on a broken zone', () => {
    expect(formatLocalDate('Broken/Zone', new Date('2026-07-14T12:00:00Z'))).toBe('2026-07-14');
  });
});
