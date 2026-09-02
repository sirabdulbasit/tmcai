/**
 * DEF-277 · C-3 increment 2 — a held notification leaves a receipt.
 *
 * CL-043, measured on production: four people's messages arrived in one
 * morning; two were relayed, two were suppressed by the daily cap — silently.
 * The owner had to ask: *"it sent multple messages and brain only notify me 2
 * messages"*. The budget worked; the silence around it was the defect.
 *
 * The fix, proven here through the REAL `brainContactsUser` chokepoint (the
 * def174 harness pattern — no re-implementation):
 *   1. a budget suppression stamps WHY on its audit row,
 *   2. the first budget hold of a window triggers ONE digest naming the count,
 *   3. the digest kind is exempt from the caps it reports on — and from
 *      nothing else (dedup, rate limit, quiet hours, opt-in all still bind),
 *   4. wording goes through the model; the curated fallback carries the same
 *      facts and fires only when the model is unreachable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const waSent = vi.hoisted(() => [] as Array<{ body: string }>);
const state = vi.hoisted(() => ({
  // rows returned for the digest's held-count query
  heldRows: [] as Array<{ kind: string; summary: string }>,
  // sent/partial count in the 24h window → drives the daily cap
  sentToday: 0,
  // captured audit rows
  created: [] as any[],
  // dedup hit for the digest kind
  dedupDup: false,
  llmThrows: false,
  llmText: 'I held a few notifications today — your volume budget filled. Nothing was dropped; ask me and I will show you any of them.',
  llmCalls: 0,
}));

vi.mock('../src/db/prisma', () => {
  const brainUserMessage = {
    findFirst: async ({ where }: any) => {
      if (where?.dedupKey) {
        return state.dedupDup ? { id: 'dup', createdAt: new Date(Date.now() - 60 * 60_000) } : null;
      }
      return null; // no fingerprint dup, no recent same-kind send
    },
    findMany: async ({ where }: any) => {
      // The digest's held query is the only findMany with a metadata path.
      if (where?.metadata?.path?.[0] === 'suppressedBy') return state.heldRows;
      return [];
    },
    count: async ({ where }: any) => {
      // kind-scoped counts are the tier reads; the bare one is the daily cap.
      if (where?.kind) return 0;
      return state.sentToday;
    },
    create: async ({ data }: any) => { state.created.push(data); return { id: `rec-${state.created.length}` }; },
  };
  const model = {
    findUnique: async (args: any) => (args?.where?.clientNumber
      ? { name: 'TallyMarks Consulting', domain: 'tmcltd.com' }
      : {
        id: 2, name: 'Basit Ahmed', email: 'basit.ahmed@tmcltd.ai',
        clientNumber: 'TMC-0001', isActive: true, contactNumber: '+923000000000',
        notificationPreferences: {
          profile: { preferredTitle: 'Sir' },
          brain_channel: { outboundEnabled: true, outboundPaused: false, timezone: 'UTC' },
        },
      }),
    findFirst: async (args: any) => (
      args?.where?.id === 2 && args?.where?.clientNumber === 'TMC-0001'
        ? (await model.findUnique({ where: { id: 2 } } as any)) : null),
    findMany: async () => [], create: async () => ({ id: 'x' }), update: async () => ({}),
    updateMany: async () => ({ count: 0 }), upsert: async () => ({}), count: async () => 0,
    aggregate: async () => ({}), groupBy: async () => [],
  };
  const p: any = new Proxy(
    { brainUserMessage, $queryRaw: async () => [], $queryRawUnsafe: async () => [], $executeRaw: async () => 0, $executeRawUnsafe: async () => 0 },
    { get: (t: any, k: string) => (k in t ? t[k] : model) },
  );
  return { __esModule: true, default: p, prisma: p };
});

vi.mock('../src/services/notifications/tenantWhatsappSender', () => ({
  sendTenantWhatsAppText: async (_c: string, _p: string, body: string) => {
    waSent.push({ body });
    return { ok: true, waMessageId: `wa-${waSent.length}` };
  },
  sendTenantWhatsAppVoiceNote: async () => ({ ok: true, waMessageId: 'wa-v' }),
}));

// The DEF-120 office-hours gate (default 9–18 in the user's tz) would hold a
// low-urgency digest in any test run outside office hours — correct product
// behaviour (the receipt waits for the working day; the dedup key is not
// burned because dedup counts only sent/partial). The tests open the office
// so the send path itself is what is proven.
vi.mock('../src/services/behaviorConfig', () => ({
  getBehaviorValue: async (key: string) => {
    if (key === 'notify.office_start_hour') return 0;
    if (key === 'notify.office_end_hour') return 24;
    if (key === 'notify.office_days_mask') return 127;
    return 50; // tier budget pcts and anything else: defaults
  },
}));

vi.mock('../src/services/llmRouter', () => ({
  callLLM: async () => {
    state.llmCalls += 1;
    if (state.llmThrows) throw new Error('model unreachable');
    return { text: state.llmText };
  },
}));

import {
  brainContactsUser,
  maybeSendSuppressionDigest,
  SUPPRESSION_DIGEST_KIND,
} from '../src/services/notifications/brainOutboundService';

// A settle helper: the digest is fired void (off the caller's path); give the
// microtask queue a few turns before asserting.
const until = async (pred: () => boolean, ms = 8000) => {
  // The void-fired digest's first run pays the dynamic import of the persona
  // renderer (brainComposer) — poll a condition rather than guess a delay.
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
};

beforeEach(() => {
  waSent.length = 0;
  state.heldRows = [];
  state.sentToday = 0;
  state.created = [];
  state.dedupDup = false;
  state.llmThrows = false;
  state.llmCalls = 0;
});

describe('DEF-277 — a budget suppression stamps WHY on its audit row', () => {
  it('the daily-cap hold carries suppressedBy=budget and its reason', async () => {
    state.sentToday = 200; // over any cap
    const res = await brainContactsUser({
      userId: 2, clientNumber: 'TMC-0001', kind: 'wa_counterpart_message',
      summary: 'Hamna messaged you', body: 'msg', urgency: 'normal',
    });
    expect(res.sent).toBe(false);
    const row = state.created.find((r) => r.kind === 'wa_counterpart_message');
    expect(row.status).toBe('suppressed');
    // Mutation: dropping the stamp dies here AND starves the digest query.
    expect(row.metadata.suppressedBy).toBe('budget');
    expect(row.metadata.suppressReason).toBe('daily_cap_exceeded');
  });
});

describe('DEF-277 — the hold triggers ONE digest through the real chokepoint', () => {
  it('CL-043 shape: a capped counterpart message produces a digest naming the count', async () => {
    state.sentToday = 200;
    state.heldRows = [
      { kind: 'wa_counterpart_message', summary: 'Hlo — unknown sender' },
      { kind: 'wa_counterpart_message', summary: 'Ma thak — unknown sender' },
      { kind: 'open_item_draft_ask', summary: 'deadline for Join Google Meet call' },
    ];
    await brainContactsUser({
      userId: 2, clientNumber: 'TMC-0001', kind: 'wa_counterpart_message',
      summary: 'Kdr ho — unknown sender', body: 'Kdr ho', urgency: 'normal',
    });
    await until(() => state.created.some((r) => r.kind === SUPPRESSION_DIGEST_KIND && r.status === 'sent'));
    // The suppressed push did NOT reach WhatsApp; the digest DID.
    expect(waSent).toHaveLength(1);
    expect(waSent[0].body).toBe(state.llmText); // the model's words, not a template
    const digestRow = state.created.find((r) => r.kind === SUPPRESSION_DIGEST_KIND);
    expect(digestRow.status).toBe('sent');
    expect(digestRow.metadata.heldCount).toBe(3);
    expect(digestRow.metadata.byKind.wa_counterpart_message).toBe(2);
  });

  it('the digest passes the daily cap that suppressed everything else — and ONLY that', async () => {
    state.sentToday = 200; // cap full: the digest itself must still go
    state.heldRows = [{ kind: 'brain_prompt', summary: 'x' }];
    await maybeSendSuppressionDigest({ id: 2, clientNumber: 'TMC-0001' });
    expect(waSent).toHaveLength(1);
  });

  it('ONE per window by construction: a dedup hit holds the second digest', async () => {
    state.sentToday = 200;
    state.heldRows = [{ kind: 'brain_prompt', summary: 'x' }];
    state.dedupDup = true; // today's digest already sent
    await maybeSendSuppressionDigest({ id: 2, clientNumber: 'TMC-0001' });
    expect(waSent).toHaveLength(0);
    const row = state.created.find((r) => r.kind === SUPPRESSION_DIGEST_KIND);
    expect(row.status).toBe('suppressed'); // held by dedup, recorded, no loop
  });

  it('a digest suppression never triggers another digest — no recursion', async () => {
    state.sentToday = 200;
    state.heldRows = [{ kind: 'brain_prompt', summary: 'x' }];
    state.dedupDup = true;
    await maybeSendSuppressionDigest({ id: 2, clientNumber: 'TMC-0001' });
    await new Promise((r) => setTimeout(r, 300)); // nothing SHOULD happen; give it room to happen wrongly
    // Exactly one audit row for the digest attempt; nothing cascaded.
    expect(state.created.filter((r) => r.kind === SUPPRESSION_DIGEST_KIND)).toHaveLength(1);
  });

  it('nothing held → no digest, no send, no row', async () => {
    state.heldRows = [];
    await maybeSendSuppressionDigest({ id: 2, clientNumber: 'TMC-0001' });
    expect(waSent).toHaveLength(0);
    expect(state.created).toHaveLength(0);
  });
});

describe('DEF-277 — wording belongs to the model; the fallback only carries facts', () => {
  it('the model composes the digest when reachable', async () => {
    state.heldRows = [{ kind: 'brain_prompt', summary: 'x' }];
    await maybeSendSuppressionDigest({ id: 2, clientNumber: 'TMC-0001' });
    expect(state.llmCalls).toBe(1);
    expect(waSent[0].body).toBe(state.llmText);
  });

  it('model unreachable → the curated fallback still names the exact counts', async () => {
    state.llmThrows = true;
    state.heldRows = [
      { kind: 'wa_counterpart_message', summary: 'a' },
      { kind: 'wa_counterpart_message', summary: 'b' },
    ];
    await maybeSendSuppressionDigest({ id: 2, clientNumber: 'TMC-0001' });
    expect(waSent).toHaveLength(1);
    expect(waSent[0].body).toContain('2 notification(s)');
    expect(waSent[0].body).toContain('wa_counterpart_message: 2');
    expect(waSent[0].body).toContain('Nothing was dropped');
  });
});
