/**
 * Direct media download — bypasses whatsapp-web.js's @lid-hostile lookup.
 *
 * THE BUG (proven on production 2026-08-04, after three wrong theories)
 * Message.downloadMedia() starts by resolving the message from its
 * serialized id:
 *
 *   Msg.get(msgId) || (await Msg.getMessagesById([msgId]))?.messages?.[0]
 *
 * For a LID chat that id looks like
 * `false_173555350261799@lid_3BF638C7C45849106817` — it EMBEDS the `@lid`
 * identity. Parsing it requires a LID-aware Wid constructor (WhatsApp keeps
 * `createUserLidOrThrow` / `asUserLidOrThrow` separate from `createWid`), and
 * the lookup throws the minified `r` before any network call — hence the
 * ~30ms failures with no媒体 log line.
 *
 * What is NOT broken: everything after the lookup. A step-by-step probe on a
 * real voice note returned `downloadAndMaybeDecrypt → 3646 bytes` and
 * `arrayBufferToBase64Async → 4864 chars`. The media pipeline is healthy;
 * only the id-based lookup is poisoned.
 *
 * So: find the message by scanning the in-page collection and comparing
 * `id._serialized` as a STRING — no Wid construction, no id parsing — then
 * run the library's own download sequence, which works. This keeps us on the
 * documented internals rather than reimplementing decryption.
 */
import createLogger from '../../utils/logger';

const log = createLogger('whatsapp:media-direct');

export interface DirectMedia {
  data: string;
  mimetype?: string;
  filename?: string;
  filesize?: number;
}

export interface DirectMediaOutcome {
  media: DirectMedia | null;
  /** Why it failed, for the caller's log. Never thrown. */
  reason?: string;
}

/**
 * Download a message's media by serialized id, without letting webjs parse
 * that id. Returns `{ media: null, reason }` on any failure — never throws,
 * because a media failure must degrade to "couldn't read that" and never
 * break the inbound turn.
 */
export async function downloadMediaDirect(
  client: any,
  candidateIds: Array<string | null | undefined>,
): Promise<DirectMediaOutcome> {
  const page = client?.pupPage;
  if (!page || typeof page.evaluate !== 'function') {
    return { media: null, reason: 'no live page' };
  }
  // Accept SEVERAL spellings of the id. Production showed the inbound
  // message object logging only the short id ("3B5730909A5EE9DA2D45"),
  // meaning `id._serialized` can be absent on the event object — which both
  // made an earlier version of this limb skip silently AND is very likely
  // what the library feeds into Msg.get(), explaining the original throw.
  const ids = candidateIds.map((v) => String(v ?? '').trim()).filter(Boolean);
  if (!ids.length) return { media: null, reason: 'no usable message id on the event object' };

  try {
    const out = await page.evaluate(async (msgIds: string[]) => {
      const req = (window as any).require;
      const Msg = req('WAWebCollections').Msg;

      // STRING comparison only. Msg.get()/getMessagesById() are deliberately
      // avoided: they parse the id, and a @lid id throws in the parser.
      // Match on the serialized form OR the short id, since the event object
      // and the collection model do not always agree.
      const models: any[] = (typeof Msg.getModelsArray === 'function'
        ? Msg.getModelsArray() : Msg.models) ?? [];
      const hit = (m: any) => {
        const ser = String(m?.id?._serialized ?? '');
        const short = String(m?.id?.id ?? '');
        return msgIds.some((id) => id === ser || (!!short && id === short) || (!!ser && ser.endsWith(`_${id}`)));
      };
      const msg = models.filter(hit).pop();
      if (!msg) {
        return {
          error: `message not in page collection (searched ${models.length} models for ${msgIds.join(' | ')})`,
        };
      }
      if (!msg.mediaData) return { error: 'message has no mediaData' };
      if (msg.mediaData.mediaStage === 'REUPLOADING') {
        return { error: 'media expired (REUPLOADING)' };
      }

      if (msg.mediaData.mediaStage !== 'RESOLVED') {
        try {
          await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
        } catch (err: any) {
          return { error: `resolve failed: ${err?.message ?? String(err)}` };
        }
      }
      const stage = String(msg.mediaData.mediaStage ?? '');
      if (stage.includes('ERROR') || stage === 'FETCHING') {
        return { error: `media not ready (stage=${stage})` };
      }

      try {
        const mockQpl = { addAnnotations() { return this; }, addPoint() { return this; } };
        const buf = await req('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
          directPath: msg.directPath,
          encFilehash: msg.encFilehash,
          filehash: msg.filehash,
          mediaKey: msg.mediaKey,
          mediaKeyTimestamp: msg.mediaKeyTimestamp,
          type: msg.type,
          signal: new AbortController().signal,
          downloadQpl: mockQpl,
        });
        const data = await (window as any).WWebJS.arrayBufferToBase64Async(buf);
        return {
          data,
          mimetype: msg.mimetype ?? undefined,
          filename: msg.filename ?? undefined,
          filesize: msg.size ?? undefined,
        };
      } catch (err: any) {
        return { error: `download failed: ${err?.message ?? String(err)}` };
      }
    }, ids);

    if (!out || out.error || !out.data) {
      return { media: null, reason: out?.error ?? 'no data returned' };
    }
    log.info('media downloaded via direct collection lookup', {
      bytesBase64: String(out.data).length,
      mimeType: String(out.mimetype ?? '').split(';')[0],
    });
    return { media: out as DirectMedia };
  } catch (error: any) {
    return { media: null, reason: String(error?.message ?? error).slice(0, 200) };
  }
}
