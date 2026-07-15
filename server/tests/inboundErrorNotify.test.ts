import { describe, it, expect, vi } from 'vitest';
import { maybeNotifyInboundError, INBOUND_ERROR_REPLY } from '../src/services/whatsapp/inboundErrorNotify';

// A7 — a caught exception cleared the ⏳ reaction with no reply; the user
// saw read+cleared and assumed Brain ignored them. On error we now send a
// bracketed system marker BEFORE clearing the reaction — but ONLY to
// registered senders (unregistered traffic must stay silently dropped).

const mkMessage = (sendMessage = vi.fn()) => ({
  getChat: async () => ({ sendMessage }),
  _send: sendMessage,
});

describe('maybeNotifyInboundError', () => {
  it('sends the bracketed marker to a registered sender', async () => {
    const msg = mkMessage();
    const sent = await maybeNotifyInboundError(msg, 2);
    expect(sent).toBe(true);
    expect(msg._send).toHaveBeenCalledWith(INBOUND_ERROR_REPLY);
    expect(INBOUND_ERROR_REPLY).toMatch(/^\[.*\]$/); // system marker, not fake-Brain prose
  });

  it('stays silent for unregistered senders (no resolved userId)', async () => {
    const msg = mkMessage();
    const sent = await maybeNotifyInboundError(msg, undefined);
    expect(sent).toBe(false);
    expect(msg._send).not.toHaveBeenCalled();
  });

  it('never throws even if the send itself fails', async () => {
    const msg = { getChat: async () => { throw new Error('chat gone'); } };
    const sent = await maybeNotifyInboundError(msg as any, 2);
    expect(sent).toBe(false);
  });
});
