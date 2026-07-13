import { describe, it, expect, vi, beforeEach } from 'vitest';

// F1 capability-parity — sendEmailReply / forwardEmail were STUBS (execute()
// fabricated a receipt with deliveryStatus 'stub'; no Gmail write ever
// happened). Since B2 their confirm() correctly failed closed, so the actions
// ALWAYS failed. These tests pin the real behaviour: execute() must resolve
// the original message (feed_events → Gmail headers, same shape as the voice
// draft_reply path), make the real provider call with proper threading
// headers, surface provider errors as ok:false, and confirm() must read the
// sent message back from Gmail (IMAP-format ids get a receipt-format check).

const sendUserEmailMock = vi.fn();
const readEmailMock = vi.fn();
vi.mock('../src/services/adapters/gmailAdapter', () => ({
  sendUserEmail: (...a: any[]) => sendUserEmailMock(...a),
  readEmail: (...a: any[]) => readEmailMock(...a),
}));

const getHeadersMock = vi.fn();
vi.mock('../src/services/gmailService', () => ({
  getEmailHeadersForReply: (...a: any[]) => getHeadersMock(...a),
}));

const feedEventFindFirstMock = vi.fn();
const userFindUniqueMock = vi.fn();
vi.mock('../src/db/prisma', () => ({
  default: {
    feedEvent: { findFirst: (...a: any[]) => feedEventFindFirstMock(...a) },
    user: { findUnique: (...a: any[]) => userFindUniqueMock(...a) },
  },
}));

import { SendEmailReplyHandler } from '../src/services/actions/handlers/communication/sendEmailReply';
import { ForwardEmailHandler } from '../src/services/actions/handlers/communication/forwardEmail';

const baseCtx = { clientNumber: 'tmc', userId: 2 };

// Canonical resolved-original fixtures shared across tests.
const FEED_EVENT = {
  sourceId: 'msg_orig_1',
  senderEmail: 'alice@external.com',
  senderName: 'Alice',
  rawPayload: { threadId: 'thr_1', subject: 'Budget review', from: 'Alice <alice@external.com>' },
};
const HEADERS = {
  rfcMessageId: '<orig-abc@mail.gmail.com>',
  references: '<older-xyz@mail.gmail.com>',
  from: 'Alice <alice@external.com>',
  to: 'Basit <basit.ahmed@tmcltd.ai>, Bob <bob@external.com>',
  cc: 'carol@external.com',
  subject: 'Budget review',
  threadId: 'thr_1',
};

beforeEach(() => {
  vi.clearAllMocks();
  feedEventFindFirstMock.mockResolvedValue(FEED_EVENT);
  getHeadersMock.mockResolvedValue(HEADERS);
  userFindUniqueMock.mockResolvedValue({ email: 'basit.ahmed@tmcltd.ai' });
  sendUserEmailMock.mockResolvedValue({ success: true, messageId: 'sent_new_1', threadId: 'thr_1' });
  readEmailMock.mockResolvedValue({ email: { id: 'sent_new_1', threadId: 'thr_1' } });
});

// ─── SendEmailReplyHandler ──────────────────────────────────────

