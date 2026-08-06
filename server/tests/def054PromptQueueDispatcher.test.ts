/**
 * DEF-054 — the brain prompt queue had no consumer.
 *
 * `sendNextPrompt` was complete and correct: in-flight guard, criticality
 * ordering, scheduledAt handling, atomic promotion with race loss, quiet-hours
 * rollback, ack id recorded for reply correlation. It was called from five
 * smoke-test scripts and from nothing in production.
 *
 * Meanwhile eight production paths enqueued into it, and the only job that
 * touched the queue was `expireStalePrompts` — which DELETES rows after 30
 * minutes. Notifications were written for the owner and expired unread.
 *
 * Found by the owner asking the right question. He had Brain send Hamna a
 * question and asked when he would hear the answer. The honest answer was
 * never: "A question you can't get the answer to is worse than not asking —
 * it looks like it worked."
 *
 * Third instance in one day of a producer with no consumer (DEF-023's
 * dispatcher-less action kind, autonomous_outbound's missing consumer, this).
 * Writing the row is not delivering the message.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const H = vi.hoisted(() => ({
  prismaMock: { brainPromptQueue: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() } },
  brainContactsUser: vi.fn(),
}));
vi.mock('../src/db/prisma', () => ({ default: H.prismaMock }));
vi.mock('../src/services/notifications/brainOutboundService', () => ({ brainContactsUser: H.brainContactsUser }));

import { dispatchDuePrompts } from '../src/services/brainPrompts/brainPromptQueueService';

beforeEach(() => {
  vi.clearAllMocks();
  H.prismaMock.brainPromptQueue.findFirst.mockResolvedValue(null); // nothing in flight
  H.prismaMock.brainPromptQueue.update.mockImplementation(async ({ data }: any) => ({ id: 'p1', ...data }));
  H.brainContactsUser.mockResolvedValue({ sent: true, channelsUsed: ['whatsapp'], waMessageIds: ['wamid.1'] });
});

/** One queued prompt for `userId`, then an empty list for the per-user pick. */
function queueFor(userIds: number[], candidates: any[] = []) {
  H.prismaMock.brainPromptQueue.findMany.mockImplementation(async (args: any) => {
    if (args?.distinct) return userIds.map((userId) => ({ userId }));
    return candidates;
  });
}

const CANDIDATE = {
  id: 'p1', criticality: 'high', question: 'They replied: yes, coming tomorrow',
  clientNumber: 'TMC-0001', openItemId: 'item_1', dedupKey: 'k', queuedAt: new Date('2026-08-05T12:00:00Z'),
  metadata: {},
};

describe('DEF-054 — queued prompts actually get delivered', () => {
  it('delivers a queued prompt instead of leaving it to expire', async () => {
    queueFor([2], [CANDIDATE]);
    const out = await dispatchDuePrompts();
    expect(out.sent, 'a written notification that is never sent is not a notification').toBe(1);
    expect(H.brainContactsUser).toHaveBeenCalledTimes(1);
  });

  it('sends the question text through to the owner', async () => {
    queueFor([2], [CANDIDATE]);
    await dispatchDuePrompts();
    const arg = H.brainContactsUser.mock.calls[0][0];
    expect(arg.body).toContain('yes, coming tomorrow');
    expect(arg.kind).toBe('brain_prompt');
  });

  it('sweeps every user with a queued prompt', async () => {
    queueFor([2, 7, 9], [CANDIDATE]);
    const out = await dispatchDuePrompts();
    expect(out.users).toBe(3);
    expect(out.sent).toBe(3);
  });

  it('one user failing does not abort the sweep for the rest', async () => {
    queueFor([2, 7], [CANDIDATE]);
    H.brainContactsUser
      .mockRejectedValueOnce(new Error('whatsapp down'))
      .mockResolvedValueOnce({ sent: true, channelsUsed: ['whatsapp'], waMessageIds: ['wamid.2'] });
    const out = await dispatchDuePrompts();
    expect(out.sent).toBe(1);
  });

  it('does nothing when the queue is empty', async () => {
    queueFor([], []);
    const out = await dispatchDuePrompts();
    expect(out).toEqual({ users: 0, sent: 0 });
    expect(H.brainContactsUser).not.toHaveBeenCalled();
  });

  it('respects the in-flight guard — no burst while the owner is mid-answer', async () => {
    queueFor([2], [CANDIDATE]);
    H.prismaMock.brainPromptQueue.findFirst.mockResolvedValue({ id: 'already_awaiting' });
    const out = await dispatchDuePrompts();
    expect(out.sent).toBe(0);
    expect(H.brainContactsUser).not.toHaveBeenCalled();
  });
});

