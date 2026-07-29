import createLogger from '../../utils/logger';

const log = createLogger('whatsapp:media');

export interface DownloadedInboundMedia {
  data: string;
  mimetype?: string;
  filename?: string;
  filesize?: number;
}

const wait = (ms: number) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
});

function describeMediaError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 180);
  try { return JSON.stringify(error).slice(0, 180); }
  catch { return String(error).slice(0, 180); }
}

/**
 * Newly-arrived Web.js PTT objects can be emitted before WhatsApp has moved
 * mediaData from FETCHING/REUPLOADING to RESOLVED, especially for @lid chats.
 * Refresh the message object and retry with bounded delays. This helper stops
 * at the provider boundary: it never sends a reply and never contacts STT.
 */
export async function downloadInboundMedia(
  message: any,
  options: { delaysMs?: number[]; clientNumber?: string; messageId?: string } = {},
): Promise<DownloadedInboundMedia | null> {
  const delays = options.delaysMs ?? [0, 400, 1_200];
  let candidate = message;
  let lastError = '';

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    const delay = delays[attempt] ?? 0;
    if (delay > 0) await wait(delay);
    try {
      if (attempt > 0) {
        const id = message?.id?._serialized;
        if (attempt === 1 && typeof candidate?.reload === 'function') {
          candidate = await candidate.reload() || candidate;
        } else if (id && typeof message?.client?.getMessageById === 'function') {
          candidate = await message.client.getMessageById(id) || candidate;
        } else if (typeof candidate?.reload === 'function') {
          candidate = await candidate.reload() || candidate;
        }
      }
      const media = await candidate.downloadMedia();
      if (media?.data) {
        log.info('Inbound media downloaded', {
          clientNumber: options.clientNumber,
          messageId: options.messageId,
          attempt: attempt + 1,
          bytesBase64: media.data.length,
          mimeType: String(media.mimetype || '').split(';')[0],
        });
        return media;
      }
      lastError = 'download returned no media data';
    } catch (error: unknown) {
      lastError = describeMediaError(error);
    }
    log.warn('Inbound media download attempt failed', {
      clientNumber: options.clientNumber,
      messageId: options.messageId,
      attempt: attempt + 1,
      error: lastError,
    });
  }

  // REQ-009 — final limb: re-fetch the message through its PHONE-Wid chat.
  //
  // On an @lid chat the originally emitted PTT object can stay
  // permanently unresolvable while the identical message is downloadable
  // via the phone-identity chat. Chat 12's ladder only ever reloaded the
  // SAME identity, so a voice note in this state failed every attempt and
  // the turn died silently ~2s in — exactly what production showed on
  // 2026-07-28 11:04. Tried last: the direct object is correct whenever
  // it works, and this costs an extra page round-trip.
  try {
    const { resolveMessageViaPhoneChat } = await import('./waIdentity');
    const viaPhone = await resolveMessageViaPhoneChat(message);
    if (viaPhone) {
      const media = await viaPhone.downloadMedia();
      if (media?.data) {
        log.info('Inbound media downloaded via LID phone mapping', {
          clientNumber: options.clientNumber,
          messageId: options.messageId,
          bytesBase64: media.data.length,
          mimeType: String(media.mimetype || '').split(';')[0],
        });
        return media;
      }
      lastError = 'phone-chat re-fetch returned no media data';
    }
  } catch (error: unknown) {
    lastError = describeMediaError(error);
  }

  log.error('Inbound media download exhausted retries', {
    clientNumber: options.clientNumber,
    messageId: options.messageId,
    attempts: delays.length,
    phoneChatLimbTried: true,
    error: lastError,
  });
  return null;
}
