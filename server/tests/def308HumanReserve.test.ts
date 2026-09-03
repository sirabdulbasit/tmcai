/**
 * DEF-308 — a person's message has a floor, not just competitors with ceilings.
 *
 * Third occurrence of one mechanism: Brain's own machinery spends the daily
 * outbound budget and a real person's message is dropped to pay for it.
 *
 *   DEF-104, 2026-08-08 — diagnostics took 3 of 20 while 104 of his real
 *                         overdue reminders were suppressed.
 *   DEF-271, 2026-09-01 — draft-asks took 10 of 20; 8 human messages held.
 *   DEF-308, 2026-09-03 — measured on production: of the owner's 20 sends that
 *                         day, 15 were `suppressed_pushes_digest`, 4 were
 *                         `brain_prompt` and 1 was `day_brief`. TEN
 *                         `wa_counterpart_message` rows carry
 *                         `suppressReason: 'daily_cap_exceeded'`. Ten people
 *                         wrote to him and he was told about none of them.
 *
 * The first two fixes each put a ceiling on whichever competitor had just won.
 * That cannot close the class: the competing set is OPEN, so the next untiered
 * kind is the next occurrence — and the digest, written 09-02, became one on
 * 09-03.
 *
 * So the test that matters here is not "the digest is capped". It is
 * **`a kind nobody has tiered, and nobody has thought about, cannot take a
 * person's slot`** — the assertion that fails if the fix ever regresses to
 * enumerating competitors again.
 *
 * Proven through the REAL `brainContactsUser` chokepoint (the def174/def277
 * harness pattern), never a re-implementation of the gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const waSent = vi.hoisted(() => [] as Array<{ body: string }>);
const state = vi.hoisted(() => ({
  /** kinds SENT inside the rolling 24h window — every count below is derived
   *  from this one list, so a test cannot set two counts into disagreement. */
  sent: [] as string[],
  created: [] as any[],
  reservePct: 25 as number,
  /** make the digest-window count throw, to prove the exemption fails closed */
  digestCountThrows: false,
}));

