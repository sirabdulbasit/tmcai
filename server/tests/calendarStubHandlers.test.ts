import { describe, it, expect, vi, beforeEach } from 'vitest';

// F1 capability-parity gap-fill — reschedule_event, add_attendee and
// propose_times had STUB execute() methods (fabricated receipts, no provider
// I/O). Harmless while nothing routed to them; after the B2 confirm()
// hardening every run would "succeed" at execute then fail at confirm.
// Same class of bug as cancel_event (see cancelEventHandler.test.ts) —
// execute() must do the real work:
//   - reschedule_event → calendarService.updateEvent(userId, eventId, {startTime, endTime})
//   - add_attendee     → read current attendees via adapter getEvents, then
//                        updateEvent with the patched attendee list
//   - propose_times    → real free/busy computation over adapter getEvents
//                        (pure read + deterministic slot-finding, no write)

const updateEventMock = vi.fn(async (..._a: any[]) => ({ event: { id: 'evt_1' } }));
vi.mock('../src/services/calendarService', () => ({
  updateEvent: (...a: any[]) => updateEventMock(...a),
}));

const getEventsMock = vi.fn(async (..._a: any[]) => ({ events: [] as any[] }));
vi.mock('../src/services/adapters/calendarAdapter', () => ({
  getEvents: (...a: any[]) => getEventsMock(...a),
}));

import { RescheduleEventHandler } from '../src/services/actions/handlers/calendar/rescheduleEvent';
import { AddAttendeeHandler } from '../src/services/actions/handlers/calendar/addAttendee';
import { ProposeTimesHandler } from '../src/services/actions/handlers/calendar/proposeTimes';

// Future, timezone-explicit ISO times so the "don't propose/write past times"
// guards never trip regardless of when the suite runs.
const IN_A_WEEK = new Date(Date.now() + 7 * 24 * 3600_000);

beforeEach(() => {
  vi.clearAllMocks();
  updateEventMock.mockResolvedValue({ event: { id: 'evt_1' } });
  getEventsMock.mockResolvedValue({ events: [] });
});

// ─── reschedule_event ────────────────────────────────────────────

describe('RescheduleEventHandler.execute', () => {
  const newStart = new Date(IN_A_WEEK.getTime()).toISOString();
  const newEnd = new Date(IN_A_WEEK.getTime() + 30 * 60_000).toISOString();
  const ctx = { clientNumber: 'tmc', userId: 2, payload: { eventId: 'evt_1', newStartTime: newStart, newEndTime: newEnd } };

  it('actually moves the event via calendarService.updateEvent', async () => {
    const h = new RescheduleEventHandler();
    const out = await h.execute(ctx as any);
    expect(updateEventMock).toHaveBeenCalledWith(2, 'evt_1', { startTime: newStart, endTime: newEnd });
    expect(out.ok).toBe(true);
    expect((out.output as any).eventId).toBe('evt_1');
    expect((out.output as any).newStart).toBe(newStart);
    expect((out.output as any).newEnd).toBe(newEnd);
  });

  it('captures previousStart from the provider read (for undo)', async () => {
    const oldStart = new Date(IN_A_WEEK.getTime() - 24 * 3600_000).toISOString();
    getEventsMock.mockResolvedValue({
      events: [{ id: 'evt_1', title: 'Old slot', start: oldStart, end: oldStart, attendees: [], status: 'confirmed', isAllDay: false }],
    });
    const h = new RescheduleEventHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(true);
    expect((out.output as any).previousStart).toBe(oldStart);
  });

  it('surfaces provider failure as ok:false', async () => {
    updateEventMock.mockResolvedValue({ error: 'Update failed: quota exceeded' });
    const h = new RescheduleEventHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('quota');
  });
});

// ─── add_attendee ────────────────────────────────────────────────