describe('SendEmailReplyHandler.execute', () => {
  const ctx = { ...baseCtx, payload: { threadId: 'thr_1', body: 'Sounds good, approved.' } };

  it('sends a real threaded reply to the original sender', async () => {
    const h = new SendEmailReplyHandler();
    const out = await h.execute(ctx as any);

    expect(out.ok).toBe(true);
    // The provider was actually called — recipient is the original From,
    // threading opts carry threadId + In-Reply-To + extended References.
    expect(sendUserEmailMock).toHaveBeenCalledTimes(1);
    const [userId, to, subject, body, cc, opts] = sendUserEmailMock.mock.calls[0];
    expect(userId).toBe(2);
    expect(to).toBe('alice@external.com');
    expect(subject).toBe('Budget review'); // sendUserEmail itself adds "Re: " when threadId is set
    expect(body).toBe('Sounds good, approved.');
    expect(cc).toBeUndefined(); // plain reply → no reply-all cc
    expect(opts).toMatchObject({
      threadId: 'thr_1',
      inReplyTo: '<orig-abc@mail.gmail.com>',
      // RFC 5322: new References = original References + original Message-ID
      references: '<older-xyz@mail.gmail.com> <orig-abc@mail.gmail.com>',
    });
    // Provider-assigned id lands in output (not a fabricated stub id).
    expect((out.output as any).messageId).toBe('sent_new_1');
    expect((out.output as any).threadId).toBe('thr_1');
  });

  it('replyAll cc-includes original To+Cc minus the recipient and the user themself', async () => {
    const h = new SendEmailReplyHandler();
    const out = await h.execute({ ...baseCtx, payload: { ...ctx.payload, replyAll: true } } as any);
    expect(out.ok).toBe(true);
    const [, to, , , cc] = sendUserEmailMock.mock.calls[0];
    expect(to).toBe('alice@external.com');
    // basit (self) and alice (already in To) filtered out; bob + carol kept.
    expect(cc).toBe('Bob <bob@external.com>, carol@external.com');
  });

  it('falls back to Gmail header lookup when no feed_event matches', async () => {
    // Single-message threads: the thread id IS the first message id, so a
    // direct users.messages.get on the payload id still resolves the original.
    feedEventFindFirstMock.mockResolvedValue(null);
    const h = new SendEmailReplyHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(true);
    expect(getHeadersMock).toHaveBeenCalledWith(2, 'thr_1');
    expect(sendUserEmailMock).toHaveBeenCalledTimes(1);
  });

  it('returns ok:false with the provider error on send failure', async () => {
    sendUserEmailMock.mockResolvedValue({ success: false, error: 'Send failed: 429 — rate limited' });
    const h = new SendEmailReplyHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('rate limited');
  });

  it('returns ok:false when the original message cannot be resolved', async () => {
    feedEventFindFirstMock.mockResolvedValue(null);
    getHeadersMock.mockResolvedValue({ error: 'Header fetch failed: not found' });
    const h = new SendEmailReplyHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(false);
    expect(sendUserEmailMock).not.toHaveBeenCalled();
  });
});

describe('SendEmailReplyHandler.confirm', () => {
  const ctx = { ...baseCtx, payload: { threadId: 'thr_1', body: 'x' } };

  it('confirms via Gmail read-back on the sent messageId', async () => {
    const h = new SendEmailReplyHandler();
    const ok = await h.confirm(ctx as any, { messageId: 'sent_new_1', threadId: 'thr_1' });
    expect(ok).toBe(true);
    expect(readEmailMock).toHaveBeenCalledWith(2, 'sent_new_1');
  });

  it('fails closed when read-back errors or returns a different id', async () => {
    readEmailMock.mockResolvedValue({ error: 'Gmail error: not found' });
    const h = new SendEmailReplyHandler();
    expect(await h.confirm(ctx as any, { messageId: 'sent_new_1' })).toBe(false);
  });

  it('fails closed when the read-back message is in a different thread', async () => {
    readEmailMock.mockResolvedValue({ email: { id: 'sent_new_1', threadId: 'thr_OTHER' } });
    const h = new SendEmailReplyHandler();
    expect(await h.confirm(ctx as any, { messageId: 'sent_new_1', threadId: 'thr_1' })).toBe(false);
  });

  it('IMAP-fallback RFC-5322 ids get a receipt-format check only', async () => {
    const h = new SendEmailReplyHandler();
    expect(await h.confirm(ctx as any, { messageId: '<smtp-123@tmcltd.ai>' })).toBe(true);
    expect(readEmailMock).not.toHaveBeenCalled();
    expect(await h.confirm(ctx as any, { messageId: 'not a @valid id' })).toBe(false);
  });

  it('fails closed on missing messageId', async () => {
    const h = new SendEmailReplyHandler();
    expect(await h.confirm(ctx as any, {})).toBe(false);
    expect(await h.confirm(ctx as any, undefined)).toBe(false);
  });
});

// ─── ForwardEmailHandler ────────────────────────────────────────

