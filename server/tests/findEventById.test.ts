import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fix 5 (2026-07-09) — dedupe the six hand-rolled "find one event on
// the user's calendar" scans that lived inside handler code.
// cancelEvent, rescheduleEvent (execute + confirm), addAttendee
// (execute + confirm), and createEvent (confirm) each ran their own
// copy of: getEvents(now→+180d, 250) then find(e => e.id === id ||
// e.id.startsWith(`${id}_`)) filtered by status !== 'cancelled'.
// Six copies drift; one helper doesn't.

const getEventsMock = vi.fn(async (..._a: any[]) => ({ events: [] as any[], error: undefined as string | undefined }));

// findEventById lives in its own module (calendarEventFinder) that
// imports getEvents from calendarService. Mocking calendarService's
// getEvents intercepts the boundary cleanly — a same-file call would
// have used the module-local reference and bypassed the mock.
vi.mock('../src/services/calendarService', () => ({
  getEvents: (...a: any[]) => getEventsMock(...a),
}));

import { findEventById } from '../src/services/calendarEventFinder';

const ev = (over: any = {}) => ({
  id: 'evt_1',
  title: 'X',
  start: '2026-07-10T09:00:00Z',
  end: '2026-07-10T10:00:00Z',
  attendees: [],
  status: 'confirmed',
  isAllDay: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getEventsMock.mockResolvedValue({ events: [], error: undefined });
});

describe('findEventById — exact id + recurrence suffix + cancellation filter', () => {
  it('returns the event when the id matches exactly (non-cancelled)', async () => {
    getEventsMock.mockResolvedValue({ events: [ev(), ev({ id: 'evt_other' })], error: undefined });
    const r = await findEventById(2, 'evt_1');
    expect(r.error).toBeUndefined();
    expect(r.event?.id).toBe('evt_1');
    expect(r.anyMatch?.id).toBe('evt_1');
  });

  it('matches a Google Calendar recurrence-instance suffix (`<id>_<timestamp>`)', async () => {
    // Recurrence instances carry ids like evt_1_20260710T090000Z — the
    // caller cares about the master evt_1 but the concrete row is the
    // suffixed one. Helper must recognise both.
    getEventsMock.mockResolvedValue({
      events: [ev({ id: 'evt_1_20260710T090000Z' })],
      error: undefined,
    });
    const r = await findEventById(2, 'evt_1');
    expect(r.event?.id).toBe('evt_1_20260710T090000Z');
  });

  it('excludes cancelled rows from `event` but exposes them via `anyMatch`', async () => {
    // cancelEvent.confirm asserts absence-OR-cancelled by checking
    // `!event` (no live match). anyMatch is the receipt for observers
    // that want to see the cancellation actually landed.
    getEventsMock.mockResolvedValue({
      events: [ev({ status: 'cancelled' })],
      error: undefined,
    });
    const r = await findEventById(2, 'evt_1');
    expect(r.event).toBeNull();
    expect(r.anyMatch?.status).toBe('cancelled');
  });

  it('returns event=null and anyMatch=null when nothing matches the id', async () => {
    getEventsMock.mockResolvedValue({ events: [ev({ id: 'evt_other' })], error: undefined });
    const r = await findEventById(2, 'evt_1');
    expect(r.event).toBeNull();
    expect(r.anyMatch).toBeNull();
  });

  it('surfaces the underlying provider read error verbatim', async () => {
    getEventsMock.mockResolvedValue({ events: [], error: 'Calendar error: quota exceeded' });
    const r = await findEventById(2, 'evt_1');
    expect(r.error).toBe('Calendar error: quota exceeded');
    expect(r.event).toBeNull();
  });
});

describe('findEventById — window handling', () => {
  it('uses now → +180 days with maxResults=250 by default', async () => {
    const before = Date.now();
    await findEventById(2, 'evt_1');
    expect(getEventsMock).toHaveBeenCalled();
    const [uid, startArg, endArg, maxResults] = getEventsMock.mock.calls[0]!;
    expect(uid).toBe(2);
    // start is "roughly now" — within 60s
    expect(Math.abs((startArg as Date).getTime() - before)).toBeLessThan(60_000);
    // end - start ≈ 180 days
    const spanMs = (endArg as Date).getTime() - (startArg as Date).getTime();
    expect(spanMs).toBe(180 * 24 * 3600_000);
    expect(maxResults).toBe(250);
  });

  it('passes an explicit narrow window through to getEvents (with maxResults=50)', async () => {
    // Callers that know the event's rough time (createEvent.confirm,
    // rescheduleEvent.confirm) pass a ±1-min window so the API call
    // stays cheap. Helper must honour it AND drop maxResults to 50.
    const start = new Date('2026-07-10T09:00:00Z');
    const end = new Date('2026-07-10T10:00:00Z');
    await findEventById(2, 'evt_1', { start, end });
    const [uid, startArg, endArg, maxResults] = getEventsMock.mock.calls[0]!;
    expect(uid).toBe(2);
    expect(startArg).toBe(start);
    expect(endArg).toBe(end);
    expect(maxResults).toBe(50);
  });
});
