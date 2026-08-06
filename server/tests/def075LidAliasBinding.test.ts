/**
 * DEF-075 — the @lid class, fifth recurrence, and the first fix that does not
 * depend on resolving it.
 *
 * 2026-08-06 10:16. Hamna replied "I'm currently doing round 1 testing of
 * shireme portal". It arrived as `255043747987458@lid`, WebjsProvider fell back
 * to the SYNTHETIC phone `+255043747987458`, her thread is keyed
 * `wa:+923134199294`, no match — triaged as a stranger.
 *
 * That is why no counterpart reply has EVER correlated: four days of
 * delegation_thread_events with zero inbound rows.
 *
 * Recurrences 1–4 each repaired a module that PARSED an id. None asked whether
 * LID→phone resolution can be relied on at all. It cannot: it needs an upstream
 * API that has broken four times, and when it breaks the code invents a number.
 *
 * So this stops resolving and starts REMEMBERING:
 *   1. known alias  → exact, permanent, used by every reply after the first
 *   2. bootstrap    → an unknown LID replying while exactly ONE counterpart was
 *                     messaged recently is almost certainly them; bind and
 *                     never infer for that person again
 *
 * Deliberately narrow: two candidates and it refuses. A wrong bind is durable
 * and would misroute someone's replies indefinitely — worse than the silence it
 * replaces.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const H = vi.hoisted(() => ({
  prismaMock: {
    entity: { findFirst: vi.fn(), update: vi.fn() },
    delegationThread: { findMany: vi.fn(), findFirst: vi.fn() },
    delegationThreadEvent: { findFirst: vi.fn() },
    openItem: { findFirst: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn({})),
  },
  appendEventWithTransition: vi.fn(),
}));
vi.mock('../src/db/prisma', () => ({ default: H.prismaMock }));
vi.mock('../src/services/delegation/delegationThreadService', async (orig) => ({
  ...(await orig<any>()),
  isDelegationCaptureEnabled: vi.fn(async () => true),
  appendEventWithTransition: H.appendEventWithTransition,
}));
vi.mock('../src/services/brainPrompts/brainPromptQueueService', () => ({ enqueueBrainPrompt: vi.fn(async () => ({ status: 'queued' })) }));
vi.mock('../src/services/openItems/actionLifecycleService', () => ({
  interpretActionReplyStrict: vi.fn(async () => ({ outcome: 'in_progress', summary: 'round 1 testing', confidence: 0.9 })),
  recordActionLifecycleReply: vi.fn(async () => undefined),
}));
vi.mock('../src/services/behaviorConfig', () => ({ getBehaviorValue: vi.fn(async () => 10) }));

import { captureDelegationReply } from '../src/services/delegation/delegationCaptureService';

const LID = '255043747987458@lid';
const SYNTH = '+255043747987458';
const REAL = '+923134199294';

const HER_THREAD = {
  id: 'thread_hamna', state: 'awaiting_reply', ownerUserId: 2,
  openItemId: 'item_shireme', activeIntentEventId: 'evt_a',
  updatedAt: new Date('2026-08-06T05:15:00Z'),
};

/** Her actual reply, verbatim from the 10:16 production log. */
function herReply() {
  return captureDelegationReply({
    clientNumber: 'TMC-0001', channel: 'whatsapp' as const,
    fromIdentifier: SYNTH, rawSenderId: LID,
    body: "I'm currently doing round 1 testing of shireme portal",
    sourceId: 'A5360E437748A4A5E60692699301A4E8',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  H.prismaMock.delegationThreadEvent.findFirst.mockResolvedValue(null);
  H.prismaMock.openItem.findFirst.mockResolvedValue({ title: 'ShireMe Portal Testing', dueDate: null, userId: 2 });
  H.appendEventWithTransition.mockResolvedValue({ ok: true, eventId: 'evt_in' });
  H.prismaMock.entity.update.mockResolvedValue({});
});

describe('DEF-075 — a known alias matches exactly', () => {
  it("her reply reaches her thread once the LID is bound", async () => {
    H.prismaMock.entity.findFirst.mockResolvedValue({ id: 'c1', name: 'Hamna Latif Bhutta', phone: REAL });
    H.prismaMock.delegationThread.findMany.mockImplementation(async (args: any) =>
      args?.where?.counterpartKey === `wa:${REAL}` ? [HER_THREAD] : []);

    const r = await herReply();
    expect(r.matched, 'a bound alias must correlate exactly').toBe(true);
    expect(r.threadId).toBe('thread_hamna');
  });

  it('the synthetic number alone never matches — the bug being fixed', async () => {
    H.prismaMock.entity.findFirst.mockResolvedValue(null);
    H.prismaMock.delegationThread.findMany.mockResolvedValue([]); // nothing waiting
    const r = await herReply();
    expect(r.matched).toBe(false);
    expect(r.outcome).toBe('no_thread');
  });
});

describe('DEF-075 — bootstrap binds once, then never guesses again', () => {
  it('one counterpart messaged recently ⇒ bind and correlate', async () => {
    H.prismaMock.entity.findFirst
      .mockResolvedValueOnce(null) // no alias yet
      .mockResolvedValueOnce({ id: 'c1', name: 'Hamna Latif Bhutta', metadata: {} });
    H.prismaMock.delegationThread.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.counterpartNumberCanonical) {
        return [{ counterpartNumberCanonical: REAL, counterpartKey: `wa:${REAL}` }];
      }
      return args?.where?.counterpartKey === `wa:${REAL}` ? [HER_THREAD] : [];
    });

    const r = await herReply();
    expect(r.matched).toBe(true);
    expect(r.threadId).toBe('thread_hamna');
  });

  it('persists the alias so the inference happens exactly once', async () => {
    H.prismaMock.entity.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'c1', name: 'Hamna Latif Bhutta', metadata: {} });
    H.prismaMock.delegationThread.findMany.mockImplementation(async (args: any) =>
      args?.where?.counterpartNumberCanonical
        ? [{ counterpartNumberCanonical: REAL, counterpartKey: `wa:${REAL}` }]
        : [HER_THREAD]);

    await herReply();
    const write = H.prismaMock.entity.update.mock.calls[0]?.[0];
    expect(write?.data?.metadata?.waLid).toBe(LID);
    expect(write?.data?.metadata?.waLidBoundBy).toBe('reply_bootstrap');
  });

  it('REFUSES to bind when two counterparts were messaged recently', async () => {
    // A wrong bind is durable — it would misroute that person's replies
    // indefinitely. Silence is the better failure here.
    H.prismaMock.entity.findFirst.mockResolvedValue(null);
    H.prismaMock.delegationThread.findMany.mockImplementation(async (args: any) =>
      args?.where?.counterpartNumberCanonical
        ? [
          { counterpartNumberCanonical: REAL, counterpartKey: `wa:${REAL}` },
          { counterpartNumberCanonical: '+923001112222', counterpartKey: 'wa:+923001112222' },
        ]
        : []);

    const r = await herReply();
    expect(r.matched).toBe(false);
    expect(H.prismaMock.entity.update).not.toHaveBeenCalled();
  });

  it('never overwrites an alias already bound to someone else', async () => {
    H.prismaMock.entity.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'c1', name: 'Hamna', metadata: { waLid: 'other@lid' } });
    H.prismaMock.delegationThread.findMany.mockImplementation(async (args: any) =>
      args?.where?.counterpartNumberCanonical
        ? [{ counterpartNumberCanonical: REAL, counterpartKey: `wa:${REAL}` }]
        : [HER_THREAD]);

    await herReply();
    expect(H.prismaMock.entity.update).not.toHaveBeenCalled();
  });
});

describe('DEF-075 — it does not touch anything else', () => {
  it('a normal phone sender skips the alias path entirely', async () => {
    H.prismaMock.delegationThread.findMany.mockResolvedValue([HER_THREAD]);
    await captureDelegationReply({
      clientNumber: 'TMC-0001', channel: 'whatsapp' as const,
      fromIdentifier: REAL, rawSenderId: `${REAL.slice(1)}@c.us`,
      body: 'done', sourceId: 'wamid.plain',
    });
    expect(H.prismaMock.entity.findFirst).not.toHaveBeenCalled();
  });

  it('never calls the WhatsApp mapping API — the dependency that failed 4×', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'delegation', 'delegationCaptureService.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/getContactLidAndPhone|lidToPhone/);
  });
});
