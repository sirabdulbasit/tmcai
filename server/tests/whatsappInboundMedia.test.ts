import { describe, expect, it, vi } from 'vitest';
import { downloadInboundMedia } from '../src/services/whatsapp/inboundMedia';

describe('WhatsApp inbound media acquisition', () => {
  it('returns media immediately when the emitted message is resolved', async () => {
    const media = { data: 'T2dnUw==', mimetype: 'audio/ogg; codecs=opus' };
    const message = { downloadMedia: vi.fn(async () => media) };
    await expect(downloadInboundMedia(message, { delaysMs: [0] })).resolves.toBe(media);
    expect(message.downloadMedia).toHaveBeenCalledOnce();
  });

  it('reloads and retries when a newly arrived @lid PTT throws a transient error', async () => {
    const media = { data: 'T2dnUw==', mimetype: 'audio/ogg' };
    const fresh = { downloadMedia: vi.fn(async () => media), reload: vi.fn() };
    const message = {
      downloadMedia: vi.fn(async () => { throw 'r'; }),
      reload: vi.fn(async () => fresh),
    };
    await expect(downloadInboundMedia(message, { delaysMs: [0, 0] })).resolves.toBe(media);
    expect(message.reload).toHaveBeenCalledOnce();
    expect(fresh.downloadMedia).toHaveBeenCalledOnce();
  });

  it('returns null after bounded failures instead of misreporting an STT outage', async () => {
    const message = {
      downloadMedia: vi.fn(async () => undefined),
      reload: vi.fn(async function (this: any) { return this; }),
    };
    await expect(downloadInboundMedia(message, { delaysMs: [0, 0, 0] })).resolves.toBeNull();
    expect(message.downloadMedia).toHaveBeenCalledTimes(3);
  });

  it('uses a freshly fetched message object on the final retry when available', async () => {
    const media = { data: 'T2dnUw==', mimetype: 'audio/ogg' };
    const fresh = { downloadMedia: vi.fn(async () => media) };
    const message: any = {
      id: { _serialized: 'false_173555350261799@lid_ABC' },
      downloadMedia: vi.fn(async () => undefined),
      reload: vi.fn(async function (this: any) { return this; }),
      client: { getMessageById: vi.fn(async () => fresh) },
    };
    await expect(downloadInboundMedia(message, { delaysMs: [0, 0, 0] })).resolves.toBe(media);
    expect(message.client.getMessageById).toHaveBeenCalledWith(message.id._serialized);
    expect(fresh.downloadMedia).toHaveBeenCalledOnce();
  });
});
