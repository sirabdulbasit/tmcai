import { describe, it, expect, vi, beforeEach } from 'vitest';

// B5 — the voice-instruction dispatcher executed human-facing actions
// DIRECTLY (gmailService.sendUserEmail, calendarService.create/deleteEvent):
// no AgentAction row, no executor-owned status, no confirm() read-back, no
// undo. Every human-facing action must route through executeViaRegistry so
// the trust invariant holds on this path too.

const executeViaRegistryMock = vi.fn(async () => ({
  ok: true, actionId: 91, handlerName: 'x',
  output: { eventId: 'evt_1', messageId: 'm1' },
  dependencyGraphId: 'g', traceId: 't',
}));

const feedEventFindFirst = vi.fn();
const userFindFirst = vi.fn();
const openItemCreate = vi.fn(async () => ({ id: 'oi_9' }));

vi.mock('../src/services/actions/executeViaRegistry', () => ({
  executeViaRegistry: (...a: any[]) => executeViaRegistryMock(...a),
}));
vi.mock('../src/db/prisma', () => ({
  default: {
    feedEvent: { findFirst: (...a: any[]) => feedEventFindFirst(...a) },
    user: { findFirst: (...a: any[]) => userFindFirst(...a) },
    openItem: { create: (...a: any[]) => openItemCreate(...a) },
  },
}));
vi.mock('../src/services/knowledge/toneService', () => ({
  composeForwardNote: vi.fn(async () => 'polished cover note'),
}));
vi.mock('../src/services/userTimezoneService', () => ({
  getUserTimezoneOffset: vi.fn(async () => '+05:00'),
  // audit 2026-07-14 #1: the dispatcher's catch-fallback now derives
  // from the system default zone instead of a hardcoded '+05:00'.
  getTimezoneOffset: vi.fn(() => '+05:00'),
  systemDefaultTimezone: vi.fn(() => 'Asia/Karachi'),
}));

import { dispatchInstruction } from '../src/services/instructions/instructionDispatcher';

const base = { clientNumber: 'tmc', userId: 2 };

beforeEach(() => {
  vi.clearAllMocks();
  executeViaRegistryMock.mockResolvedValue({
    ok: true, actionId: 91, handlerName: 'x',
    output: { eventId: 'evt_1', messageId: 'm1' },
    dependencyGraphId: 'g', traceId: 't',
  });
});

describe('B5 — dispatcher routes human-facing actions through the registry', () => {
  it('delegate: forwards via the send_email handler, not gmailService directly', async () => {
    feedEventFindFirst.mockResolvedValue({
      senderEmail: 'boss@x.com', senderName: 'Boss',
      rawPayload: { subject: 'Q3 numbers', from: 'boss@x.com', snippet: 'see attached' },
    });
    userFindFirst.mockResolvedValue({ email: 'sara@tmc.com', integrationEmail: null, name: 'Sara' });

    const r = await dispatchInstruction({
      ...base,
      instruction: {
        intent: 'delegate', confidence: 0.9,
        targetFeedEventId: 'fe_1',
        params: { delegateeName: 'Sara', delegateeNote: 'handle this' } as any,
        summary: 'Delegate to Sara',
      },
    });
    expect(executeViaRegistryMock).toHaveBeenCalledWith(expect.objectContaining({
      actionType: 'send_email',
      clientNumber: 'tmc', userId: 2,
      executedByAgent: 'voice_instruction',
      payload: expect.objectContaining({
        to: ['sara@tmc.com'],
        subject: 'Fwd: Q3 numbers',
        body: 'polished cover note',
      }),
    }));
    expect(r.ok).toBe(true);
  });

  it('schedule_meeting: books via the create_event handler', async () => {
    const r = await dispatchInstruction({
      ...base,
      instruction: {
        intent: 'schedule_meeting', confidence: 0.9,
        params: { meetingTitle: 'Standup', meetingWhen: '2026-07-09T11:00', meetingAttendees: ['a@x.com'] } as any,
        summary: 'Schedule standup',
      },
    });
    expect(executeViaRegistryMock).toHaveBeenCalledWith(expect.objectContaining({
      actionType: 'create_event',
      executedByAgent: 'voice_instruction',
      payload: expect.objectContaining({
        summary: 'Standup',
        attendees: ['a@x.com'],
        startTime: expect.stringContaining('2026-07-09'),
      }),
    }));
    expect(r.ok).toBe(true);
    expect(r.artifactId).toBe('evt_1');
  });

  it('cancel_meeting: cancels via the cancel_event handler', async () => {
    const r = await dispatchInstruction({
      ...base,
      instruction: {
        intent: 'cancel_meeting', confidence: 0.9,
        params: { eventId: 'evt_1', reason: 'conflict' } as any,
        summary: 'Cancel it',
      },
    });
    expect(executeViaRegistryMock).toHaveBeenCalledWith(expect.objectContaining({
      actionType: 'cancel_event',
      payload: expect.objectContaining({ eventId: 'evt_1' }),
    }));
    expect(r.ok).toBe(true);
  });

  it('reschedule_meeting: moves via the reschedule_event handler (B5 exception lifted)', async () => {
    const r = await dispatchInstruction({
      ...base,
      instruction: {
        intent: 'reschedule_meeting', confidence: 0.9,
        params: { eventId: 'evt_1', newWhenIso: '2026-07-10T15:00', newDurationMin: 45 } as any,
        summary: 'Move it',
      },
    });
    expect(executeViaRegistryMock).toHaveBeenCalledWith(expect.objectContaining({
      actionType: 'reschedule_event',
      executedByAgent: 'voice_instruction',
      payload: expect.objectContaining({
        eventId: 'evt_1',
        newStartTime: expect.stringContaining('2026-07-10'),
        newEndTime: expect.any(String),
      }),
    }));
    expect(r.ok).toBe(true);
  });

  it('registry failure surfaces as ok:false — never a fake success message', async () => {
    executeViaRegistryMock.mockResolvedValue({
      ok: false, actionId: 92, handlerName: 'x',
      error: 'confirm() returned false for handler "create_event"',
      dependencyGraphId: 'g', traceId: 't',
    });
    const r = await dispatchInstruction({
      ...base,
      instruction: {
        intent: 'schedule_meeting', confidence: 0.9,
        params: { meetingTitle: 'Standup', meetingWhen: '2026-07-09T11:00' } as any,
        summary: 'Schedule standup',
      },
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('confirm() returned false');
  });
});
