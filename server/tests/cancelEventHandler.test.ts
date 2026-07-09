import { describe, it, expect, vi, beforeEach } from 'vitest';

// B5 regression fix — cancelEvent.execute() was a STUB (returned ok with a
// fabricated receipt, deleted nothing). Harmless while nothing routed here;
// after B5 pointed voice cancel_meeting at this handler, every cancel would
// execute-nothing then fail at confirm(). execute() must make the real
// provider call.

const deleteEventMock = vi.fn(async () => ({ success: true }));
vi.mock('../src/services/calendarService', () => ({
  deleteEvent: (...a: any[]) => deleteEventMock(...a),
}));
vi.mock('../src/services/adapters/calendarAdapter', () => ({
  getEvents: vi.fn(async () => ({ events: [] })),
}));

import { CancelEventHandler } from '../src/services/actions/handlers/calendar/cancelEvent';

const ctx = { clientNumber: 'tmc', userId: 2, payload: { eventId: 'evt_1' } };

beforeEach(() => vi.clearAllMocks());

describe('CancelEventHandler.execute', () => {
  it('actually deletes the event via calendarService', async () => {
    const h = new CancelEventHandler();
    const out = await h.execute(ctx as any);
    expect(deleteEventMock).toHaveBeenCalledWith(2, 'evt_1');
    expect(out.ok).toBe(true);
    expect((out.output as any).eventId).toBe('evt_1');
  });

  it('surfaces provider failure as ok:false', async () => {
    deleteEventMock.mockResolvedValue({ success: false, error: 'not found' });
    const h = new CancelEventHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('not found');
  });
});
