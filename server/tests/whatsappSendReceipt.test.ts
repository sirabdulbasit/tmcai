import { describe, expect, it } from 'vitest';
import {
  classifyWebjsSendResult,
  whatsappMessageLogStatus,
} from '../src/services/whatsapp/sendReceipt';

describe('WhatsApp Web send receipt classification', () => {
  it('records an id-bearing result as provider-confirmed', () => {
    const result = classifyWebjsSendResult({ id: { _serialized: 'true_123@c.us_ABC' } });
    expect(result).toEqual({
      success: true,
      messageId: 'true_123@c.us_ABC',
      confirmation: 'provider_receipt',
    });
    expect(whatsappMessageLogStatus(result)).toBe('sent');
  });

  it('treats a resolved id-less send as accepted but unconfirmed, not failed', () => {
    const result = classifyWebjsSendResult(undefined);
    expect(result.success).toBe(true);
    expect(result.messageId).toBeUndefined();
    expect(result.confirmation).toBe('transport_accepted');
    expect(result.warning).toContain('did not return a message receipt ID');
    expect(whatsappMessageLogStatus(result)).toBe('sent_unconfirmed');
  });

  it('keeps actual provider failures failed', () => {
    expect(whatsappMessageLogStatus({ success: false, error: 'wire down' })).toBe('failed');
  });
});
