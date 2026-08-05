import { describe, expect, it } from 'vitest';
import {
  normalizeWhatsAppSubstantiveMessage,
  whatsappAcceptedMessage,
} from '../src/services/knowledge/whatsappOutboundPolicy';

describe('WhatsApp outbound message policy', () => {
  it('removes the duplicate greeting seen in the Yousaf production chat', () => {
    expect(normalizeWhatsAppSubstantiveMessage(
      'Hi Yousaf. Sir is asking for a status update on the EXIM solution item.',
      'Muhammad Yousaf',
    )).toBe('Sir is asking for a status update on the EXIM solution item.');
  });

  it('removes a model-authored assistant disclosure owned by the dispatcher', () => {
    expect(normalizeWhatsAppSubstantiveMessage(
      "Hello Muhammad Yousaf, this is Suzi, Basit's AI assistant. Basit asked me to let you know: The meeting moved to Friday.",
      'Muhammad Yousaf',
    )).toBe('Basit asked me to let you know: The meeting moved to Friday.');
  });

  it('reports the send plainly, without leaking plumbing (DEF-052)', () => {
    // CHANGED 2026-08-05. The old wording — "WhatsApp accepted the message …
    // but did not return a receipt ID. I won't retry automatically because
    // that could send a duplicate" — put three pieces of internals into a
    // human conversation and framed a successful send as a partial failure.
    // Owner: "when received then just update me that 'Message sent to Hamna'".
    //
    // It read that way because nothing consumed the delivery ticks, so the
    // send path genuinely did not know the outcome. message_ack is now
    // recorded (outboundAckService), so delivery is a ledger fact and this
    // line only has to say the message went.
    const text = whatsappAcceptedMessage('Muhammad Yousaf', '+923028000553');
    expect(text).toBe('Message sent to Muhammad.');
    expect(text).not.toMatch(/receipt ID|accepted|retry/);
  });
});
