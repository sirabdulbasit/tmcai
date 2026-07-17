import { beforeEach, describe, expect, it, vi } from 'vitest';

const notifierFind = vi.fn();
const queryRaw = vi.fn();
const sendVoiceNoteViaNotifier = vi.fn();
const sendWhatsAppVoiceNote = vi.fn();
const sendWhatsAppMessage = vi.fn();

vi.mock('../src/db/prisma', () => ({
  default: {
    tenantWhatsappNotifier: { findUnique: (...args: any[]) => notifierFind(...args) },
    $queryRawUnsafe: (...args: any[]) => queryRaw(...args),
  },
}));
vi.mock('../src/services/notifications/whatsappNotifierService', () => ({
  sendViaNotifier: vi.fn(),
  sendVoiceNoteViaNotifier: (...args: any[]) => sendVoiceNoteViaNotifier(...args),
}));
vi.mock('../src/services/whatsapp/WhatsAppManager', () => ({
  sendWhatsAppVoiceNote: (...args: any[]) => sendWhatsAppVoiceNote(...args),
  sendWhatsAppMessage: (...args: any[]) => sendWhatsAppMessage(...args),
  getProvider: vi.fn(),
}));

import { sendTenantWhatsAppVoiceNote } from '../src/services/notifications/tenantWhatsappSender';

beforeEach(() => {
  vi.clearAllMocks();
  notifierFind.mockResolvedValue(null);
  queryRaw.mockResolvedValue([{ status: 'connected' }]);
  sendWhatsAppMessage.mockResolvedValue({
    success: true, messageId: 'text-1', confirmation: 'provider_receipt',
  });
});

describe('tenant voice reply fallback', () => {
  it('sends exactly one text fallback when QR voice media fails', async () => {
    sendWhatsAppVoiceNote.mockResolvedValue({ success: false, error: 'media rejected' });
    const result = await sendTenantWhatsAppVoiceNote(
      'TMC-0001', '+923001234567', Buffer.from('audio'), 'Readable answer', 2,
    );
    expect(result).toMatchObject({ ok: true, deliveredAs: 'text', waMessageId: 'text-1' });
    expect(sendWhatsAppVoiceNote).toHaveBeenCalledOnce();
    expect(sendWhatsAppMessage).toHaveBeenCalledOnce();
  });

  it('does not send text inside the voice primitive when voice succeeds', async () => {
    sendWhatsAppVoiceNote.mockResolvedValue({
      success: true, messageId: 'voice-1', confirmation: 'provider_receipt',
    });
    const result = await sendTenantWhatsAppVoiceNote(
      'TMC-0001', '+923001234567', Buffer.from('audio'), 'Readable answer', 2,
    );
    expect(result).toMatchObject({ ok: true, deliveredAs: 'voice', waMessageId: 'voice-1' });
    expect(sendWhatsAppMessage).not.toHaveBeenCalled();
  });
});
