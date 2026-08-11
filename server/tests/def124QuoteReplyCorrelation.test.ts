/**
 * DEF-124 — quote-reply correlation, the rule that never fired.
 *
 * Owner, 2026-08-11: *"there is a option in Whatsapp to send response by
 * selecting any message so which indicates the response belongs to — do you
 * know this function of Whatsapp?"*
 *
 * Brain does. It is RULE ONE of delegation correlation, ahead of every guess.
 * Measured on production the same day:
 *
 *   inbound replies:    7 total,  5 carrying a quoted id
 *   outbound receipts: 27 total,  0 carrying a provider id
 *
 * Hamna quotes the exact message she is answering. Her 12:02 reply carried
 * `quoted_provider_id = 3EB00A2EA4AC5DB364C4C8`. That id exists nowhere else —
 * not in any table, not in the logs — because whatsapp-web.js 1.34.6 resolves
 * `sendMessage()` without one. So Brain never learns what its own message was
 * called, rule 1 cannot fire, and every reply falls through to guessing by
 * recency. That is the whole reason the owner keeps being told "I could not
 * tell which item".
 *
 * These assertions pin the recovery, and the two ways it could quietly go
 * wrong: matching the wrong (older) copy of a repeated message, or turning a
 * delivered send into a reported failure.
 */

import { describe, it, expect } from 'vitest';
import { recoverSentMessageId, classifyWebjsSendResult } from '../src/services/whatsapp/sendReceipt';

const nowSec = () => Math.floor(Date.now() / 1000);

/** Minimal stand-in for a whatsapp-web.js chat. */
const chatWith = (messages: any[]) => ({
  fetchMessages: async () => messages,
});

describe('DEF-124 — recovering the id the library withheld', () => {
  it('finds the id of the message we just sent', async () => {
    const chat = chatWith([
      { fromMe: false, body: 'earlier inbound', timestamp: nowSec() - 10, id: { _serialized: 'THEIRS' } },
      { fromMe: true, body: 'Reminder: the video is overdue', timestamp: nowSec(), id: { _serialized: 'OURS_NEW' } },
    ]);
    expect(await recoverSentMessageId(chat, 'Reminder: the video is overdue')).toBe('OURS_NEW');
  });

  it('picks the NEWEST copy when the same reminder was sent before', async () => {
    // The failure this ordering prevents: attaching a quote-reply to a repeat of
    // the same reminder from days ago. Brain sends the same text repeatedly by
    // design, so "first match" would be wrong far more often than right.
    const chat = chatWith([
      { fromMe: true, body: 'same reminder', timestamp: nowSec() - 5, id: { _serialized: 'OLD' } },
      { fromMe: true, body: 'same reminder', timestamp: nowSec(), id: { _serialized: 'NEW' } },
    ]);
    expect(await recoverSentMessageId(chat, 'same reminder')).toBe('NEW');
  });

  it('ignores messages that are not ours', async () => {
    const chat = chatWith([
      { fromMe: false, body: 'identical text', timestamp: nowSec(), id: { _serialized: 'THEIRS' } },
    ]);
    expect(await recoverSentMessageId(chat, 'identical text')).toBeNull();
  });

  it('refuses a stale match outside the window', async () => {
    // An hour-old message with the same body is not the one we just sent.
    const chat = chatWith([
      { fromMe: true, body: 'old reminder', timestamp: nowSec() - 3600, id: { _serialized: 'STALE' } },
    ]);
    expect(await recoverSentMessageId(chat, 'old reminder')).toBeNull();
  });

  it('requires an exact body match, not a near one', async () => {
    const chat = chatWith([
      { fromMe: true, body: 'the video is overdue, please update', timestamp: nowSec(), id: { _serialized: 'X' } },
    ]);
    expect(await recoverSentMessageId(chat, 'the video is overdue')).toBeNull();
  });

  it('returns null rather than throwing when the chat cannot be read', async () => {
    // The send has ALREADY succeeded by the time this runs. Failing to learn the
    // id must never turn a delivered message into a reported failure — that is
    // the DEF-052 mistake in reverse.
    expect(await recoverSentMessageId({ fetchMessages: async () => { throw new Error('detached'); } }, 'x')).toBeNull();
    expect(await recoverSentMessageId(null, 'x')).toBeNull();
    expect(await recoverSentMessageId({}, 'x')).toBeNull();
  });

  it('leaves a normal send classification untouched', async () => {
    // Recovery is only for the case the library gave nothing.
    const withId = classifyWebjsSendResult({ id: { _serialized: 'GOOD' } });
    expect(withId).toMatchObject({ success: true, messageId: 'GOOD', confirmation: 'provider_receipt' });

    const without = classifyWebjsSendResult({});
    expect(without).toMatchObject({ success: true, confirmation: 'transport_accepted' });
    expect(without.messageId).toBeUndefined();
  });
});
