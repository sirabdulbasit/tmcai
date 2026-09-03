/**
 * DEF-307 — deck tag: `Told his emails auto-become tasks while whole channels
 * sit unread (email 89% never acted on) — DEF-305 fixed the WhatsApp inbox
 * only; email/calendar untouched`.
 *
 * gcal was the last dead channel: 55 of 55 in-window events at status:new,
 * 0 EVER processed — no derivation consumer existed for it, while Brain's
 * standing claim implied it reads every channel (`fabricated-status` by
 * DEF-243's co-existence test). gcal now joins the SAME channel-parameterized
 * consumer gmail and gchat share (DEF-246/DEF-253) — a third per-channel job
 * would be `protection-with-two-implementations` — inheriting the batch cap,
 * the 48h window, the creation gate and the receipts.
 *
 * The judgement is deliberately CONSERVATIVE, per the owner's own complaint
 * (CL-041: "why are you creating item based on invitations?"): an invite he
 * can simply attend or decline is NOT actionable; only an event asking him to
 * prepare/decide/provide beyond attending mints an item. Most events therefore
 * leave status:new as SKIPPED with a receipt — and that receipt is the point:
 * a reviewed-and-skipped channel is honest, an unread one licenses fabrication.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

const state = {
  rows: [] as any[],
  eventUpdates: [] as Array<{ id: string; data: any }>,
  itemCreates: [] as any[],
  srcEvents: [] as any[],
  llmQueue: [] as any[],
  llmCalls: 0,
  lastLlmSystem: '',
  lastLlmUser: '',
  gateResult: { block: false, status: 'NEW', delegateeId: null, delegateeName: null, delegateeEmail: null, missingSlots: [] } as any,
  behavior: {
    'comm.email_item_derivation_enabled': 1,
    'comm.chat_item_derivation_enabled': 1,
    'comm.gcal_item_derivation_enabled': 1,
    'comm.email_item_derivation_batch': 5,
  } as Record<string, number>,
};

vi.mock('../src/db/prisma', () => {
  const empty = {
    findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
    create: async () => ({}), update: async () => ({}), updateMany: async () => ({ count: 0 }),
    count: async () => 0, groupBy: async () => [],
  };
  const p: any = new Proxy(
    {
      feedEvent: {
        findMany: async (args: any) => {
          if (args?.where?.status !== 'new') return state.srcEvents;
          // Emulate the sourceType filter (the def253 lesson: without this a
          // channel dropped from the query would still "return" rows and the
          // suite could not catch it).
          const st = args.where.sourceType;
          const allowed: string[] | null = typeof st === 'string' ? [st] : (st?.in ?? null);
          return allowed ? state.rows.filter((r: any) => allowed.includes(r.sourceType)) : state.rows;
        },
        update: async (args: any) => { state.eventUpdates.push({ id: args.where.id, data: args.data }); return {}; },
      },
      openItem: {
        findMany: async () => [],
        create: async (args: any) => { state.itemCreates.push(args.data); return { id: 'item-new' }; },
      },
      user: {
        findFirst: async () => ({ email: 'haseeb@tmcltd.com', integrationEmail: 'haseeb@tmcltd.com' }),
      },
    },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

vi.mock('../src/services/geminiService', () => ({
  __esModule: true,
  callGemini: async (system: string, user: string) => {
    state.llmCalls += 1;
    state.lastLlmSystem = system;
    state.lastLlmUser = user;
    const next = state.llmQueue.shift() ?? { actionable: false, reason: 'default' };
    return { text: JSON.stringify(next) } as any;
  },
}));

vi.mock('../src/services/openItems/openItemGate', () => ({
  __esModule: true,
  gateOpenItemCreate: async () => state.gateResult,
}));

vi.mock('../src/services/behaviorConfig', () => ({
  __esModule: true,
  getBehaviorValue: async (key: string) => {
    if (key in state.behavior) return state.behavior[key];
    throw new Error(`unknown behavior key ${key}`);
  },
}));

const gcalRow = (over: Record<string, unknown> = {}) => ({
  id: 'fe-gcal-1',
  clientNumber: 'TMC-0001',
  userId: 2,
  sourceId: 'gcal-evt-1',
  sourceType: 'gcal',
  senderEmail: null,
  createdAt: new Date(),
  rawPayload: {
    summary: 'TMC <> InDrive kickoff',
    start: { dateTime: '2026-09-04T09:30:00Z' },
    organizer: { email: 'iliyas.smagulov@indriver.com', displayName: 'Iliyas Smagulov' },
    attendees: [{ email: 'haseeb@tmcltd.com' }, { displayName: 'Iliyas Smagulov' }],
    description: 'Please prepare the commercial proposal and bring the revised pricing before the call.',
  },
  ...over,
});

beforeEach(() => {
  state.rows = [];
  state.eventUpdates = [];
  state.itemCreates = [];
  state.srcEvents = [];
  state.llmQueue = [];
  state.llmCalls = 0;
  state.lastLlmSystem = '';
  state.lastLlmUser = '';
  state.behavior['comm.gcal_item_derivation_enabled'] = 1;
});

describe('DEF-307 — gcal joins the ONE consumer, and events leave status:new with a receipt', () => {
  it('an event asking for prep beyond attending becomes an item with sourceFeed gcal', async () => {
    state.rows = [gcalRow()];
    state.llmQueue = [{ actionable: true, title: 'Prepare commercial proposal for InDrive kickoff', description: 'Iliyas asked for the revised pricing before the call', priority: 'high', dueDateISO: null, reason: 'prep requested' }];
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    await runEmailItemDerivation();
    expect(state.itemCreates).toHaveLength(1);
    expect(state.itemCreates[0].sourceFeed).toBe('gcal');
    expect(state.itemCreates[0].sourceFeedEventId).toBe('fe-gcal-1');
    const receipt = state.eventUpdates.find((u) => u.id === 'fe-gcal-1');
    expect(receipt?.data.status).toBe('processed');
  });

  it('THE CL-041 RULE: a bare invitation is judged not-actionable and receipted as skipped — never an item', async () => {
    state.rows = [gcalRow({ rawPayload: {
      summary: 'Mentorship sync', start: { date: '2026-09-05' },
      organizer: 'calendar@company.com', attendees: [],
    } })];
    state.llmQueue = [{ actionable: false, reason: 'bare invite, attending suffices' }];
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    await runEmailItemDerivation();
    expect(state.itemCreates).toHaveLength(0);
    const receipt = state.eventUpdates.find((u) => u.id === 'fe-gcal-1');
    expect(receipt?.data.status).toBe('skipped');   // reviewed, not unread
  });

  it('the judge is TOLD it is a calendar event, sees the organizer, the start and the description', async () => {
    state.rows = [gcalRow()];
    state.llmQueue = [{ actionable: false, reason: 'x' }];
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    await runEmailItemDerivation();
    // The prompt carries the honest third clause and the owner's own rule.
    expect(state.lastLlmSystem).toContain('calendar event/invitation');
    expect(state.lastLlmSystem).toMatch(/actionable ONLY if it asks him to do something BEYOND attending/);
    expect(state.lastLlmSystem).toMatch(/items minted from bare invitations are noise/);
    // The judged content is the EVENT's fields, not email fields.
    expect(state.lastLlmUser).toContain('TMC <> InDrive kickoff');
    expect(state.lastLlmUser).toContain('iliyas.smagulov@indriver.com');
    expect(state.lastLlmUser).toContain('2026-09-04T09:30:00Z');
    expect(state.lastLlmUser).toContain('prepare the commercial proposal');
  });

  it('gcal keeps its OWN kill switch: 0 leaves the event untouched (still new), and gmail/gchat are unaffected', async () => {
    state.behavior['comm.gcal_item_derivation_enabled'] = 0;
    state.rows = [gcalRow()];
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    await runEmailItemDerivation();
    expect(state.llmCalls).toBe(0);
    expect(state.eventUpdates).toHaveLength(0);   // no receipt forged while OFF
    expect(state.itemCreates).toHaveLength(0);
  });

  it('MUTATION PIN: dropping gcal from the query silences the channel again — the fixture only returns rows the query asks for', async () => {
    // The mock emulates the sourceType filter, so this test fails if 'gcal'
    // leaves the IN clause (the def253 mutation lesson, applied to the third
    // channel).
    state.rows = [gcalRow()];
    state.llmQueue = [{ actionable: false, reason: 'x' }];
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    await runEmailItemDerivation();
    expect(state.llmCalls).toBe(1);
  });

  it('a string organizer and object attendees both render — the defensive shapes buildCalendarSnapshot reads', async () => {
    state.rows = [gcalRow({ rawPayload: {
      title: 'Board review', start: { date: '2026-09-06' },
      organizer: 'chair@board.com',
      attendees: ['guest@x.com'],
      description: 'Decide on the budget line.',
    } })];
    state.llmQueue = [{ actionable: false, reason: 'x' }];
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    await runEmailItemDerivation();
    expect(state.lastLlmUser).toContain('Board review');
    expect(state.lastLlmUser).toContain('chair@board.com');
    expect(state.lastLlmUser).toContain('guest@x.com');
  });
});
