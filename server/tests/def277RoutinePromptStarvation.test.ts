/**
 * DEF-277 — the `routine` tier was a write-only queue.
 *
 * Found by testing my own fix from twelve hours earlier. DEF-272 added an ask — *"someone has
 * messaged you N times and the transport does not share their number; who are they?"* — at
 * `criticality: 'routine'`, deliberately, so a question about a stranger could never ring the
 * owner's phone. It fired correctly on the first relay (prompt #517, 13:36) and was **still
 * unsent five hours later** while the owner asked, twice, why Brain could not name the sender.
 *
 * Nothing was broken in the ask. `CRIT_WEIGHT` is `{ top: 3, high: 2, routine: 1 }`, one prompt
 * goes per in-flight cycle, and the weight never changed with age — so while any `high` prompt
 * is queued no `routine` one can be picked, and the `high` queue **refills daily** because
 * DEF-261's deadline nags re-queue themselves. Measured: 13 high + 13 routine outstanding for
 * one user, oldest routine waiting since 08-31 12:05. Two days.
 *
 * Waiting now earns sort weight. The safety property — and the whole reason this is not simply
 * "promote it to high" — is the last test in this file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const H = vi.hoisted(() => ({
  prismaMock: {
    brainPromptQueue: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    // `top` criticality resolves its channel through pickTopChannel, which reads this.
    // Its presence in the mock is itself evidence: `top` escalates to a business call.
    brainUserMessage: { findFirst: vi.fn() },
  },
  brainContactsUser: vi.fn(),
}));
vi.mock('../src/db/prisma', () => ({ default: H.prismaMock }));
vi.mock('../src/services/notifications/brainOutboundService', () => ({ brainContactsUser: H.brainContactsUser }));

import { sendNextPrompt } from '../src/services/brainPrompts/brainPromptQueueService';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

const prompt = (over: Record<string, unknown>) => ({
  id: 'p?', criticality: 'routine', question: 'q', clientNumber: 'TMC-0001',
  openItemId: null, dedupKey: null, queuedAt: hoursAgo(1), metadata: {}, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  H.prismaMock.brainPromptQueue.findFirst.mockResolvedValue(null);   // nothing in flight
  H.prismaMock.brainUserMessage.findFirst.mockResolvedValue(null);
  H.prismaMock.brainPromptQueue.update.mockImplementation(async ({ data }: any) => ({ id: 'x', ...data }));
  H.brainContactsUser.mockResolvedValue({ sent: true, channelsUsed: ['whatsapp'], waMessageIds: ['w1'] });
});

const queue = (candidates: any[]) => H.prismaMock.brainPromptQueue.findMany.mockResolvedValue(candidates);

describe('DEF-277 — waiting earns priority', () => {
  it('THE REGRESSION: a two-day-old routine prompt is no longer stuck behind a fresh high one', async () => {
    queue([
      prompt({ id: 'aliasAsk', criticality: 'routine', question: 'Who are they?', queuedAt: hoursAgo(48) }),
      prompt({ id: 'freshNag', criticality: 'high', question: 'could I get a deadline?', queuedAt: hoursAgo(1) }),
    ]);
    await sendNextPrompt(2, 'TMC-0001');
    expect(String(H.brainContactsUser.mock.calls[0][0].body)).toContain('Who are they?');
  });

  it('does not invert the tiers for a fresh routine prompt — urgency still leads', async () => {
    queue([
      prompt({ id: 'freshRoutine', criticality: 'routine', question: 'Who are they?', queuedAt: hoursAgo(1) }),
      prompt({ id: 'freshHigh', criticality: 'high', question: 'deadline please', queuedAt: hoursAgo(1) }),
    ]);
    await sendNextPrompt(2, 'TMC-0001');
    expect(String(H.brainContactsUser.mock.calls[0][0].body)).toContain('deadline please');
  });

  it('needs real waiting, not a few minutes, to earn a tier', async () => {
    queue([
      prompt({ id: 'r', criticality: 'routine', question: 'Who are they?', queuedAt: hoursAgo(6) }),
      prompt({ id: 'h', criticality: 'high', question: 'deadline please', queuedAt: hoursAgo(1) }),
    ]);
    await sendNextPrompt(2, 'TMC-0001');
    expect(String(H.brainContactsUser.mock.calls[0][0].body)).toContain('deadline please');
  });

  it('still breaks ties by age within the same effective weight', async () => {
    queue([
      prompt({ id: 'newer', criticality: 'high', question: 'newer nag', queuedAt: hoursAgo(2) }),
      prompt({ id: 'older', criticality: 'high', question: 'older nag', queuedAt: hoursAgo(5) }),
    ]);
    await sendNextPrompt(2, 'TMC-0001');
    expect(String(H.brainContactsUser.mock.calls[0][0].body)).toContain('older nag');
  });

  it('caps what waiting can earn, so an ancient routine prompt cannot outrank a fresh TOP', async () => {
    queue([
      prompt({ id: 'ancient', criticality: 'routine', question: 'Who are they?', queuedAt: hoursAgo(24 * 30) }),
      prompt({ id: 'top', criticality: 'top', question: 'critical thing', queuedAt: hoursAgo(1) }),
    ]);
    await sendNextPrompt(2, 'TMC-0001');
    expect(String(H.brainContactsUser.mock.calls[0][0].body)).toContain('critical thing');
  });

  it('DEF-277b: a long-waiting routine prompt beats a MAXED-OUT high one — the real guarantee', async () => {
    // The first version of this fix capped the bonus per prompt, which fixed nothing: aging
    // applies to `high` too, so maxed routine (3) still lost to maxed high (4). With 13 aged
    // high prompts outstanding and DEF-261 re-queueing more daily, #517 would have waited
    // forever behind them — deployed, plausible-looking, and still starving.
    queue([
      prompt({ id: 'aliasAsk', criticality: 'routine', question: 'Who are they?', queuedAt: hoursAgo(24 * 4) }),
      prompt({ id: 'agedNag', criticality: 'high', question: 'deadline please', queuedAt: hoursAgo(24 * 3) }),
    ]);
    await sendNextPrompt(2, 'TMC-0001');
    expect(String(H.brainContactsUser.mock.calls[0][0].body)).toContain('Who are they?');
  });

  it('but high still leads for its first day of waiting', async () => {
    queue([
      prompt({ id: 'r', criticality: 'routine', question: 'Who are they?', queuedAt: hoursAgo(20) }),
      prompt({ id: 'h', criticality: 'high', question: 'deadline please', queuedAt: hoursAgo(14) }),
    ]);
    await sendNextPrompt(2, 'TMC-0001');
    expect(String(H.brainContactsUser.mock.calls[0][0].body)).toContain('deadline please');
  });

  it('the ceiling holds at ANY age — a 60-day-old routine prompt still yields to a fresh TOP', async () => {
    // `top: 100` alone is not enough: uncapped, 60 days of aging earns 120 tiers and would
    // overtake it. Both guards are needed, and this is the age at which the cap is the one doing
    // the work — the previous test passes with the cap removed, which is why this one exists.
    queue([
      prompt({ id: 'veryOld', criticality: 'routine', question: 'Who are they?', queuedAt: hoursAgo(24 * 60) }),
      prompt({ id: 'top', criticality: 'top', question: 'critical thing', queuedAt: hoursAgo(1) }),
    ]);
    await sendNextPrompt(2, 'TMC-0001');
    expect(String(H.brainContactsUser.mock.calls[0][0].body)).toContain('critical thing');
  });

  it('THE SAFETY PROPERTY: promotion changes the ORDER and never the delivery channel', async () => {
    // This is why the fix is not "make the ask high". `channelForCriticality(next.criticality)`
    // derives the channel from the stored field, and `high` escalates — a voice note or a call.
    // A two-day-old question about an unknown sender must reach him as ordinary text, or
    // DEF-272's whole reason for choosing `routine` is undone by the fix meant to deliver it.
    queue([prompt({ id: 'aliasAsk', criticality: 'routine', question: 'Who are they?', queuedAt: hoursAgo(24 * 7) })]);
    await sendNextPrompt(2, 'TMC-0001');
    const sent = H.brainContactsUser.mock.calls[0][0];
    expect(sent.urgency).not.toBe('high');
    // and the row must not have been rewritten to a louder criticality on the way out
    const writes = H.prismaMock.brainPromptQueue.update.mock.calls.map((c: any[]) => JSON.stringify(c[0]?.data ?? {}));
    expect(writes.join(' ')).not.toContain('"criticality":"high"');
    expect(writes.join(' ')).not.toContain('"criticality":"top"');
  });
});
