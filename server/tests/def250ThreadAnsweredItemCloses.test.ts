/**
 * DEF-250 — `thread-answered-but-item-open`: a later email on an item's own
 * thread reconciles the item, instead of leaving it chasing what was already
 * delivered.
 *
 * The lived fixture: Safi Ullah delivered the DAL API on 08-24 05:56; Brain
 * minted "Share DAL Open API to Basit" on 08-26 — two days after delivery —
 * and asked the owner for a deadline on it. And the GCP/Imperial thread's
 * continuation was `skipped` by the noise path, so reconciliation could not
 * even see it — which is why reconciliation runs FIRST here.
 *
 * Under test:
 *  - fulfilment: the MODEL judges `fulfils` → the CANONICAL lifecycle close
 *    runs with the model's note as the resolution reason, the item carries
 *    the receipt, the event exits `new` as `processed`, and NO new item is
 *    minted;
 *  - a REFUSED close (lifecycle guard/approval) falls back to annotation —
 *    never a forced status write;
 *  - `advances` annotates without closing;
 *  - `unrelated` falls through to the normal noise/actionability flow;
 *  - no same-thread item → zero reconciliation cost (no extra LLM call);
 *  - a failed judgement leaves the event `new` for retry.
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
  llmQueue: [] as any[],           // shift()ed per call — reconciliation first, then actionability
  llmCalls: 0,
  llmThrows: false,
  transitions: [] as Array<{ id: string; to: string; reason?: string }>,
  transitionResult: { ok: true } as { ok: boolean; error?: string },
  gateResult: { block: false, status: 'NEW', delegateeId: null, delegateeName: null, delegateeEmail: null, missingSlots: [] } as any,
  behavior: { 'comm.email_item_derivation_enabled': 1, 'comm.email_item_derivation_batch': 5 } as Record<string, number>,
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
        findMany: async (args: any) =>
          // DEF-253 — the candidates query is multi-channel now; discriminate
          // on the status filter, which only the candidates query carries.
          (args?.where?.status === 'new' ? state.rows : state.srcEvents),
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
  callGemini: async () => {
    state.llmCalls += 1;
    if (state.llmThrows) throw new Error('llm down');
    return { text: JSON.stringify(state.llmQueue.shift() ?? { actionable: false, reason: 'default' }) };
  },
}));

vi.mock('../src/services/itemLifecycle/lifecycleService', () => ({
  __esModule: true,
  transitionStatus: async (id: string, to: string, opts: any) => {
    state.transitions.push({ id, to, reason: opts?.reason });
    return state.transitionResult;
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

const DAL_ITEM = {
  id: 'item-dal',
  title: 'Share DAL Open API to Basit',
  description: 'DAL to provide the Open API details',
  status: 'NEW',
  sourceFeedEventId: 'fe-origin',
  metadata: {},
};

const deliveryRow = (over: Record<string, unknown> = {}) => ({
  id: 'fe-delivery',
  clientNumber: 'TMC-0001',
  userId: 2,
  sourceId: 'gmail-msg-delivery',
  senderEmail: 'safi.ullah@dal.com',
  createdAt: new Date(),
  rawPayload: {
    threadId: 'thread-dal',
    subject: 'Re: DAL Open API',
    from: 'Safi Ullah <safi.ullah@dal.com>',
    snippet: 'Please find the Open API documentation and keys attached, as requested.',
  },
  ...over,
});

describe('DEF-250 — a later email on the thread reconciles the item', () => {
  beforeEach(() => {
    state.rows = [];
    state.eventUpdates = [];
    state.itemCreates = [];
    state.itemUpdates = [];
    state.activeItems = [DAL_ITEM];
    state.srcEvents = [{ id: 'fe-origin', rawPayload: { threadId: 'thread-dal' } }];
    state.llmQueue = [];
    state.llmCalls = 0;
    state.llmThrows = false;
    state.transitions = [];
    state.transitionResult = { ok: true };
    state.gateResult = { block: false, status: 'NEW', delegateeId: null, delegateeName: null, delegateeEmail: null, missingSlots: [] };
    state.behavior = { 'comm.email_item_derivation_enabled': 1, 'comm.email_item_derivation_batch': 5 };
  });

  it('the DAL fixture: fulfilment closes the item through the canonical lifecycle, with receipts', async () => {
    state.rows = [deliveryRow()];
    state.llmQueue = [{ relation: 'fulfils', note: 'Safi Ullah delivered the Open API docs and keys' }];
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    const out = await runEmailItemDerivation();
    expect(out.reconciled).toBe(1);
    expect(state.transitions).toEqual([
      { id: 'item-dal', to: 'CLOSED', reason: 'Safi Ullah delivered the Open API docs and keys' },
    ]);
    // The receipt rides the item…
    const receipt = state.itemUpdates.find((u) => u.id === 'item-dal');
    expect(receipt?.data.metadata.threadUpdates[0]).toMatchObject({
      feedEventId: 'fe-delivery', relation: 'fulfils', closed: true,
    });
    // …the event exits `new` as processed, and NO new item was minted.
    expect(state.eventUpdates.find((u) => u.id === 'fe-delivery')?.data.status).toBe('processed');
    expect(state.itemCreates).toHaveLength(0);
    expect(state.llmCalls).toBe(1); // reconciliation only — no actionability judgement
  });

  it('a REFUSED close falls back to annotation — never a forced write', async () => {
    state.rows = [deliveryRow()];
    state.llmQueue = [{ relation: 'fulfils', note: 'delivered' }];
    state.transitionResult = { ok: false, error: 'requires approval' };
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    const out = await runEmailItemDerivation();
    expect(out.reconciled).toBe(1);
    const receipt = state.itemUpdates.find((u) => u.id === 'item-dal');
    expect(receipt?.data.metadata.threadUpdates[0]).toMatchObject({ relation: 'fulfils', closed: false });
    expect(state.eventUpdates.find((u) => u.id === 'fe-delivery')?.data.status).toBe('processed');
  });

  it('`advances` annotates without closing', async () => {
    state.rows = [deliveryRow()];
    state.llmQueue = [{ relation: 'advances', note: 'partial docs shared, keys to follow' }];
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    const out = await runEmailItemDerivation();
    expect(out.reconciled).toBe(1);
    expect(state.transitions).toHaveLength(0);
    expect(state.itemUpdates.find((u) => u.id === 'item-dal')?.data.metadata.threadUpdates[0])
      .toMatchObject({ relation: 'advances', closed: false });
  });

  it('`unrelated` falls through to the normal actionability flow', async () => {
    state.rows = [deliveryRow()];
    state.llmQueue = [
      { relation: 'unrelated' },
      { actionable: false, reason: 'no ask' },
    ];
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    const out = await runEmailItemDerivation();
    expect(out.reconciled).toBe(0);
    expect(state.llmCalls).toBe(2); // reconciliation, then actionability
    expect(state.transitions).toHaveLength(0);
  });

  it('no same-thread item → zero reconciliation cost', async () => {
    state.activeItems = [];
    state.rows = [deliveryRow()];
    state.llmQueue = [{ actionable: false, reason: 'no ask' }];
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    await runEmailItemDerivation();
    expect(state.llmCalls).toBe(1); // actionability only
  });

  it('a failed judgement leaves the event `new` for retry — no receipt, no close', async () => {
    state.rows = [deliveryRow()];
    state.llmThrows = true;
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    const out = await runEmailItemDerivation();
    expect(out.reconciled).toBe(0);
    expect(state.transitions).toHaveLength(0);
    expect(state.eventUpdates).toHaveLength(0);
  });
});
