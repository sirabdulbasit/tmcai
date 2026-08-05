/**
 * DEF-047 / DEF-048 — Brain had never read a single counterpart reply.
 *
 * Measured on production 2026-08-05: `delegation_thread_events` held 15 events
 * across four days, every one OUTBOUND. Zero inbound, ever — while the
 * follow-up worker kept messaging the same counterparts daily. People were
 * being nagged under the owner's identity with no mechanism to notice they had
 * answered.
 *
 * Capture was not broken and was not disabled. `captureDelegationReply` is
 * correctly called BEFORE the unregistered-sender drop, and
 * `behavior.delegation.capture_enabled` was 1. The blocker was the correlation
 * rule: match a quoted provider id, or EXACTLY ONE active thread for the
 * counterpart — otherwise refuse. Hamna had two active threads on one number,
 * so no plain reply from her could ever be read.
 *
 * Refusing looks safe and is not. It trades "might attach to the wrong item"
 * for "never hear from anyone". A person with two questions outstanding
 * attaches a reply to the more recent one and asks if unsure — which is what
 * the code now does, while telling the owner the attachment was a guess.
 *
 * DEF-048: only `completed` and `low_confidence` replies were reported to the
 * owner. A counterpart answering the actual question ("yes, I'll be in
 * tomorrow") classifies as `in_progress` and was filed silently — from the
 * owner's side, indistinguishable from no reply at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const H = vi.hoisted(() => ({
  prismaMock: {
    delegationThread: { findFirst: vi.fn(), findMany: vi.fn() },
    delegationThreadEvent: { findFirst: vi.fn() },
    openItem: { findFirst: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn({})),
  },
  appendEventWithTransition: vi.fn(),
  enqueueBrainPrompt: vi.fn(),
  interpretActionReplyStrict: vi.fn(),
  recordActionLifecycleReply: vi.fn(),
  recordAmbiguity: vi.fn(),
}));

vi.mock('../src/db/prisma', () => ({ default: H.prismaMock }));

vi.mock('../src/services/delegation/delegationThreadService', async (orig) => ({
  ...(await orig<any>()),
  isDelegationCaptureEnabled: vi.fn(async () => true),
  appendEventWithTransition: H.appendEventWithTransition,
}));

vi.mock('../src/services/brainPrompts/brainPromptQueueService', () => ({
  enqueueBrainPrompt: H.enqueueBrainPrompt,
}));

vi.mock('../src/services/openItems/actionLifecycleService', () => ({
  interpretActionReplyStrict: H.interpretActionReplyStrict,
  recordActionLifecycleReply: H.recordActionLifecycleReply,
}));

vi.mock('../src/services/behaviorConfig', () => ({
  getBehaviorValue: vi.fn(async () => 10),
}));

import { captureDelegationReply } from '../src/services/delegation/delegationCaptureService';

const OLDER = {
  id: 'thread_older', state: 'awaiting_reply', ownerUserId: 2,
  openItemId: 'item_older', activeIntentEventId: 'evt_a',
  updatedAt: new Date('2026-08-05T09:00:00Z'),
};
const NEWER = {
  id: 'thread_newer', state: 'awaiting_reply', ownerUserId: 2,
  openItemId: 'item_newer', activeIntentEventId: 'evt_b',
  updatedAt: new Date('2026-08-05T09:47:42Z'), // Hamna's real second thread
};

function reply(body = 'Yes I will be in the office tomorrow') {
  return captureDelegationReply({
    clientNumber: 'TMC-0001', channel: 'whatsapp' as const,
    fromIdentifier: '+923134199294', body, sourceId: 'wamid.TEST1',
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  H.prismaMock.$transaction.mockImplementation(async (fn: any) => fn({
    delegationThreadEvent: { create: vi.fn() },
    delegationThread: { updateMany: vi.fn() },
    correlationIncident: { upsert: vi.fn(async () => ({ id: 'inc_1' })), update: vi.fn() },
    correlationIncidentCandidate: { count: vi.fn(async () => 0), upsert: vi.fn() },
    $queryRawUnsafe: vi.fn(async () => [{ id: 'inc_1' }]),
  }));
  H.prismaMock.delegationThreadEvent.findFirst.mockResolvedValue(null);
  H.prismaMock.openItem.findFirst.mockResolvedValue({ title: 'Office attendance', dueDate: null, userId: 2 });
  H.appendEventWithTransition.mockResolvedValue({ ok: true, eventId: 'evt_inbound' });
  H.interpretActionReplyStrict.mockResolvedValue({
    outcome: 'in_progress', summary: 'Confirms attendance tomorrow', confidence: 0.9,
  });
  H.recordActionLifecycleReply.mockResolvedValue(undefined);
});

describe('DEF-047 — two open threads with one counterpart no longer swallow the reply', () => {
  it('MATCHES instead of refusing, and picks the most recently contacted thread', async () => {
    H.prismaMock.delegationThread.findMany.mockResolvedValue([OLDER, NEWER]);

    const result = await reply();

    expect(result.matched, 'a reply from a known counterpart must be read').toBe(true);
    expect(result.outcome).not.toBe('ambiguous');
    expect(result.threadId, 'the most recent thread wins the tie').toBe('thread_newer');
  });

  it('order in the candidate list does not decide it — recency does', async () => {
    H.prismaMock.delegationThread.findMany.mockResolvedValue([NEWER, OLDER]); // reversed
    const result = await reply();
    expect(result.threadId).toBe('thread_newer');
  });

  it('tells the owner the attachment was a GUESS, naming how many threads matched', async () => {
    H.prismaMock.delegationThread.findMany.mockResolvedValue([OLDER, NEWER]);
    await reply();

    const inferred = H.enqueueBrainPrompt.mock.calls
      .map((c) => c[0])
      .find((a: any) => a?.metadata?.kind === 'delegation_reply_correlation_inferred');

    expect(inferred, 'an inferred correlation must never be silent').toBeTruthy();
    expect(inferred.question).toMatch(/2 open threads/);
    expect(inferred.question).toMatch(/different item/i);
  });

  it('a single thread is still an exact match, with no guess notice', async () => {
    H.prismaMock.delegationThread.findMany.mockResolvedValue([NEWER]);
    await reply();

    const inferred = H.enqueueBrainPrompt.mock.calls
      .map((c) => c[0])
      .find((a: any) => a?.metadata?.kind === 'delegation_reply_correlation_inferred');
    expect(inferred, 'one candidate is certainty, not inference').toBeFalsy();
  });

  it('an unsent thread still cannot consume a reply', async () => {
    H.prismaMock.delegationThread.findMany.mockResolvedValue([
      { ...NEWER, state: 'dispatch_pending', activeIntentEventId: null },
    ]);
    const result = await reply();
    expect(result.matched).toBe(false);
    expect(result.outcome).toBe('no_thread');
  });
});

describe('DEF-048 — an answer to the question actually reaches the owner', () => {
  it('reports an in_progress reply, which used to be filed silently', async () => {
    H.prismaMock.delegationThread.findMany.mockResolvedValue([NEWER]);
    await reply();

    const received = H.enqueueBrainPrompt.mock.calls
      .map((c) => c[0])
      .find((a: any) => a?.metadata?.kind === 'delegation_reply_received');

    expect(received, 'the owner asked a question — the answer is the point').toBeTruthy();
    expect(received.question).toContain('Confirms attendance tomorrow');
  });

  it('still reports a completion, unchanged', async () => {
    H.prismaMock.delegationThread.findMany.mockResolvedValue([NEWER]);
    H.interpretActionReplyStrict.mockResolvedValue({
      outcome: 'completed', summary: 'Done, uploaded this morning',
      confidence: 0.95, completionEvidence: true,
    });
    await reply();

    const done = H.enqueueBrainPrompt.mock.calls
      .map((c) => c[0])
      .find((a: any) => a?.metadata?.kind === 'delegation_completion_reported');
    expect(done).toBeTruthy();
  });

  it('an unrelated reply stays silent — not every message is news', async () => {
    H.prismaMock.delegationThread.findMany.mockResolvedValue([NEWER]);
    H.interpretActionReplyStrict.mockResolvedValue({
      // 'unknown' is what the classifier emits for a message that is not
      // about the item; the service maps it to the 'unrelated' outcome.
      outcome: 'unknown', summary: 'Sent a sticker', confidence: 0.8,
    });
    await reply();
    expect(H.enqueueBrainPrompt).not.toHaveBeenCalled();
  });
});

describe('DEF-047 — the refuse-on-ambiguity branch must not come back', () => {
  const CODE = fs
    .readFileSync(path.join(__dirname, '..', 'src', 'services', 'delegation', 'delegationCaptureService.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

  it('does not return an ambiguous non-match for multiple candidates', () => {
    expect(
      CODE,
      "Returning 'ambiguous' here is what produced four days of zero inbound "
      + 'replies while follow-ups kept going out. Correlate and disclose instead.',
    ).not.toMatch(/outcome:\s*'ambiguous'/);
  });

  it('still records the incident row, so the audit trail survives the change', () => {
    expect(CODE).toContain('recordAmbiguityIncidents');
  });
});