describe('DEF-054 — the dispatcher stays wired', () => {
  const GOV = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'jobs', 'centralActionGovernor.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('the governor registers the dispatch task', () => {
    expect(
      GOV,
      'without a registered task the queue has producers and no consumer again',
    ).toContain("id: 'brain_prompt_dispatch'");
    expect(GOV).toContain('dispatchDuePrompts');
  });

  it('it is due on every governor tick, not slower than expiry', () => {
    // expire_stale runs at 30 min; dispatch must never be the slower of the two,
    // or prompts would be deleted before they were ever sent.
    const dispatch = GOV.match(/id: 'brain_prompt_dispatch', cadenceMs: (\d+) \* MINUTE/);
    const expiry = GOV.match(/id: 'prompt_expiry', cadenceMs: (\d+) \* MINUTE/);
    expect(dispatch).toBeTruthy();
    expect(expiry).toBeTruthy();
    expect(Number(dispatch![1])).toBeLessThan(Number(expiry![1]));
  });
});

/**
 * DEF-077 — one unanswered reminder froze every notification for 28 hours.
 *
 * Production, 2026-08-06 12:15. Hamna's answer completed the whole chain: LID
 * bound, thread correlated, classified as a completion, notification written.
 * Then the queue read:
 *
 *   277 queued          "That reply matched 3 open threads…"
 *   276 queued  high    "The responsible person reports completion: Issue resolved…"
 *   275 queued          "A reply arrived from a contact with more than one…"
 *   274 queued  high    "Leave Request is now overdue…"
 *   272 queued  high    "Intervention needed on Leave Request…"
 *   271 awaiting_reply  sent 2026-08-05 09:47   ← holding the lock for 28h
 *
 * The owner never answered 271, the relevance gate kept classifying his
 * messages as new turns rather than replies, and the 48h TTL meant it would
 * have blocked everything for another day.
 *
 * Two faults, and I had introduced the second one that morning: a stale lock is
 * never released, and a NOTICE waits for a lock it should ignore. I fixed a
 * notice TAKING the lock and left it still WAITING for one — half a fix reads
 * exactly like a whole one until something real goes through it.
 */
describe('DEF-077 — the conversational lock is not indefinite', () => {
  const STALE = new Date(Date.now() - 28 * 60 * 60 * 1000);
  const FRESH = new Date(Date.now() - 5 * 60 * 1000);
  const NOTICE = { ...CANDIDATE, id: 'p_notice', metadata: { expectsReply: false } };
  const QUESTION = { ...CANDIDATE, id: 'p_question', metadata: {} };

  it('releases a lock held longer than two hours and dispatches', async () => {
    queueFor([2], [QUESTION]);
    H.prismaMock.brainPromptQueue.findFirst.mockResolvedValue({ id: 271, sentAt: STALE, question: 'old reminder' });
    const out = await dispatchDuePrompts();
    expect(out.sent, 'a question ignored for a day is not a live conversation').toBe(1);
    const expiry = H.prismaMock.brainPromptQueue.update.mock.calls
      .find((c: any) => c[0]?.data?.state === 'expired');
    expect(expiry?.[0]?.where?.id).toBe(271);
  });

  it('a NOTICE goes out even while a fresh question holds the lock', async () => {
    queueFor([2], [NOTICE]);
    H.prismaMock.brainPromptQueue.findFirst.mockResolvedValue({ id: 271, sentAt: FRESH, question: 'live' });
    const out = await dispatchDuePrompts();
    expect(out.sent, "Hamna's answer must not wait behind an unrelated question").toBe(1);
  });

  it('a QUESTION still waits behind a fresh one — the lock still means something', async () => {
    queueFor([2], [QUESTION]);
    H.prismaMock.brainPromptQueue.findFirst.mockResolvedValue({ id: 271, sentAt: FRESH, question: 'live' });
    const out = await dispatchDuePrompts();
    expect(out.sent).toBe(0);
  });

  it('a notice is never promoted to awaiting_reply — the unique index would reject it', async () => {
    // uq_bpq_one_awaiting_per_user is partial-unique. Promoting a notice while a
    // question holds the slot throws P2002 and silently drops it, reintroducing
    // the exact bug the bypass exists to fix.
    queueFor([2], [NOTICE]);
    H.prismaMock.brainPromptQueue.findFirst.mockResolvedValue({ id: 271, sentAt: FRESH, question: 'live' });
    await dispatchDuePrompts();
    const promote = H.prismaMock.brainPromptQueue.update.mock.calls[0][0];
    expect(promote.data.state).toBe('answered');
    expect(promote.data.state).not.toBe('awaiting_reply');
  });
});
