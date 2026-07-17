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

  log.error('Inbound media download exhausted retries', {
    clientNumber: options.clientNumber,
    messageId: options.messageId,
    attempts: delays.length,
    error: lastError,
  });
  return null;
}
