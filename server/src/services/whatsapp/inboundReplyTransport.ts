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
export async function sendInboundTextReply(message: any, text: string): Promise<SendResult> {
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
