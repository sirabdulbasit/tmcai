import { describe, it, expect, vi, beforeEach } from 'vitest';

// 2026-07-14 — "fill the gaps including preactive": the three named
// living-assistant gaps, each with its safety story intact.
//   1. Preactive engine — meeting prep + deadline nudges (anticipation)
//   2. In-chat learning — passing remarks become PROPOSED memories
//   3. Email brain channel — "Nexeo…" self-emails get brain replies

// ─── shared mocks ──────────────────────────────────────────────────
const promptFindFirst = vi.fn();
const enqueueMock = vi.fn(async () => ({ status: 'sent_now' as const }));
const getEventsMock = vi.fn(async () => ({ events: [] as any[] }));
const openItemsFindMany = vi.fn(async () => [] as any[]);
const feedFindMany = vi.fn(async () => [] as any[]);
const usersFindMany = vi.fn(async () => [] as any[]);
const callLlmMock = vi.fn(async () => ({ text: 'Your 2:30 with Haseeb — the EXIM item is still open with Yousaf.', provider: 'gemini' }));

vi.mock('../src/db/prisma', () => ({
  default: {
    brainPromptQueue: { findFirst: (...a: any[]) => promptFindFirst(...a) },
    openItem: { findMany: (...a: any[]) => openItemsFindMany(...a) },
    feedEvent: { findMany: (...a: any[]) => feedFindMany(...a) },
    user: { findMany: (...a: any[]) => usersFindMany(...a), findFirst: vi.fn(async () => ({ email: 'basit.ahmed@tmcltd.ai', integrationEmail: 'basit.ahmed@tmcltd.com' })) },
  },
}));
vi.mock('../src/services/brainPrompts/brainPromptQueueService', () => ({
  enqueueBrainPrompt: (...a: any[]) => enqueueMock(...a),
}));
vi.mock('../src/services/calendarService', () => ({
  getEvents: (...a: any[]) => getEventsMock(...a),
}));
vi.mock('../src/services/llmRouter', () => ({
  callLLM: (...a: any[]) => callLlmMock(...a),
}));

import { runPreactiveTick, MEETING_PREP_WINDOW_MIN } from '../src/services/brain/preactiveEngine';
import { captureStandingPreference } from '../src/services/learning/standingPreferenceCapture';
import { isBrainAddressedEmail, extractBrainQuestion } from '../src/services/feed/emailBrainChannel';

const soon = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

beforeEach(() => {
  vi.clearAllMocks();
  promptFindFirst.mockResolvedValue(null);   // nothing sent yet
  enqueueMock.mockResolvedValue({ status: 'sent_now' });
  getEventsMock.mockResolvedValue({ events: [] });
  openItemsFindMany.mockResolvedValue([]);
  feedFindMany.mockResolvedValue([]);
  callLlmMock.mockResolvedValue({ text: 'Prep note.', provider: 'gemini' });
});

// ─── 1. Preactive engine ───────────────────────────────────────────

