/**
 * DEF-329 — `email-derivation-consumer-dark`: a dead judgement dependency
 * must not look like a quiet fortnight.
 *
 * Measured outage: provider 403 ("requires billing", project tmcai-491811)
 * from 2026-09-29 08:36 to 10-02+, all three channels at once (one shared
 * credential). Every row stayed `new` per the DEF-246 retry contract, the
 * sweep summary printed `errors: 0` throughout, and 481 inbound events
 * accumulated with no reply anywhere for a chat log to catch — invisible by
 * construction. Guardrail: no-claim-without-a-receipt, applied to the
 * consumer's own health.
 *
 * Under test, on the production shapes:
 *  - a sweep where every judgement fails carries the receipt
 *    (`judgementFailures`), and rows still stay `new` — the retry contract
 *    is not weakened;
 *  - after OUTAGE_SWEEP_THRESHOLD(4) consecutive full-failure sweeps the
 *    alarm fires ONCE through the canonical outbound chokepoint, carrying
 *    the provider's own error text and the waiting-row count;
 *  - a fifth failing sweep inside the 24h window does NOT re-alert;
 *  - one successful judgement RESETS the latch (mutation check: without the
 *    reset, the post-recovery alarm would fire early);
 *  - a quiet sweep (nothing attempted) neither advances nor resets.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

const state = {
  rows: [] as any[],
  eventUpdates: [] as Array<{ id: string; data: any }>,
  itemCreates: [] as any[],
  alerts: [] as any[],
  judgement: null as any,
  judgeThrows: true,
  waitingCount: 7,
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
        findMany: async () => state.rows,
        update: async (args: any) => { state.eventUpdates.push({ id: args.where.id, data: args.data }); return {}; },
        count: async () => state.waitingCount,
      },
      openItem: {
        findMany: async () => [],
        create: async (args: any) => { state.itemCreates.push(args.data); return { id: 'item-1' }; },
      },
      user: {
        findFirst: async () => ({ email: 'haseeb@tmcltd.com', integrationEmail: null }),
      },
    },
    { get: (t: any, k: string) => (k in t ? t[k] : empty) },
  );
  return { __esModule: true, default: p, prisma: p };
});

vi.mock('../src/services/geminiService', () => ({
  __esModule: true,
  callGemini: async () => {
    if (state.judgeThrows) {
      throw new Error('This API method requires billing to be enabled. Please enable billing on project #tmcai-491811');
    }
    return { text: JSON.stringify(state.judgement) };
  },
}));

vi.mock('../src/services/openItems/openItemGate', () => ({
  __esModule: true,
  gateOpenItemCreate: async () => ({
    block: false, status: 'NEW', delegateeId: null, delegateeName: null, delegateeEmail: null, missingSlots: [],
  }),
}));

vi.mock('../src/services/behaviorConfig', () => ({
  __esModule: true,
  getBehaviorValue: async (key: string) => {
    if (key in state.behavior) return state.behavior[key];
    throw new Error(`unknown behavior key ${key}`);
  },
}));

vi.mock('../src/services/notifications/brainOutboundService', () => ({
  __esModule: true,
  brainContactsUser: async (req: any) => { state.alerts.push(req); return { sent: true, channelsUsed: ['whatsapp'], waMessageIds: [] }; },
}));

import { runEmailItemDerivation, resetDerivationLiveness } from '../src/jobs/emailItemDerivationJob';

const inboundRow = (over: Record<string, unknown> = {}) => ({
  id: 'fe-1',
  clientNumber: 'TMC-0001',
  userId: 2,
  sourceId: 'gmail-msg-1',
  sourceType: 'gmail',
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

describe('DEF-329 — a dead judgement dependency alarms instead of printing healthy sweeps', () => {
  beforeEach(() => {
    resetDerivationLiveness();
    state.rows = [inboundRow()];
    state.eventUpdates = [];
    state.itemCreates = [];
    state.alerts = [];
    state.judgeThrows = true;
    state.judgement = null;
    state.waitingCount = 7;
  });

  it('a full-failure sweep carries the receipt: judgementFailures counted, rows untouched (retry contract intact)', async () => {
    state.rows = [inboundRow({ id: 'fe-1' }), inboundRow({ id: 'fe-2', sourceId: 'gmail-msg-2' })];
    const out = await runEmailItemDerivation();
    expect(out.judgementFailures).toBe(2);
    expect(out.errors).toBe(0); // hard errors are a different receipt — unchanged
    expect(state.eventUpdates).toEqual([]); // no status write — rows stay `new`
    expect(state.itemCreates).toEqual([]); // never a guessed item
    expect(state.alerts).toEqual([]); // one sweep is not an outage
  });

  it('the alarm fires once at the 4th consecutive full-failure sweep, through the chokepoint, carrying the provider error — and not again inside 24h', async () => {
    for (let i = 0; i < 3; i += 1) await runEmailItemDerivation();
    expect(state.alerts).toEqual([]); // below threshold — one flaky hour never alarms

    await runEmailItemDerivation(); // 4th
    expect(state.alerts.length).toBe(1);
    const alert = state.alerts[0];
    expect(alert.kind).toBe('derivation_judgement_outage');
    expect(alert.urgency).toBe('high');
    expect(alert.userId).toBe(2);
    expect(alert.clientNumber).toBe('TMC-0001');
    expect(alert.body).toContain('requires billing'); // the provider's own fact rides the alarm
    expect(alert.body).toContain('7 inbound'); // the waiting-row count is the receipt
    expect(alert.dedupKey).toBe('derivation_judgement_outage');

    await runEmailItemDerivation(); // 5th — inside the 24h window
    expect(state.alerts.length).toBe(1); // no re-alert spam
  });

  it('one successful judgement resets the latch — the counter starts over after recovery', async () => {
    await runEmailItemDerivation();
    await runEmailItemDerivation(); // two failures

    state.judgeThrows = false;
    state.judgement = ACTIONABLE;
    const ok = await runEmailItemDerivation(); // recovery: judged, item created
    expect(ok.created).toBe(1);
    expect(ok.judgementFailures).toBe(0);

    state.judgeThrows = true;
    for (let i = 0; i < 3; i += 1) await runEmailItemDerivation();
    expect(state.alerts).toEqual([]); // 3 < threshold — reset really happened

    await runEmailItemDerivation(); // 4th post-recovery failure
    expect(state.alerts.length).toBe(1);
  });

  it('a quiet sweep (nothing attempted) neither advances nor resets the latch', async () => {
    for (let i = 0; i < 3; i += 1) await runEmailItemDerivation(); // 3 failures

    state.rows = []; // quiet tick — no inbound in window
    const quiet = await runEmailItemDerivation();
    expect(quiet.judgementFailures).toBe(0);
    expect(state.alerts).toEqual([]); // did not advance to threshold

    state.rows = [inboundRow()];
    await runEmailItemDerivation(); // 4th actual failure
    expect(state.alerts.length).toBe(1); // did not reset either
  });
});
