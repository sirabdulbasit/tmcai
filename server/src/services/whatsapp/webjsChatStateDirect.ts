/**
 * Direct chat-state (typing / recording) — bypasses webjs's @lid-hostile
 * Wid construction.
 *
 * SAME ROOT CAUSE AS THE VOICE BUG (fixed 2026-08-04). The library does:
 *
 *   WWebJS.sendChatstate = async (state, chatId) => {
 *     chatId = window.require('WAWebWidFactory').createWid(chatId);   // <— here
 *     const ChatState = window.require('WAWebChatStateBridge');
 *     await ChatState.sendChatStateComposing(chatId);   // (or Recording / Paused)
 *   }
 *
 * `createWid` is the GENERIC constructor. A live probe of WidFactory showed
 * WhatsApp exposes LID-specific ones beside it — `createUserLidOrThrow`,
 * `asUserLidOrThrow`, `createWidFromWidLike` — which is strong evidence the
 * generic one does not accept the `@lid` domain. Handed a `<digits>@lid`
 * chat id it throws the minified `r`, before any presence is sent. That is
 * why typing AND recording AND clearState all failed identically on @lid
 * chats, while `message.reply()` (which constructs no Wid) kept working.
 *
 * The probe also confirmed all three ChatStateBridge senders are present, so
 * nothing here is reimplemented: we build the Wid with the constructor that
 * matches the domain, then call WhatsApp's own sender.
 *
 * Never throws. Presence is cosmetic — its failure must never touch a turn.
 */
import createLogger from '../../utils/logger';

const log = createLogger('whatsapp:chatstate-direct');

export type ChatState = 'typing' | 'recording' | 'stop';

export interface ChatStateOutcome {
  ok: boolean;
  /** Which constructor produced the Wid — useful when a build shifts again. */
  via?: string;
  reason?: string;
}

/**
 * Send a native chat state for `chatId`, choosing the Wid constructor by
 * domain. Returns `{ ok:false, reason }` instead of throwing.
 */
export async function sendChatStateDirect(
  client: any,
  chatId: string,
  state: ChatState,
): Promise<ChatStateOutcome> {
  const page = client?.pupPage;
  if (!page || typeof page.evaluate !== 'function') {
    return { ok: false, reason: 'no live page' };
  }
  if (!chatId) return { ok: false, reason: 'no chat id' };

  try {
    const out = await page.evaluate(async (id: string, want: string) => {
      const req = (window as any).require;
      let WidFactory: any;
      let ChatStateBridge: any;
      try {
        WidFactory = req('WAWebWidFactory');
        ChatStateBridge = req('WAWebChatStateBridge');
      } catch (err: any) {
        return { ok: false, reason: `module unavailable: ${err?.message ?? String(err)}` };
      }

      // Build the Wid with a constructor that accepts THIS domain. For @lid
      // the LID-specific ones are tried first; createWid is the last resort
      // precisely because it is what throws today.
      const isLid = id.endsWith('@lid');
      const attempts: Array<[string, () => any]> = isLid
        ? [
          ['createUserLidOrThrow', () => WidFactory.createUserLidOrThrow?.(id)],
          ['asUserLidOrThrow', () => WidFactory.asUserLidOrThrow?.(id)],
          ['createWidFromWidLike', () => WidFactory.createWidFromWidLike?.({ _serialized: id })],
          ['createWid', () => WidFactory.createWid?.(id)],
        ]
        : [
          ['createWid', () => WidFactory.createWid?.(id)],
          ['createWidFromWidLike', () => WidFactory.createWidFromWidLike?.({ _serialized: id })],
        ];

      let wid: any = null;
      let via = '';
      const errors: string[] = [];
      for (const [name, make] of attempts) {
        try {
          const candidate = make();
          if (candidate) { wid = candidate; via = name; break; }
          errors.push(`${name}: returned nothing`);
        } catch (err: any) {
          errors.push(`${name}: ${err?.message ?? String(err)}`);
        }
      }
      if (!wid) return { ok: false, reason: `no Wid constructor accepted the id — ${errors.join('; ')}` };

      const send = want === 'recording' ? ChatStateBridge.sendChatStateRecording
        : want === 'stop' ? ChatStateBridge.sendChatStatePaused
          : ChatStateBridge.sendChatStateComposing;
      if (typeof send !== 'function') return { ok: false, reason: `sender for '${want}' missing`, via };

      try {
        await send(wid);
        return { ok: true, via };
      } catch (err: any) {
        return { ok: false, via, reason: `send failed: ${err?.message ?? String(err)}` };
      }
    }, chatId, state);

    if (!out?.ok) {
      log.warn('direct chat state failed', { chatId, state, via: out?.via, reason: out?.reason });
      return { ok: false, via: out?.via, reason: out?.reason ?? 'unknown' };
    }
    return { ok: true, via: out.via };
  } catch (error: any) {
    return { ok: false, reason: String(error?.message ?? error).slice(0, 200) };
  }
}