describe('preactive — meeting prep', () => {
  const meeting = {
    id: 'evt_1', title: '1:1 with Haseeb', start: soon(45), end: soon(75),
    attendees: ['haseeb@tmcltd.com'], status: 'confirmed', isAllDay: false,
  };

  it('preps an upcoming meeting with attendees (LLM-narrated, deduped per event)', async () => {
    getEventsMock.mockResolvedValue({ events: [meeting] });
    const r = await runPreactiveTick('TMC-0001', 2);
    expect(r.meetingPrepsSent).toBe(1);
    const call = enqueueMock.mock.calls[0]![0] as any;
    expect(call.dedupKey).toBe('meeting-prep:evt_1');
    expect(call.metadata.source).toBe('preactive_meeting_prep');
    expect(callLlmMock).toHaveBeenCalled(); // narrated, not hardcoded
  });

  it('skips solo blocks (no attendees) and all-day events — nothing to prep', async () => {
    getEventsMock.mockResolvedValue({ events: [
      { ...meeting, id: 'evt_solo', attendees: [] },
      { ...meeting, id: 'evt_allday', isAllDay: true },
    ] });
    const r = await runPreactiveTick('TMC-0001', 2);
    expect(r.meetingPrepsSent).toBe(0);
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('never re-preps an event (pre-check BEFORE spending the LLM call)', async () => {
    getEventsMock.mockResolvedValue({ events: [meeting] });
    promptFindFirst.mockResolvedValue({ id: 'bp_prev' }); // already prepped
    const r = await runPreactiveTick('TMC-0001', 2);
    expect(r.meetingPrepsSent).toBe(0);
    expect(callLlmMock).not.toHaveBeenCalled(); // no wasted narration
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('LLM failure degrades to a bracketed digest (marker rule), still sends', async () => {
    getEventsMock.mockResolvedValue({ events: [meeting] });
    callLlmMock.mockRejectedValue(new Error('llm down'));
    const r = await runPreactiveTick('TMC-0001', 2);
    expect(r.meetingPrepsSent).toBe(1);
    const q = String((enqueueMock.mock.calls[0]![0] as any).question);
    expect(q).toMatch(/^\[meeting prep\]/);
  });
});

describe('preactive — deadline nudges', () => {
  it('nudges an item due within 24h, once per day (dedup key carries the date)', async () => {
    openItemsFindMany.mockResolvedValue([
      { id: 'oi_1', title: 'Leave Request', status: 'DELEGATED', dueDate: new Date(Date.now() + 6 * 3600_000), delegateeName: 'Asad Ahmed Taj' },
    ]);
    const r = await runPreactiveTick('TMC-0001', 2);
    expect(r.dueNudgesSent).toBe(1);
    const call = enqueueMock.mock.calls[0]![0] as any;
    expect(call.dedupKey).toMatch(/^due-nudge:oi_1:\d{4}-\d{2}-\d{2}$/);
  });

  it('overdue items escalate to high criticality', async () => {
    openItemsFindMany.mockResolvedValue([
      { id: 'oi_2', title: 'EXIM solution', status: 'DELEGATED', dueDate: new Date(Date.now() - 3600_000), delegateeName: 'Muhammad Yousaf' },
    ]);
    await runPreactiveTick('TMC-0001', 2);
    expect((enqueueMock.mock.calls[0]![0] as any).criticality).toBe('high');
  });
});

// ─── 2. In-chat learning ───────────────────────────────────────────

describe('in-chat learning — propose, never self-activate', () => {
  const propose = vi.fn(async () => ({ id: 'mem_1', status: 'pending_approval' }));

  it('a durable remark becomes a PROPOSED memory (pending user approval)', async () => {
    const llm = vi.fn(async () => ({ text: '{"isStanding": true, "title": "Always cc finance on delegations", "content": "When delegating any item, cc the finance team.", "confidence": 0.9}' }));
    const r = await captureStandingPreference({
      clientNumber: 'TMC-0001', userId: 2,
      userMessage: 'always cc finance when you delegate anything',
      proposeMemory: propose, callLlm: llm as any,
    });
    expect(r.proposed).toBe(true);
    const arg = propose.mock.calls[0]![0] as any;
    expect(arg.createdByBrain).toBe(true); // forces pending_approval
    expect(arg.memoryType).toBe('standing_preference');
  });

  it('messages without durability markers never reach the LLM (zero cost)', async () => {
    const llm = vi.fn();
    const r = await captureStandingPreference({
      clientNumber: 'TMC-0001', userId: 2,
      userMessage: 'send the report to Asad please',
      proposeMemory: propose, callLlm: llm as any,
    });
    expect(r.reason).toBe('no_marker');
    expect(llm).not.toHaveBeenCalled();
  });

  it('one-off requests with marker words are dropped by the distiller', async () => {
    const llm = vi.fn(async () => ({ text: '{"isStanding": false, "confidence": 0.2}' }));
    const r = await captureStandingPreference({
      clientNumber: 'TMC-0001', userId: 2,
      userMessage: 'whenever you get a minute, send this one to Asad',
      proposeMemory: propose, callLlm: llm as any,
    });
    expect(r.proposed).toBe(false);
    expect(propose).not.toHaveBeenCalledTimes(2);
  });

  it('low-confidence distills are dropped silently (wrong rule worse than none)', async () => {
    const llm = vi.fn(async () => ({ text: '{"isStanding": true, "title": "t", "content": "c", "confidence": 0.4}' }));
    const r = await captureStandingPreference({
      clientNumber: 'TMC-0001', userId: 2,
      userMessage: 'from now on maybe do it differently sometimes',
      proposeMemory: propose, callLlm: llm as any,
    });
    expect(r.reason).toBe('low_confidence');
  });

  it('Roman-Urdu durability markers pass the pre-filter', async () => {
    const llm = vi.fn(async () => ({ text: '{"isStanding": true, "title": "Reply in English always", "content": "Always reply in English.", "confidence": 0.85}' }));
    const r = await captureStandingPreference({
      clientNumber: 'TMC-0001', userId: 2,
      userMessage: 'hamesha english mein reply karna',
      proposeMemory: propose, callLlm: llm as any,
    });
    expect(r.proposed).toBe(true);
  });
});

// ─── 3. Email brain channel ────────────────────────────────────────

describe('email brain channel — deterministic trigger', () => {
  it('matches a self-email with a Nexeo subject', () => {
    expect(isBrainAddressedEmail(
      { subject: 'Nexeo: what is open with Yousaf?', from: 'Basit Ahmed <basit.ahmed@tmcltd.com>' },
      'basit.ahmed@tmcltd.com',
    )).toBe(true);
  });

  it('never intercepts normal correspondence (no Nexeo subject)', () => {
    expect(isBrainAddressedEmail(
      { subject: 'Re: Custom Clearance Duty', from: 'basit.ahmed@tmcltd.com' },
      'basit.ahmed@tmcltd.com',
    )).toBe(false);
  });

  it('never replies to third parties even with the trigger subject', () => {
    expect(isBrainAddressedEmail(
      { subject: 'Nexeo: hello', from: 'stranger@other.com' },
      'basit.ahmed@tmcltd.com',
    )).toBe(false);
  });

  it('extracts the ask from subject + body, stripping the trigger', () => {
    expect(extractBrainQuestion({ subject: 'Nexeo: chase the EXIM item', body: '' }))
      .toBe('chase the EXIM item');
    expect(extractBrainQuestion({ subject: 'Nexeo', body: 'what is due this week?' }))
      .toBe('what is due this week?');
  });
});
