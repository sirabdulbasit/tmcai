/**
 * DEF-246 — "Derive actionable or open items from each email arrive and add
 * them" (owner, verbatim, S20/S23). Before this job: gmail 2,621 received /
 * 0 processed, while Brain claimed the capability existed (DEF-243 stopped
 * the claim; this builds the thing).
 *
 * Under test, on the production shapes:
 *  - an actionable email → judged by the MODEL, created through the canonical
 *    gate (sourceFeedEventId + idempotencyKey carried), row → processed;
 *  - a non-actionable email → row → skipped, NO item;
 *  - a failed judgement → row stays `new` (retried), NO item, NO status write;
 *  - a gate-blocked duplicate → row → skipped, NO second item;
 *  - the owner's own outbound mail → skipped without an LLM call;
 *  - tenant flag 0 → nothing judged, nothing written;
 *  - the pre-existing backlog: the query window is 48h, so old rows are not
 *    selected (asserted on the where clause the job issues).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

const state = {
  rows: [] as any[],
  lastFindManyArgs: null as any,
  eventUpdates: [] as Array<{ id: string; data: any }>,
  itemCreates: [] as any[],
  judgement: null as any,
  judgeThrows: false,
  judgeCalls: 0,
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
        findMany: async (args: any) => { state.lastFindManyArgs = args; return state.rows; },
        update: async (args: any) => { state.eventUpdates.push({ id: args.where.id, data: args.data }); return {}; },
      },
      openItem: {
        create: async (args: any) => { state.itemCreates.push(args.data); return { id: 'item-1' }; },
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
    state.judgeCalls += 1;
    if (state.judgeThrows) throw new Error('llm down');
    return { text: JSON.stringify(state.judgement) };
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

const inboundRow = (over: Record<string, unknown> = {}) => ({
  id: 'fe-1',
  clientNumber: 'TMC-0001',
  userId: 2,
  sourceId: 'gmail-msg-1',
  senderEmail: 'asad.ahmed@tmcltd.com',
  createdAt: new Date(),
  rawPayload: {
    subject: 'Please approve the Fujairah pricing today',
    from: 'Asad Ahmed <asad.ahmed@tmcltd.com>',
    snippet: 'Sir, the revised pricing needs your approval before we send it to Latif.',
  },
  ...over,
});

const ACTIONABLE = {
  actionable: true,
  title: 'Approve the revised Fujairah pricing',
  description: 'Asad needs approval before sending to Latif',
  priority: 'high',
  dueDateISO: null,
  reason: 'direct approval request',
};

describe('DEF-246 — items derive from arriving email, with receipts', () => {
  beforeEach(() => {
    state.rows = [];
    state.lastFindManyArgs = null;
    state.eventUpdates = [];
    state.itemCreates = [];
    state.judgement = ACTIONABLE;
    state.judgeThrows = false;
    state.judgeCalls = 0;
    state.gateResult = { block: false, status: 'NEW', delegateeId: null, delegateeName: null, delegateeEmail: null, missingSlots: [] };
    state.behavior = { 'comm.email_item_derivation_enabled': 1, 'comm.email_item_derivation_batch': 5 };
  });

  it('an actionable email becomes an item through the gate, and the row is receipted processed', async () => {
    state.rows = [inboundRow()];
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    const out = await runEmailItemDerivation();
    expect(out.created).toBe(1);
    const item = state.itemCreates[0];
    expect(item.title).toBe('Approve the revised Fujairah pricing');
    expect(item.sourceFeedEventId).toBe('fe-1');
    expect(item.idempotencyKey).toBe('email_derive:fe-1');
    expect(item.clientNumber).toBe('TMC-0001');
    expect(item.userId).toBe(2);
    const upd = state.eventUpdates.find((u) => u.id === 'fe-1');
    expect(upd?.data.status).toBe('processed');
  });

  it('a non-actionable email is receipted skipped, and NO item exists', async () => {
    state.rows = [inboundRow()];
    state.judgement = { actionable: false, reason: 'newsletter' };
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    const out = await runEmailItemDerivation();
    expect(out.skippedNotActionable).toBe(1);
    expect(state.itemCreates).toHaveLength(0);
    expect(state.eventUpdates[0]?.data.status).toBe('skipped');
  });

  it('a failed judgement leaves the row `new` — no item, no status write, retried next tick', async () => {
    state.rows = [inboundRow()];
    state.judgeThrows = true;
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    const out = await runEmailItemDerivation();
    expect(out.created).toBe(0);
    expect(state.itemCreates).toHaveLength(0);
    expect(state.eventUpdates).toHaveLength(0);
  });

  it('a gate-blocked duplicate is receipted skipped — never a second row', async () => {
    state.rows = [inboundRow()];
    state.gateResult = { ...state.gateResult, block: true, reason: 'duplicate', duplicateOfId: 'item-9' };
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    const out = await runEmailItemDerivation();
    expect(out.skippedDuplicate).toBe(1);
    expect(state.itemCreates).toHaveLength(0);
    expect(state.eventUpdates[0]?.data.status).toBe('skipped');
  });

  it('DEF-247 — a no-reply sender is skipped BEFORE any LLM judgement, with the receipt', async () => {
    state.rows = [inboundRow({ senderEmail: 'no-reply-ctb0dubtzwoslyip@mail.anthropic.com' })];
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    const out = await runEmailItemDerivation();
    expect(state.judgeCalls).toBe(0);          // the newsletter never costs a judgement
    expect(state.itemCreates).toHaveLength(0); // and never becomes an item
    expect(state.eventUpdates[0]?.data.status).toBe('skipped');
    expect(out.skippedNotActionable).toBe(1);
  });

  it("the owner's own outbound mail is skipped WITHOUT an LLM call", async () => {
    state.rows = [inboundRow({ senderEmail: 'haseeb@tmcltd.com' })];
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    await runEmailItemDerivation();
    expect(state.judgeCalls).toBe(0);
    expect(state.eventUpdates[0]?.data.status).toBe('skipped');
    expect(state.itemCreates).toHaveLength(0);
  });

  it('tenant flag 0 → nothing judged, nothing written', async () => {
    state.rows = [inboundRow()];
    state.behavior['comm.email_item_derivation_enabled'] = 0;
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    const out = await runEmailItemDerivation();
    expect(state.judgeCalls).toBe(0);
    expect(state.eventUpdates).toHaveLength(0);
    expect(out.created + out.drafted).toBe(0);
  });

  it('the batch cap bounds LLM spend per tenant per tick', async () => {
    state.behavior['comm.email_item_derivation_batch'] = 2;
    state.rows = [inboundRow(), inboundRow({ id: 'fe-2' }), inboundRow({ id: 'fe-3' })];
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    await runEmailItemDerivation();
    expect(state.judgeCalls).toBe(2);
  });

  it('the backlog is protected: the query window is 48h on gmail status:new', async () => {
    const { runEmailItemDerivation } = await import('../src/jobs/emailItemDerivationJob');
    await runEmailItemDerivation();
    const where = state.lastFindManyArgs?.where;
    expect(where.sourceType).toBe('gmail');
    expect(where.status).toBe('new');
    const gte = where.createdAt?.gte as Date;
    const ageHours = (Date.now() - gte.getTime()) / (60 * 60 * 1000);
    expect(ageHours).toBeGreaterThan(47);
    expect(ageHours).toBeLessThan(49);
  });
});
