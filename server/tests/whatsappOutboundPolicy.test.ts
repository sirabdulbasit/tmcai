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

  it('describes id-less acceptance honestly and prevents retry', () => {
    const text = whatsappAcceptedMessage('Muhammad Yousaf', '+923028000553');
    expect(text).toContain('accepted');
    expect(text).toContain('did not return a receipt ID');
    expect(text).toContain("won't retry automatically");
  });
});
