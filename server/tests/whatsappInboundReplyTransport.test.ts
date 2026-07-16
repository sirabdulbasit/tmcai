import { describe, expect, it, vi } from 'vitest';
import { sendInboundTextReply } from '../src/services/whatsapp/inboundReplyTransport';

describe('WhatsApp inbound reply routing', () => {
  it('prefers message.reply so @lid responses stay in the originating chat', async () => {
    const reply = vi.fn(async () => ({ id: { _serialized: 'reply-id' } }));
    const getChat = vi.fn();

    const result = await sendInboundTextReply({ reply, getChat }, 'Hello');

    expect(reply).toHaveBeenCalledWith('Hello');
    expect(getChat).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: true,
      messageId: 'reply-id',
      confirmation: 'provider_receipt',
    });
  });

  it('falls back to the chat transport for older message objects', async () => {
    const sendMessage = vi.fn(async () => undefined);
    const getChat = vi.fn(async () => ({ sendMessage }));

    const result = await sendInboundTextReply({ getChat }, 'Hello');

    expect(sendMessage).toHaveBeenCalledWith('Hello');
    expect(result.success).toBe(true);
    expect(result.confirmation).toBe('transport_accepted');
  });
});