vi.mock('../src/db/prisma', () => {
  const brainUserMessage = {
    findFirst: async () => null,       // no dedup hit, no per-kind rate limit hit
    findMany: async () => [],          // the digest's held-rows query
    count: async ({ where }: any) => {
      const k = where?.kind;
      if (k === undefined) return state.sent.length;                          // daily cap
      if (typeof k === 'string') {                                            // digest window
        if (state.digestCountThrows) throw new Error('count failed');
        return state.sent.filter((x) => x === k).length;
      }
      if (k?.in) return state.sent.filter((x) => k.in.includes(x)).length;    // tier budgets
      if (k?.notIn) return state.sent.filter((x) => !k.notIn.includes(x)).length; // human reserve
      return 0;
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

// Office hours (DEF-120) would hold a low-urgency send outside 9–18 and make
// these results depend on the clock. Open the office so the BUDGET gate is
// what is being proven.
vi.mock('../src/services/behaviorConfig', () => ({
  getBehaviorValue: async (key: string) => {
    if (key === 'notify.office_start_hour') return 0;
    if (key === 'notify.office_end_hour') return 24;
    if (key === 'notify.office_days_mask') return 127;
    if (key === 'notify.human_reserve_pct') return state.reservePct;
    return 50; // tier budget pcts
  },
}));

vi.mock('../src/services/llmRouter', () => ({
  callLLM: async () => ({ text: 'held some notifications today' }),
}));

import {
  brainContactsUser,
  HUMAN_KINDS,
  SUPPRESSION_DIGEST_KIND,
  __resetSuppressionDigestClaimsForTests,
} from '../src/services/notifications/brainOutboundService';

/** Default cap is 20 and the reserve is 25% = 5, so non-human kinds stop at 15
 *  while five slots remain unspent. Stated as arithmetic, not a literal, so the
 *  tests still mean what they say if the default cap moves. */
const DAILY_CAP = 20;
const RESERVE = 5;
const NON_HUMAN_CAP = DAILY_CAP - RESERVE;

const fill = (kind: string, n: number) => { for (let i = 0; i < n; i += 1) state.sent.push(kind); };
const rowFor = (kind: string) => state.created.find((r) => r.kind === kind);

beforeEach(() => {
  __resetSuppressionDigestClaimsForTests();
  waSent.length = 0;
  state.sent = [];
  state.created = [];
  state.reservePct = 25;
  state.digestCountThrows = false;
});

describe('DEF-308 — the reserve is enforced on the COMPLEMENT of the protected set', () => {
  it('holds a kind nobody tiered and nobody anticipated', async () => {
    // THE anti-circling assertion. `some_kind_written_next_month` appears in no
    // tier, in no allow-list, and nowhere in the service — and it still cannot
    // spend a person's slot, because exclusion is the default rather than a
    // listing someone has to remember to update.
    //
    // Mutation: re-express the gate as an enumeration of competitors (e.g.
    // `if (DIAGNOSTIC_KINDS.has(k) || HOUSEKEEPING_KINDS.has(k))`) and this
    // test dies while every other budget test still passes — which is exactly
    // what happened to DEF-271's fix in production.
    fill('brain_prompt', NON_HUMAN_CAP);
    const res = await brainContactsUser({
      userId: 2, clientNumber: 'TMC-0001', kind: 'some_kind_written_next_month',
      summary: 'a kind that does not exist yet', body: 'x', urgency: 'normal',
    });
    expect(res.sent).toBe(false);
    expect(res.suppressedBy).toBe('budget');
    expect(rowFor('some_kind_written_next_month').metadata.suppressReason).toBe('human_reserve_protected');
  });

  it('holds `day_brief` — untiered, and the kind that helped spend the day on 09-03', async () => {
    fill('brain_prompt', NON_HUMAN_CAP);
    const res = await brainContactsUser({
      userId: 2, clientNumber: 'TMC-0001', kind: 'day_brief',
      summary: 'your day', body: 'x', urgency: 'normal',
    });
    expect(res.sent).toBe(false);
    expect(rowFor('day_brief').metadata.suppressReason).toBe('human_reserve_protected');
  });

  it('the held row is stamped so the suppression digest still counts it', async () => {
    // A hold the digest cannot see is DEF-277 undone: he would be told nothing
    // was held on the day ten people were dropped.
    fill('brain_prompt', NON_HUMAN_CAP);
    await brainContactsUser({
      userId: 2, clientNumber: 'TMC-0001', kind: 'day_brief',
      summary: 'your day', body: 'x', urgency: 'normal',
    });
    const row = rowFor('day_brief');
    expect(row.status).toBe('suppressed');
    expect(row.metadata.suppressedBy).toBe('budget');
  });
});

describe('DEF-308 — the reserve is USABLE, not merely a refusal', () => {
  it('delivers a human message in the exact state that refuses everything else', async () => {
    // The state of production on 09-03 with the digest bug removed: the
    // machinery has spent its allowance and stops; the person gets through.
    //
    // Mutation: drop `!HUMAN_KINDS.has(req.kind)` from the gate and this dies —
    // the reserve would refuse the very messages it exists to protect.
    fill('brain_prompt', NON_HUMAN_CAP);
    const res = await brainContactsUser({
      userId: 2, clientNumber: 'TMC-0001', kind: 'wa_counterpart_message',
      summary: 'Hamna messaged you', body: 'Assalam o alaikum', urgency: 'normal',
    });
    expect(res.sent).toBe(true);
    expect(waSent).toHaveLength(1);
  });

  it('CL-043 shape, replayed: ten people arrive after the machinery is done', async () => {
    // Ten inbound relays against a spent non-human budget. The five the reserve
    // holds MUST arrive; the rest stop at the hard cap, which is the safety rail
    // doing its job rather than this defect.
    fill('brain_prompt', NON_HUMAN_CAP);
    let delivered = 0;
    for (let i = 0; i < 10; i += 1) {
      const res = await brainContactsUser({
        userId: 2, clientNumber: 'TMC-0001', kind: 'wa_counterpart_message',
        summary: `person ${i} messaged you`, body: `message ${i}`, urgency: 'normal',
      });
      if (res.sent) { state.sent.push('wa_counterpart_message'); delivered += 1; }
    }
    // On 09-03 this number was 0.
    expect(delivered).toBe(RESERVE);
  });

  it('counts only NON-human sends against the non-human cap', async () => {
    // Mutation: count every send (drop the `notIn`) and a busy day of real
    // people would silence his reminders — DEF-104 with the roles swapped. Here
    // the window is full of human sends and the machinery still has its
    // allowance untouched.
    fill('wa_counterpart_message', RESERVE);
    fill('brain_prompt', NON_HUMAN_CAP - 1);
    const res = await brainContactsUser({
      userId: 2, clientNumber: 'TMC-0001', kind: 'day_brief',
      summary: 'your day', body: 'x', urgency: 'normal',
    });
    expect(res.sent).toBe(true);
  });

  it('one definition of "a person wrote this", shared with the DEF-294 exemption', async () => {
    // Two protections that each decide independently what a human message is
    // would be the 11th `protection-with-two-implementations` in a codebase
    // carrying ten. HUMAN_KINDS is the single answer, so it is asserted here.
    expect([...HUMAN_KINDS]).toEqual(['wa_counterpart_message']);
  });
});

describe('DEF-308 — a config value cannot switch either side off', () => {
  it('0% still keeps one slot for a person', async () => {
    state.reservePct = 0;
    fill('brain_prompt', DAILY_CAP - 1);
    const res = await brainContactsUser({
      userId: 2, clientNumber: 'TMC-0001', kind: 'day_brief',
      summary: 'your day', body: 'x', urgency: 'normal',
    });
    expect(res.sent).toBe(false);
    expect(rowFor('day_brief').metadata.suppressReason).toBe('human_reserve_protected');
  });

  it('100% still leaves one slot for everything else', async () => {
    state.reservePct = 100;
    const res = await brainContactsUser({
      userId: 2, clientNumber: 'TMC-0001', kind: 'day_brief',
      summary: 'your day', body: 'x', urgency: 'normal',
    });
    expect(res.sent).toBe(true);
  });
});

describe('DEF-308 — the digest exemption is bounded at the chokepoint', () => {
  it('the FIRST digest of the window passes a full cap (DEF-277 preserved)', async () => {
    fill('brain_prompt', DAILY_CAP);
    const res = await brainContactsUser({
      userId: 2, clientNumber: 'TMC-0001', kind: SUPPRESSION_DIGEST_KIND,
      summary: 'suppression digest: 40 held', body: 'held 40', urgency: 'low',
    });
    expect(res.sent).toBe(true);
  });

  it('a SECOND digest is capped like any other kind', async () => {
    // 09-03 07:57:41 — fifteen went out inside one second and took 15 of 20
    // slots. DEF-297 stopped the burst inside one process; this stops it at the
    // chokepoint, which is the only place a restart mid-burst or a second
    // process is also covered.
    //
    // Mutation: restore the unconditional `req.kind !== SUPPRESSION_DIGEST_KIND`
    // exemption and this dies.
    //
    // The gate that catches it is the human reserve, not the daily cap, because
    // the reserve is the tighter of the two — and that is the whole point: once
    // the exemption is conditional, a second digest is just another non-human
    // kind and stops where every other non-human kind stops. With the reserve
    // at one slot or more the daily-cap branch is in fact unreachable for any
    // non-human kind; it remains as the hard rail for human ones.
    fill('brain_prompt', DAILY_CAP);
    state.sent.push(SUPPRESSION_DIGEST_KIND);
    const res = await brainContactsUser({
      userId: 2, clientNumber: 'TMC-0001', kind: SUPPRESSION_DIGEST_KIND,
      summary: 'suppression digest: 41 held', body: 'held 41', urgency: 'low',
    });
    expect(res.sent).toBe(false);
    expect(res.suppressedBy).toBe('budget');
    expect(rowFor(SUPPRESSION_DIGEST_KIND).metadata.suppressReason).toBe('human_reserve_protected');
  });

  it('the daily cap is where a HUMAN message finally stops', async () => {
    // The hard rail survives DEF-308: the reserve decides who may spend the
    // budget, it never raises it. Twenty sent means twenty.
    fill('wa_counterpart_message', DAILY_CAP);
    const res = await brainContactsUser({
      userId: 2, clientNumber: 'TMC-0001', kind: 'wa_counterpart_message',
      summary: 'one more person', body: 'x', urgency: 'normal',
    });
    expect(res.sent).toBe(false);
    expect(rowFor('wa_counterpart_message').metadata.suppressReason).toBe('daily_cap_exceeded');
  });

  it('a refused digest does not fire another digest', async () => {
    // The exemption becoming conditional is what made this reachable: an
    // unguarded fire at the daily-cap site would now recurse.
    fill('brain_prompt', DAILY_CAP);
    state.sent.push(SUPPRESSION_DIGEST_KIND);
    await brainContactsUser({
      userId: 2, clientNumber: 'TMC-0001', kind: SUPPRESSION_DIGEST_KIND,
      summary: 'suppression digest', body: 'held', urgency: 'low',
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(state.created.filter((r) => r.kind === SUPPRESSION_DIGEST_KIND)).toHaveLength(1);
  });

  it('a failed count WITHHOLDS the exemption rather than granting it', async () => {
    // Mutation: `catch(() => 0)` instead of `catch(() => 1)` and this dies — a
    // database hiccup would restore the unbounded exemption, which is the state
    // that produced the flood.
    fill('brain_prompt', DAILY_CAP);
    state.digestCountThrows = true;
    const res = await brainContactsUser({
      userId: 2, clientNumber: 'TMC-0001', kind: SUPPRESSION_DIGEST_KIND,
      summary: 'suppression digest', body: 'held', urgency: 'low',
    });
    expect(res.sent).toBe(false);
  });
});
