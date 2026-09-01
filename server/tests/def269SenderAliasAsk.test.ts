/**
 * DEF-269 — "is brain don't know who sent it message?"
 *
 * Owner, 2026-09-01, after eight messages from one person in four hours. Brain knew it was ONE
 * consistent sender — same `@lid` since 08-06, policy `allowed` — and every relay still said
 * *"an unknown sender whose number WhatsApp did not share"*.
 *
 * NOT A CODE DEFECT, and that matters for what the fix may do. WhatsApp genuinely withholds the
 * number for `@lid` senders, and `identifySender` correctly refuses to invent one: the earlier
 * version showed a fabricated 15-digit São Tomé number, and *"a fabricated number is worse than
 * no number: it looks actionable"*. The alias table is the ONE path that resolves them, and it
 * already works — 2 of 778 contacts carry a `waLid` and those senders ARE named.
 *
 * So the gap is an empty lookup that only the owner can fill. This asks him ONCE per identity,
 * on the existing prompt queue with the existing side-effect machinery — and the tests below are
 * mostly about what it must NOT do, because the obvious implementations are all worse:
 * asking on the first stray "Hlo" (a new nag, on the day DEF-271 was fixed for that), creating a
 * contact called "skip", duplicating a contact the owner already has, or inventing a phone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const entityFindFirst = vi.fn();
const bumCount = vi.fn();
const promptFindFirst = vi.fn();
const enqueue = vi.fn();

vi.mock('../src/db/prisma', () => ({
  default: {
    entity: { findFirst: (...a: any[]) => entityFindFirst(...a) },
    brainUserMessage: { count: (...a: any[]) => bumCount(...a) },
    brainPromptQueue: { findFirst: (...a: any[]) => promptFindFirst(...a) },
  },
}));
vi.mock('../src/services/brainPrompts/brainPromptQueueService', () => ({
  enqueueBrainPrompt: (...a: any[]) => enqueue(...a),
}));

import { maybeAskWhoSenderIs } from '../src/services/whatsapp/senderTriage';

const BASE = {
  clientNumber: 'TMC-0001',
  fromNumber: '+487846228094',
  rawSenderId: '487846228094@lid',
  ownerUserId: 2,
  body: 'Ma thak',
};

beforeEach(() => {
  vi.clearAllMocks();
  entityFindFirst.mockResolvedValue(null);
  promptFindFirst.mockResolvedValue(null);
  bumCount.mockResolvedValue(8);
  enqueue.mockResolvedValue({ id: 1 });
});

describe('DEF-269 — asking who an anonymous sender is', () => {
  it('asks once a sender has written several times', async () => {
    const r = await maybeAskWhoSenderIs(BASE);
    expect(r.asked).toBe(true);
    expect(enqueue).toHaveBeenCalledTimes(1);
    const q = enqueue.mock.calls[0][0];
    expect(q.question).toContain('Who are they?');
    expect(q.question).toContain('Ma thak');     // he can recognise them from the message
  });

  it('does NOT ask on a first stray message — that would be a new nag', async () => {
    // DEF-271 was fixed the same day for exactly this: housekeeping asks displacing real
    // messages. An ask must be earned by a sender who keeps writing.
    bumCount.mockResolvedValue(1);
    const r = await maybeAskWhoSenderIs(BASE);
    expect(r.asked).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('asks ONCE per identity, keyed on the @lid and not the message', async () => {
    // A chatty sender must not generate an ask per message.
    await maybeAskWhoSenderIs(BASE);
    expect(enqueue.mock.calls[0][0].dedupKey).toBe('wa_sender_alias:487846228094@lid');
    expect(enqueue.mock.calls[0][0].dedupKey).not.toContain('Ma thak');
  });

  it('never asks about a sender whose number WhatsApp DID share', async () => {
    // A real phone needs no alias: the contact lookup names it, or the owner can read it.
    const r = await maybeAskWhoSenderIs({ ...BASE, rawSenderId: '923226288256@c.us' });
    expect(r.asked).toBe(false);
    expect(r.reason).toBe('not_a_lid_sender');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('never asks twice about someone already named', async () => {
    entityFindFirst.mockResolvedValue({ id: 'ent_1' });
    const r = await maybeAskWhoSenderIs(BASE);
    expect(r.asked).toBe(false);
    expect(r.reason).toBe('already_aliased');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('asks at ROUTINE criticality — a stranger must never ring the owner', async () => {
    // channelForCriticality escalates 'high' to a voice note or a business call.
    await maybeAskWhoSenderIs(BASE);
    expect(enqueue.mock.calls[0][0].criticality).toBe('routine');
  });

  it('never asks a second time, even after he answered "skip"', async () => {
    // enqueueBrainPrompt's own dedup covers only queued/awaiting_reply, so a terminal ask does
    // NOT block it. Without this check the ask fires on every later message once he declines —
    // rebuilding the nag DEF-271 was fixed to stop.
    promptFindFirst.mockResolvedValue({ id: 77 });
    const r = await maybeAskWhoSenderIs(BASE);
    expect(r.asked).toBe(false);
    expect(r.reason).toBe('already_asked');
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('looks for that prior ask WITHOUT filtering on state', async () => {
    await maybeAskWhoSenderIs(BASE);
    const where = promptFindFirst.mock.calls[0][0].where;
    expect(where.dedupKey).toBe('wa_sender_alias:487846228094@lid');
    expect(where.state).toBeUndefined();      // a terminal ask is still an ask
    expect(where.clientNumber).toBe('TMC-0001');   // tenant-scoped, invariant #1
  });

  it('never puts the internal identifier in front of the owner', async () => {
    // Owner instruction, 2026-09-01: "don't show me niumber like +239487846228094, this is your
    // internal number". It is SHAPED like a dialable number and is not one (DEF-269/DEF-121).
    await maybeAskWhoSenderIs(BASE);
    const q = String(enqueue.mock.calls[0][0].question);
    expect(q).not.toContain('487846228094');
    expect(q).not.toContain('@lid');
    expect(q).not.toContain(BASE.fromNumber);
  });

  it('counts messages by SENDER, not across all senders', async () => {
    await maybeAskWhoSenderIs(BASE);
    const where = bumCount.mock.calls[0][0].where;
    expect(where.dedupKey.startsWith).toBe('wa_counterpart:+487846228094:');
    expect(where.clientNumber).toBe('TMC-0001');
    expect(where.userId).toBe(2);
  });
});

/**
 * The other half: what counts as an ANSWER to that ask.
 *
 * The ask sits in the queue until the owner replies to it. Without a shape case,
 * `looksLikeAnswer` falls through to `default`, which accepts any text under 200 characters —
 * so the next unrelated thing the owner typed would be written into a contact name. That is a
 * worse outcome than the anonymity the ask exists to fix, and it is why this gate is narrow.
 */
