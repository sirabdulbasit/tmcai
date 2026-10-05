/**
 * DEF-330 — C-3 increment 2, the same-SENDER half. CL-033 verbatim: "ten
 * unactionable pushes from one unknown number in a single morning".
 *
 * The per-ITEM digest (digest_enabled) needs item identity and the per-DAY
 * rollup (daily_rollup_enabled) is housekeeping-only, so a burst of HUMAN
 * relays from one sender — the shape CL-033 actually describes — passed every
 * existing switch. Under test, through the REAL chokepoint (the def327
 * harness):
 *  - at/over threshold inside the window, the relay is HELD: recorded
 *    `suppressed`/`burst_rollup` with the burst receipt, digest fired,
 *    nothing sent;
 *  - below threshold it delivers — the first threshold-many ALWAYS deliver,
 *    a sender is never silenced outright;
 *  - flag OFF (the default) delivers regardless — deploying changes nothing
 *    without the owner's opt-in (suppression takes consent, like
 *    digest_enabled);
 *  - HIGH urgency and admin probes are never held;
 *  - a relay with no `wa_counterpart:` sender grounding in its dedupKey is
 *    never held — no key, no hold, never a guess (target grounding).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const waSent = vi.hoisted(() => [] as Array<{ body: string }>);
const state = vi.hoisted(() => ({
  created: [] as any[],
  burstOn: 1 as number,
  burstRecentCount: 0,
  heldRows: [] as Array<{ kind: string; summary: string }>,
  digestAlreadySent: false,
}));

vi.mock('../src/db/prisma', () => {
  const brainUserMessage = {
    findFirst: async ({ where }: any) => {
      if (where?.dedupKey) return null;
      if (where?.kind === 'suppressed_pushes_digest') {
        return state.digestAlreadySent ? { id: 'sent-1', createdAt: new Date(Date.now() - 2 * 60 * 60_000) } : null;
      }
      return null;
    },
    findMany: async ({ where }: any) => {
      if (where?.metadata?.path?.[0] === 'suppressedBy') return state.heldRows;
      return [];
    },
    // The burst-count query is the only count keyed by a dedupKey prefix.
    count: async ({ where }: any) => (where?.dedupKey?.startsWith ? state.burstRecentCount : 0),
    create: async ({ data }: any) => { state.created.push(data); return { id: `rec-${state.created.length}` }; },
  };
  const model = {
    findUnique: async (args: any) => (args?.where?.clientNumber
      ? { name: 'TMC', domain: 'tmcltd.com' }
      : {
        id: 2, name: 'Basit', email: 'b@tmcltd.ai', clientNumber: 'TMC-0001',
        isActive: true, contactNumber: '+923000000000',
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

vi.mock('../src/services/behaviorConfig', () => ({
  getBehaviorValue: async (key: string) => {
    if (key === 'notify.office_start_hour') return 0;
    if (key === 'notify.office_end_hour') return 24;
    if (key === 'notify.office_days_mask') return 127;
    if (key === 'selfpruning.daily_rollup_enabled') return 0;
    if (key === 'selfpruning.burst_rollup_enabled') return state.burstOn;
    if (key === 'selfpruning.burst_threshold') return 4;
    if (key === 'selfpruning.burst_window_minutes') return 90;
    return 50;
  },
}));

vi.mock('../src/services/llmRouter', () => ({
  callLLM: async () => ({ text: 'Held a burst into your summary.' }),
}));

import {
  brainContactsUser,
  __resetSuppressionDigestClaimsForTests,
} from '../src/services/notifications/brainOutboundService';

const relay = (over: any = {}) => brainContactsUser({
  userId: 2, clientNumber: 'TMC-0001',
  kind: 'wa_counterpart_message', urgency: 'normal',
  summary: 'Message from +923001112223',
  body: 'Hlo sir please check',
  dedupKey: `wa_counterpart:+923001112223:msg-${Math.floor(Math.random() * 1e9)}`,
  ...over,
});

const heldRecords = () => state.created.filter((d) => d?.metadata?.suppressReason === 'burst_rollup');

beforeEach(() => {
  __resetSuppressionDigestClaimsForTests();
  waSent.length = 0;
  state.created = [];
  state.burstOn = 1;
  state.burstRecentCount = 0;
  state.heldRows = [];
  state.digestAlreadySent = false;
});

describe('DEF-330 — the same-sender burst is held at the chokepoint', () => {
  it('THE CL-033 SHAPE: at the threshold, the next relay is HELD with the burst receipt — nothing sent', async () => {
    state.burstRecentCount = 4; // 4 already delivered inside the window
    const res = await relay();
    expect(res.sent).toBe(false);
    expect(waSent).toHaveLength(0);
    const held = heldRecords();
    expect(held).toHaveLength(1);
    expect(held[0].status).toBe('suppressed');
    expect(held[0].metadata.burst.sender).toBe('wa_counterpart:+923001112223:');
    expect(held[0].metadata.burst.deliveredRecently).toBe(4);
  });

  it('below the threshold it DELIVERS — the first threshold-many always reach him', async () => {
    state.burstRecentCount = 3;
    const res = await relay();
    expect(res.sent).toBe(true);
    expect(waSent).toHaveLength(1);
    expect(heldRecords()).toHaveLength(0);
  });

  it('flag OFF (the default): deploying changes nothing — a flood still delivers until the owner opts in', async () => {
    state.burstOn = 0;
    state.burstRecentCount = 12;
    const res = await relay();
    expect(res.sent).toBe(true);
    expect(heldRecords()).toHaveLength(0);
  });

  it('HIGH urgency is never held, whatever the volume', async () => {
    state.burstRecentCount = 12;
    const res = await relay({ urgency: 'high' });
    expect(res.sent).toBe(true);
    expect(heldRecords()).toHaveLength(0);
  });

  it('an admin probe (bypassRateLimit) is never held', async () => {
    state.burstRecentCount = 12;
    const res = await relay({ bypassRateLimit: true });
    expect(res.sent).toBe(true);
    expect(heldRecords()).toHaveLength(0);
  });

  it('no sender grounding in the dedupKey → never held, never a guess', async () => {
    state.burstRecentCount = 12;
    const res = await relay({ dedupKey: 'some_other_key:abc' });
    expect(res.sent).toBe(true);
    expect(heldRecords()).toHaveLength(0);
  });

  it('the gate matches the `<channel>_counterpart:` CONVENTION, not a channel list — a future gchat relay inherits the fold with no gate edit', async () => {
    state.burstRecentCount = 4;
    const res = await relay({ dedupKey: 'gchat_counterpart:spaces/AAA-yousuf:msg-1' });
    expect(res.sent).toBe(false);
    const held = heldRecords();
    expect(held).toHaveLength(1);
    expect(held[0].metadata.burst.sender).toBe('gchat_counterpart:spaces/AAA-yousuf:');
  });

  it('a held burst fires the suppression digest as its receipt', async () => {
    state.burstRecentCount = 4;
    state.heldRows = [{ kind: 'wa_counterpart_message', summary: 'Message from +923001112223' }];
    await relay();
    const t0 = Date.now();
    while (waSent.length === 0 && Date.now() - t0 < 8000) await new Promise((r) => setTimeout(r, 25));
    expect(waSent.length).toBeGreaterThan(0); // the digest, not the relay
  });
});