describe('AddAttendeeHandler.execute', () => {
  const ctx = { clientNumber: 'tmc', userId: 2, payload: { eventId: 'evt_2', email: 'new@x.com' } };
  const liveEvent = {
    id: 'evt_2', title: 'Standup',
    start: IN_A_WEEK.toISOString(), end: new Date(IN_A_WEEK.getTime() + 30 * 60_000).toISOString(),
    attendees: ['existing@x.com'], status: 'confirmed', isAllDay: false,
  };

  it('patches the event with existing attendees plus the new email', async () => {
    getEventsMock.mockResolvedValue({ events: [liveEvent] });
    const h = new AddAttendeeHandler();
    const out = await h.execute(ctx as any);
    // Full-replacement patch must PRESERVE the current list, not clobber it.
    expect(updateEventMock).toHaveBeenCalledWith(2, 'evt_2', { attendees: ['existing@x.com', 'new@x.com'] });
    expect(out.ok).toBe(true);
    expect((out.output as any).eventId).toBe('evt_2');
    expect((out.output as any).addedEmail).toBe('new@x.com');
  });

  it('is idempotent: attendee already on the event → ok without a write', async () => {
    getEventsMock.mockResolvedValue({ events: [{ ...liveEvent, attendees: ['new@x.com'] }] });
    const h = new AddAttendeeHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(true);
    expect(updateEventMock).not.toHaveBeenCalled();
  });

  it('fails closed when the event cannot be found (no blind write)', async () => {
    getEventsMock.mockResolvedValue({ events: [] });
    const h = new AddAttendeeHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/not found/i);
    expect(updateEventMock).not.toHaveBeenCalled();
  });

  it('surfaces provider write failure as ok:false', async () => {
    getEventsMock.mockResolvedValue({ events: [liveEvent] });
    updateEventMock.mockResolvedValue({ error: 'Update failed: forbidden' });
    const h = new AddAttendeeHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('forbidden');
  });
});

// ─── propose_times ───────────────────────────────────────────────

describe('ProposeTimesHandler.execute', () => {
  // Build a single working day (local 09:00–18:00) a week out so "now" never
  // intersects the window and the expected free gap is unambiguous.
  const day = new Date(Date.now() + 7 * 24 * 3600_000);
  const at = (h: number, m = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
  const rangeStart = at(9).toISOString();
  const rangeEnd = at(18).toISOString();
  const baseCtx = {
    clientNumber: 'tmc', userId: 2,
    payload: { attendees: ['someone@x.com'], durationMinutes: 60, rangeStart, rangeEnd, maxSuggestions: 3 },
  };
  const busy = (sh: number, sm: number, eh: number, em: number) => ({
    id: `busy_${sh}${sm}`, title: 'Busy', start: at(sh, sm).toISOString(), end: at(eh, em).toISOString(),
    attendees: [], status: 'confirmed', isAllDay: false,
  });

  it('proposes only genuinely-free slots given a busy calendar', async () => {
    // Busy 09:00–12:00 and 13:00–18:00 → the ONLY free 60-min slot is 12:00–13:00.
    getEventsMock.mockResolvedValue({ events: [busy(9, 0, 12, 0), busy(13, 0, 18, 0)] });
    const h = new ProposeTimesHandler();
    const out = await h.execute(baseCtx as any);
    expect(out.ok).toBe(true);
    const suggestions = (out.output as any).suggestions as Array<{ start: string; end: string }>;
    expect(suggestions).toHaveLength(1);
    expect(new Date(suggestions[0].start).getTime()).toBe(at(12, 0).getTime());
    expect(new Date(suggestions[0].end).getTime()).toBe(at(13, 0).getTime());
    // The real output must still satisfy the shape-check confirm().
    await expect(h.confirm(baseCtx as any, out.output)).resolves.toBe(true);
  });

  it('never proposes a slot overlapping any busy event', async () => {
    getEventsMock.mockResolvedValue({ events: [busy(10, 0, 11, 0), busy(14, 30, 15, 30)] });
    const h = new ProposeTimesHandler();
    const out = await h.execute(baseCtx as any);
    expect(out.ok).toBe(true);
    const suggestions = (out.output as any).suggestions as Array<{ start: string; end: string }>;
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.length).toBeLessThanOrEqual(3);
    for (const s of suggestions) {
      const sStart = new Date(s.start).getTime();
      const sEnd = new Date(s.end).getTime();
      expect(sEnd - sStart).toBe(60 * 60_000);
      // Within working hours / requested window
      expect(sStart).toBeGreaterThanOrEqual(at(9, 0).getTime());
      expect(sEnd).toBeLessThanOrEqual(at(18, 0).getTime());
      // No overlap with either busy block
      for (const b of [[at(10, 0), at(11, 0)], [at(14, 30), at(15, 30)]] as const) {
        expect(sStart >= b[1].getTime() || sEnd <= b[0].getTime()).toBe(true);
      }
    }
  });

  it('fails closed when the whole window is busy (no fabricated slots)', async () => {
    getEventsMock.mockResolvedValue({ events: [busy(9, 0, 18, 0)] });
    const h = new ProposeTimesHandler();
    const out = await h.execute(baseCtx as any);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/no free/i);
  });

  it('surfaces provider read failure as ok:false', async () => {
    getEventsMock.mockResolvedValue({ events: [], error: 'calendar unreachable' });
    const h = new ProposeTimesHandler();
    const out = await h.execute(baseCtx as any);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('calendar unreachable');
  });
});