import { looksLikeAnswer } from '../src/services/brainPrompts/promptReplyHandler';

describe('DEF-269 — only a name counts as naming someone', () => {
  const K = 'wa_sender_alias_capture';

  it('accepts the names the owner would actually type', () => {
    for (const name of ['Hamna', 'hamna', 'Muhammad Yousaf', 'Hamna Latif Bhutta', "O'Brien", 'A. Rehman']) {
      expect(looksLikeAnswer(name, K), name).toBe(true);
    }
  });

  it('refuses a sentence — the owner talking, not naming', () => {
    for (const text of [
      'I have no idea who that is',
      'can you check the calendar for tomorrow',
      'that is the guy from the Dubai office who called yesterday',
    ]) {
      expect(looksLikeAnswer(text, K), text).toBe(false);
    }
  });

  it('refuses a question, an address and a link — none of them is a name', () => {
    expect(looksLikeAnswer('who?', K)).toBe(false);
    expect(looksLikeAnswer('hamna@tmcltd.ai', K)).toBe(false);
    expect(looksLikeAnswer('https://wa.me/12345', K)).toBe(false);
  });

  it('refuses a number — the transport withheld it, and a typed one is not evidence', () => {
    // DEF-121: a fabricated number is worse than no number because it looks actionable.
    expect(looksLikeAnswer('+923226288256', K)).toBe(false);
    expect(looksLikeAnswer('923226288256', K)).toBe(false);
  });

  it('does not treat "skip" as a name', () => {
    // Layer 1 rejects it as a new-chat trigger; the handler also declines it. Both, on purpose.
    expect(looksLikeAnswer('skip', K)).toBe(false);
  });

  it('is stricter than the default branch it replaces', () => {
    // Proves the case is load-bearing: this text IS accepted with no shape case.
    const stray = 'remind me to look at the invoice numbers later on';
    expect(looksLikeAnswer(stray, 'noop')).toBe(false);          // layer 1 catches this one
    const stray2 = 'the thing we discussed about the office lease renewal';
    expect(looksLikeAnswer(stray2, 'noop')).toBe(true);          // default accepts it
    expect(looksLikeAnswer(stray2, K)).toBe(false);              // the new case does not
  });
});
