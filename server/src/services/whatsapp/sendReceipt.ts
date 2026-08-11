import { SendResult } from './IWhatsAppProvider';

export const WEBJS_RECEIPT_UNAVAILABLE =
  'WhatsApp Web accepted the send, but did not return a message receipt ID';

/**
 * whatsapp-web.js can resolve Client.sendMessage() after the message has been
 * placed on the wire while returning an object without `id` (observed on
 * 1.34.6 in production). That is not a confirmed delivery, but it is also not
 * a send failure: retrying can produce duplicate messages.
 */
export function classifyWebjsSendResult(message: any): SendResult {
  const messageId = message?.id?._serialized || message?.id?.id;
  if (messageId) {
    return { success: true, messageId, confirmation: 'provider_receipt' };
  }
  return {
    success: true,
    confirmation: 'transport_accepted',
    warning: WEBJS_RECEIPT_UNAVAILABLE,
  };
}

/**
 * DEF-124 — recover our own message id when the library will not give it.
 *
 * Owner, 2026-08-11, on WhatsApp's quote-reply: *"there is a option in Whatsapp
 * to send response by selecting any message so which indicates the response
 * belongs to — do you know this function?"*
 *
 * Brain does. It is RULE ONE of delegation correlation, ahead of all guessing.
 * It has also never once fired, and the measurement says why:
 *
 *   inbound replies:    7 total,  5 carrying a quoted id
 *   outbound receipts: 27 total,  0 carrying a provider id
 *
 * Hamna quotes the exact message she is answering. Brain receives her quoted id
 * (3EB00A2EA4AC5DB364C4C8 on 08-11) and has nothing to match it against,
 * because whatsapp-web.js 1.34.6 resolves sendMessage() WITHOUT an id. That id
 * appears nowhere in the database and nowhere in the logs — Brain never learns
 * what its own message was called, so every reply falls through to guessing by
 * recency, and the owner gets "I could not tell which item".
 *
 * The recovery is to ask the chat. A message we just sent is in it; find the
 * most recent outgoing message whose body matches what we sent. Bounded to a
 * few messages and a short window so it can never wander onto an older send.
 *
 * Best-effort by construction: the send has already SUCCEEDED by the time this
 * runs. Failing to learn the id must never turn a delivered message into a
 * reported failure — that is the DEF-052 mistake in reverse.
 */
export async function recoverSentMessageId(
  chat: any,
  sentBody: string,
  opts: { lookback?: number; maxAgeMs?: number } = {},
): Promise<string | null> {
  const lookback = opts.lookback ?? 5;
  const maxAgeMs = opts.maxAgeMs ?? 60_000;
  try {
    if (!chat?.fetchMessages) return null;
    const recent = await chat.fetchMessages({ limit: lookback });
    if (!Array.isArray(recent)) return null;

    const needle = (sentBody ?? '').trim();
    const cutoffSec = (Date.now() - maxAgeMs) / 1000;

    // Newest first: the message we just sent is the last one, not the first
    // time this text ever appeared. Matching oldest-first would attach a
    // quote-reply to a repeat of the same reminder from days ago.
    for (const m of [...recent].reverse()) {
      if (!m?.fromMe) continue;
      if (typeof m.timestamp === 'number' && m.timestamp < cutoffSec) continue;
      if ((m.body ?? '').trim() !== needle) continue;
      const id = m?.id?._serialized || m?.id?.id;
      if (id) return String(id);
    }
    return null;
  } catch {
    return null;
  }
}

export function whatsappMessageLogStatus(result: SendResult): 'sent' | 'sent_unconfirmed' | 'failed' {
  if (!result.success) return 'failed';
  return result.confirmation === 'transport_accepted' || !result.messageId
    ? 'sent_unconfirmed'
    : 'sent';
}
