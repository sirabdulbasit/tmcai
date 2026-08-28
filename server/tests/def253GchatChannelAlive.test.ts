/**
 * DEF-253 — the gchat channel comes alive, through the SAME consumer.
 *
 * The measured absence: gchat sat at 294 received / 0 EVER processed — the
 * owner's own "TMC Leadership - Service Delivery" messages at `status: new`
 * as of 04:45 on 08-28 — while Brain claimed (S19) to review incoming
 * messages across channels. Every other channel had a consumer; a SECOND
 * per-channel job would be `protection-with-two-implementations` (10 deep),
 * so gchat joins `emailItemDerivationJob` and inherits the noise gate, the
 * batch cap, thread reconciliation and the receipts.
 *
 * Under test, on the leadership-space fixture:
 *  - an actionable chat message becomes an item (sourceFeed 'gchat', display
 *    name as sender, full text judged), row receipted `processed`;
 *  - smalltalk → `skipped`, no item;
 *  - the chat kill switch (0) silences chat while gmail keeps flowing —
 *    per-channel switches, one consumer;
 *  - a chat reply on a thread with an ACTIVE gchat item reconciles it
 *    (DEF-250 inherited, `threadName` as the key);
 *  - gmail rows in the same sweep are untouched by any of this (regression).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

const state = {
  rows: [] as any[],
  eventUpdates: [] as Array<{ id: string; data: any }>,
  itemCreates: [] as any[],
  itemUpdates: [] as Array<{ id: string; data: any }>,
  activeItems: [] as any[],
  srcEvents: [] as any[],
  llmQueue: [] as any[],
  llmCalls: 0,
  transitions: [] as Array<{ id: string; to: string; reason?: string }>,
  gateResult: { block: false, status: 'NEW', delegateeId: null, delegateeName: null, delegateeEmail: null, missingSlots: [] } as any,
  behavior: {
    'comm.email_item_derivation_enabled': 1,
    'comm.chat_item_derivation_enabled': 1,
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
          // Emulate the sourceType filter — without this, a gmail-only query
          // mutation would still "return" chat rows and the suite could not
          // catch the channel being dropped from the query.
          const st = args.where.sourceType;
          const allowed: string[] | null = typeof st === 'string' ? [st] : (st?.in ?? null);
          return allowed ? state.rows.filter((r: any) => allowed.includes(r.sourceType)) : state.rows;
        },
        update: async (args: any) => { state.eventUpdates.push({ id: args.where.id, data: args.data }); return {}; },
      },
      openItem: {
        findMany: async () => state.activeItems,
        create: async (args: any) => { state.itemCreates.push(args.data); return { id: 'item-new' }; },
        update: async (args: any) => { state.itemUpdates.push({ id: args.where.id, data: args.data }); return {}; },
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
  callGemini: async (_s: string, user: string) => {
    state.llmCalls += 1;
    const next = state.llmQueue.shift() ?? { actionable: false, reason: 'default' };
    (next as any)._sawUser = user; // captured for the full-text assertion
    return { text: JSON.stringify(next), _user: user } as any;
  },
}));

vi.mock('../src/services/itemLifecycle/lifecycleService', () => ({
  __esModule: true,
  transitionStatus: async (id: string, to: string, opts: any) => {
    state.transitions.push({ id, to, reason: opts?.reason });
    return { ok: true };
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

const chatRow = (over: Record<string, unknown> = {}) => ({
  id: 'fe-chat-1',
  clientNumber: 'TMC-0001',
  userId: 2,
  sourceId: 'spaces/AAA/messages/BBB',
  sourceType: 'gchat',
  senderEmail: null,
  createdAt: new Date(),
  rawPayload: {
    subject: 'TMC Leadership - Service Delivery',
    spaceDisplayName: 'TMC Leadership - Service Delivery',
    senderDisplayName: 'Madeeha Rahat',
    threadName: 'spaces/AAA/threads/T1',
    text: 'Sir, we need your approval on the Q3 service delivery escalation matrix before Friday.',
    snippet: 'Sir, we need your approval on the Q3 service delivery escala',
  },
  ...over,
});

const gmailRow = (over: Record<string, unknown> = {}) => ({
  id: 'fe-mail-1',
  clientNumber: 'TMC-0001',
  userId: 2,
  sourceId: 'gmail-msg-1',
  sourceType: 'gmail',
  senderEmail: 'asad.ahmed@tmcltd.com',
  createdAt: new Date(),
  rawPayload: {
    threadId: 'thread-x',
    subject: 'Approve the pricing',
    from: 'Asad Ahmed <asad.ahmed@tmcltd.com>',
    snippet: 'Needs your approval today.',
  },
  ...over,
});

const ACTIONABLE = {
  actionable: true,
  title: 'Approve the Q3 service delivery escalation matrix',
  description: 'Madeeha Rahat needs approval before Friday',
  priority: 'high',
  dueDateISO: null,
  reason: 'direct approval request in leadership space',
};

describe('DEF-253 — gchat messages flow through the shared consumer', () => {
  beforeEach(() => {
    state.rows = [];
    state.eventUpdates = [];
    state.itemCreates = [];
    state.itemUpdates = [];
    state.activeItems = [];
    state.srcEvents = [];
    state.llmQueue = [];
    state.llmCalls = 0;
    state.transitions = [];
    state.gateResult = { block: false, status: 'NEW', delegateeId: null, delegateeName: null, delegateeEmail: null, missingSlots: [] };
    state.behavior = {
      'comm.email_item_derivation_enabled': 1,
      'comm.chat_item_derivation_enabled': 1,
      'comm.email_item_derivation_batch': 5,
    };
  });

  it('the leadership fixture: an actionable chat message becomes an item, receipted', async () => {
    state.rows = [chatRow()];
    state.llmQueue = [ACTIONABLE];
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    const out = await runEmailItemDerivation();
    expect(out.created).toBe(1);
    const item = state.itemCreates[0];
    expect(item.sourceFeed).toBe('gchat');
    expect(item.sourceFeedEventId).toBe('fe-chat-1');
    expect(item.title).toBe('Approve the Q3 service delivery escalation matrix');
    expect(state.eventUpdates.find((u) => u.id === 'fe-chat-1')?.data.status).toBe('processed');
  });

  it('the judgement sees WHO spoke and the FULL text, not the 200-char snippet', async () => {
    state.rows = [chatRow()];
    state.llmQueue = [ACTIONABLE];
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    await runEmailItemDerivation();
    const seen = (ACTIONABLE as any)._sawUser as string;
    expect(seen).toContain('Madeeha Rahat');
    expect(seen).toContain('escalation matrix before Friday'); // beyond the snippet cut
  });

  it('chat smalltalk is skipped with a receipt, no item', async () => {
    state.rows = [chatRow()];
    state.llmQueue = [{ actionable: false, reason: 'greeting only' }];
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    const out = await runEmailItemDerivation();
    expect(out.skippedNotActionable).toBe(1);
    expect(state.itemCreates).toHaveLength(0);
    expect(state.eventUpdates[0]?.data.status).toBe('skipped');
  });

  it('the chat kill switch silences chat while gmail keeps flowing — one consumer, two switches', async () => {
    state.behavior['comm.chat_item_derivation_enabled'] = 0;
    state.rows = [chatRow(), gmailRow()];
    state.llmQueue = [ACTIONABLE];
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    const out = await runEmailItemDerivation();
    expect(out.created).toBe(1);
    expect(state.itemCreates[0].sourceFeed).toBe('gmail');
    expect(state.eventUpdates.find((u) => u.id === 'fe-chat-1')).toBeUndefined(); // untouched, stays new
  });

  it('a chat reply on a thread with an ACTIVE gchat item reconciles it — DEF-250 inherited', async () => {
    state.activeItems = [{
      id: 'item-esc', title: 'Approve the Q3 escalation matrix', description: null,
      status: 'NEW', sourceFeedEventId: 'fe-chat-0', metadata: {},
    }];
    state.srcEvents = [{ id: 'fe-chat-0', rawPayload: { threadName: 'spaces/AAA/threads/T1' } }];
    state.rows = [chatRow({ id: 'fe-chat-2', rawPayload: { ...chatRow().rawPayload, text: 'Approved — go ahead with the matrix as proposed.' } })];
    state.llmQueue = [{ relation: 'fulfils', note: 'Owner approved the escalation matrix in the thread' }];
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    const out = await runEmailItemDerivation();
    expect(out.reconciled).toBe(1);
    expect(state.transitions).toEqual([
      { id: 'item-esc', to: 'CLOSED', reason: 'Owner approved the escalation matrix in the thread' },
    ]);
    expect(state.eventUpdates.find((u) => u.id === 'fe-chat-2')?.data.status).toBe('processed');
  });
});
