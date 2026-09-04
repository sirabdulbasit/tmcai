import { classifyWebjsSendResult } from './sendReceipt';
import type { SendResult } from './IWhatsAppProvider';
// DEF-196 — the one transport policy.
import { fitToTransport } from '../knowledge/transportBudget';

/**
 * Reply through the exact inbound message context. This matters for modern
 * WhatsApp `@lid` identities: message.getChat().sendMessage() can resolve a
 * virtual/LID chat that accepts the call without delivering into the user's
 * visible conversation. message.reply() preserves WhatsApp's own routing
 * context and quoted-message identity.
 */
export async function sendInboundTextReply(
  message: any, text: string, clientNumber?: string,
): Promise<SendResult> {
  // OWNER RULING 2026-09-04 (DEF-320) — the `@lid` synthetic must never reach him "anywher on UI
  // and communication". Scrubbed HERE, beside `fitToTransport`, for the same reason that policy
  // lives here: this is the one place every conversational reply passes, and the `@lid` class
  // reached five occurrences by being closed one surface at a time.
  //
  // BEFORE the transport fit, deliberately: replacing a 15-digit token with a name changes the
  // length, so fitting first would budget against text that is not what gets sent.
  const { scrubSyntheticIdentities } = await import('./displayIdentity');
  text = await scrubSyntheticIdentities(text, clientNumber);
  // DEF-196 (Codex iteration-2 MEDIUM) — this is a WhatsApp wire path too, and
  // my DEF-195 invariant could not see it: it only recognised
  // `client.sendMessage(target, text)` and the Meta body shape, so
  // `message.reply(text)` and `chat.sendMessage(text)` passed a raw body to the
  // library while the guard stayed green. Fit ONCE here; both primitives below
  // send the same body.
  const wireBody = fitToTransport(text).body;

  if (typeof message?.reply === 'function') {
    const sent = await message.reply(wireBody);
    return classifyWebjsSendResult(sent);
  }

  // Backward-compatible fallback for test doubles/older library objects.
  const chat = await message.getChat();
  const sent = await chat.sendMessage(wireBody);
  return classifyWebjsSendResult(sent);
}
