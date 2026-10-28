/**
 * DEF-327 — the one-message-per-day rollup, at the chokepoint every producer
 * passes. Deck tag: `Getting several emails a day and calling it noise`.
 *
 * Owner, CL-057/CL-058: *"i should received one digest email per day instead
 * of n number of email"*. DEF-325 built the rollup in `digestPolicy.ts`,
 * reached only from `enqueueBrainPrompt` — but the LOUDEST producer,
 * `openItemDraftAskJob`, calls `brainContactsUser` directly (289 draft-asks/day
 * vs 2 brain prompts), so the rollup held nothing. Moved to
 * `brainContactsUser` — the one gate (DEF-108) every producer passes — scoped
 * to the existing `HOUSEKEEPING_KINDS` cadence tier, held (never dropped) into
 * the DEF-277 suppression digest as the single daily receipt.
 *
 * Proven through the REAL chokepoint (the def277 harness), not a
 * re-implementation. The falsifier: `open_item_draft_ask` SENT falls to zero,
 * and the day yields one receipt plus whatever escalations occurred.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const waSent = vi.hoisted(() => [] as Array<{ body: string }>);
const state = vi.hoisted(() => ({
  created: [] as any[],
  rollupOn: 1 as number,          // selfpruning.daily_rollup_enabled
  heldRows: [] as Array<{ kind: string; summary: string }>,
  digestAlreadySent: false,
  llmText: 'Held a few items into your daily summary.',
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
    count: async () => 0,
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
    if (key === 'selfpruning.daily_rollup_enabled') return state.rollupOn;
    return 50;
  },
}));

vi.mock('../src/services/llmRouter', () => ({
  callLLM: async () => ({ text: state.llmText }),
}));

import {
  brainContactsUser,
  __resetSuppressionDigestClaimsForTests,
  SUPPRESSION_DIGEST_KIND,
} from '../src/services/notifications/brainOutboundService';

const until = async (pred: () => boolean, ms = 8000) => {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 25));
};

const contact = (over: any = {}) => brainContactsUser({
  userId: 2, clientNumber: 'TMC-0001',
  kind: 'open_item_draft_ask', urgency: 'normal',
  summary: 'What deadline for "Join Google Meet call"?',
  body: 'What deadline should I put on this?',
  ...over,
});

beforeEach(() => {
  __resetSuppressionDigestClaimsForTests();
  waSent.length = 0;
  state.created = [];
  state.rollupOn = 1;
  state.heldRows = [];
  state.digestAlreadySent = false;
});

describe('DEF-327 — the loud producer is held at the chokepoint, not sent', () => {
  it('THE FALSIFIER: a draft-ask is HELD (suppressed/daily_rollup), never sent as its own email', async () => {
    const res = await contact();
    expect(res.sent).toBe(false);
    const row = state.created.find((r) => r.kind === 'open_item_draft_ask');
    expect(row.status).toBe('suppressed');
    expect(row.metadata.suppressReason).toBe('daily_rollup');
    // suppressedBy=budget so the DEF-277 digest counts it as owed to him.
    expect(row.metadata.suppressedBy).toBe('budget');
    // No individual draft-ask text reached WhatsApp.
    expect(waSent.every((m) => !m.body.includes('What deadline'))).toBe(true);
  });

  it('the held draft-ask fires the ONE daily receipt — the DEF-277 suppression digest', async () => {
    state.heldRows = [
      { kind: 'open_item_draft_ask', summary: 'deadline for A' },
      { kind: 'open_item_draft_ask', summary: 'deadline for B' },
    ];
    await contact();
    await until(() => state.created.some((r) => r.kind === SUPPRESSION_DIGEST_KIND && r.status === 'sent'));
    expect(waSent).toHaveLength(1); // exactly one message reaches him
  });

  it('every HOUSEKEEPING kind is held the same way — not just draft-asks', async () => {
    // DEF-365: 'brain_prompt' deliberately REMOVED from this list — the queue
    // dispatcher's messages are already volume-governed by the queue itself,
    // and double-governing them starved every routine queue prompt (zero
    // learn digests ever delivered). This test updated with the change, the
    // governor-manifest way: knowingly, in the same commit.
    for (const kind of ['open_item_draft_ask', 'open_item_overdue']) {
      state.created = [];
      const res = await contact({ kind });
      expect(res.sent, kind).toBe(false);
      expect(state.created.find((r) => r.kind === kind).metadata.suppressReason).toBe('daily_rollup');
    }
  });

  it('DEF-365 `covered-but-undelivered`: a QUEUE-dispatched prompt (brain_prompt) is governed ONCE — the rollup never holds it', async () => {
    state.created = [];
    const res = await contact({ kind: 'brain_prompt', body: 'learn digest marker' });
    expect(res.sent).toBe(true); // flows to the tier/channel path like any non-held kind
    expect(state.created.find((r) => r.kind === 'brain_prompt')?.metadata?.suppressReason).toBeUndefined();
  });
});

describe('DEF-327 — the guards it must never reach', () => {
  it('a HUMAN message is never held (DEF-308 floor survives)', async () => {
    const res = await contact({ kind: 'wa_counterpart_message', body: 'Hi from Hamna' });
    expect(res.sent).toBe(true);
    expect(waSent.some((m) => m.body.includes('Hi from Hamna'))).toBe(true);
  });

  it('a HIGH-urgency housekeeping escalation is never held', async () => {
    const res = await contact({ urgency: 'high' });
    expect(res.sent).toBe(true);
  });

  it('an EMERGENCY escalation is never held', async () => {
    const res = await contact({ urgency: 'emergency' });
    expect(res.sent).toBe(true);
  });

  it('the day brief (not a housekeeping kind) is never held', async () => {
    const res = await contact({ kind: 'day_brief', body: 'Your day at a glance' });
    expect(res.sent).toBe(true);
  });

  it('the switch OFF restores the old behaviour — the draft-ask flows to the tier cap and sends', async () => {
    state.rollupOn = 0;
    const res = await contact();
    expect(res.sent).toBe(true); // held nowhere; below the 50% housekeeping budget with count=0
    expect(state.created.find((r) => r.kind === 'open_item_draft_ask')?.metadata?.suppressReason).toBeUndefined();
  });

  it('bypassRateLimit (admin probe) is never held', async () => {
    const res = await contact({ bypassRateLimit: true });
    expect(res.sent).toBe(true);
  });
});
