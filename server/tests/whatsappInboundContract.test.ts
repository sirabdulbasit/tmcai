import { describe, expect, it } from 'vitest';
import { inboundDedupKey } from '../src/services/whatsapp/WhatsAppInbound';

describe('WhatsApp inbound message contract', () => {
  it('does not collapse two real messages just because their text matches', () => {
    const common = { fromNumber: '+923001234567', messageBody: 'yes' };
    expect(inboundDedupKey({ ...common, waMessageId: 'wamid.1' }))
      .not.toBe(inboundDedupKey({ ...common, waMessageId: 'wamid.2' }));
  });

  it('uses a deterministic fallback only when the provider has no id', () => {
    expect(inboundDedupKey({
      fromNumber: '+923001234567', messageBody: 'yes',
    })).toBe('fallback:+923001234567:yes');
  });
});