describe('ForwardEmailHandler.execute', () => {
  const ctx = {
    ...baseCtx,
    payload: { threadId: 'thr_1', to: ['dave@external.com', 'erin@external.com'], note: 'FYI — please handle.' },
  };

  beforeEach(() => {
    // Forward needs the full original body, fetched via adapter.readEmail.
    readEmailMock.mockResolvedValue({
      email: {
        id: 'msg_orig_1', threadId: 'thr_1',
        from: 'Alice <alice@external.com>', to: 'basit.ahmed@tmcltd.ai', cc: '',
        subject: 'Budget review', date: 'Tue, 8 Jul 2026 10:00:00 +0400',
        body: 'Original budget details here.',
      },
    });
  });

  it('forwards the resolved original to each recipient with note + quoted body', async () => {
    const h = new ForwardEmailHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(true);
    // Original resolved via feed_event sourceId, then read in full.
    expect(readEmailMock).toHaveBeenCalledWith(2, 'msg_orig_1');
    // One provider send per recipient (mirrors SendEmailHandler granularity).
    expect(sendUserEmailMock).toHaveBeenCalledTimes(2);
    const [userId, to, subject, body] = sendUserEmailMock.mock.calls[0];
    expect(userId).toBe(2);
    expect(to).toBe('dave@external.com');
    expect(subject).toBe('Fwd: Budget review');
    expect(body).toContain('FYI — please handle.');
    expect(body).toContain('Forwarded message');
    expect(body).toContain('alice@external.com');
    expect(body).toContain('Original budget details here.');
    const o = out.output as any;
    expect(o.messageId).toBe('sent_new_1'); // first provider-assigned id, for auditFields
    expect(o.results).toHaveLength(2);
    expect(o.results.every((r: any) => r.messageId === 'sent_new_1')).toBe(true);
  });

  it('does not re-prefix an already-forwarded subject', async () => {
    readEmailMock.mockResolvedValue({
      email: { id: 'msg_orig_1', threadId: 'thr_1', from: 'a@b.c', to: '', cc: '', subject: 'Fwd: Budget review', date: '', body: 'x' },
    });
    const h = new ForwardEmailHandler();
    await h.execute(ctx as any);
    expect(sendUserEmailMock.mock.calls[0][2]).toBe('Fwd: Budget review');
  });

  it('returns ok:false when all recipients fail, carrying the provider error', async () => {
    sendUserEmailMock.mockResolvedValue({ success: false, error: 'Send failed: invalid_grant' });
    const h = new ForwardEmailHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('failed');
    const results = (out.output as any).results;
    expect(results.every((r: any) => /invalid_grant/.test(r.error))).toBe(true);
  });

  it('partial failure still succeeds but records per-recipient errors', async () => {
    sendUserEmailMock
      .mockResolvedValueOnce({ success: true, messageId: 'sent_new_1', threadId: 'thr_fwd' })
      .mockResolvedValueOnce({ success: false, error: 'Send failed: bounced' });
    const h = new ForwardEmailHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(true);
    const o = out.output as any;
    expect(o.successCount).toBe(1);
    expect(o.failCount).toBe(1);
  });

  it('returns ok:false when the original message cannot be resolved', async () => {
    feedEventFindFirstMock.mockResolvedValue(null);
    getHeadersMock.mockResolvedValue({ error: 'Header fetch failed: not found' });
    readEmailMock.mockResolvedValue({ error: 'Gmail error: not found' });
    const h = new ForwardEmailHandler();
    const out = await h.execute(ctx as any);
    expect(out.ok).toBe(false);
    expect(sendUserEmailMock).not.toHaveBeenCalled();
  });
});

describe('ForwardEmailHandler.confirm', () => {
  const ctx = { ...baseCtx, payload: { threadId: 'thr_1', to: ['dave@external.com'] } };

  it('confirms every claimed send via Gmail read-back', async () => {
    readEmailMock.mockResolvedValue({ email: { id: 'sent_new_1' } });
    const h = new ForwardEmailHandler();
    const ok = await h.confirm(ctx as any, { results: [{ recipient: 'dave@external.com', messageId: 'sent_new_1' }] });
    expect(ok).toBe(true);
    expect(readEmailMock).toHaveBeenCalledWith(2, 'sent_new_1');
  });

  it('fails closed when any claimed send cannot be read back', async () => {
    readEmailMock
      .mockResolvedValueOnce({ email: { id: 'sent_new_1' } })
      .mockResolvedValueOnce({ error: 'Gmail error: not found' });
    const h = new ForwardEmailHandler();
    const ok = await h.confirm(ctx as any, {
      results: [
        { recipient: 'dave@external.com', messageId: 'sent_new_1' },
        { recipient: 'erin@external.com', messageId: 'sent_new_2' },
      ],
    });
    expect(ok).toBe(false);
  });

  it('fails closed on empty/malformed output', async () => {
    const h = new ForwardEmailHandler();
    expect(await h.confirm(ctx as any, { results: [] })).toBe(false);
    expect(await h.confirm(ctx as any, undefined)).toBe(false);
  });

  it('IMAP-fallback ids get a receipt-format check only', async () => {
    const h = new ForwardEmailHandler();
    const ok = await h.confirm(ctx as any, { results: [{ recipient: 'dave@external.com', messageId: '<smtp-9@tmcltd.ai>' }] });
    expect(ok).toBe(true);
    expect(readEmailMock).not.toHaveBeenCalled();
  });
});
