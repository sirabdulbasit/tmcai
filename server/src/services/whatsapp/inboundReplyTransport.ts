import { classifyWebjsSendResult } from './sendReceipt';
import type { SendResult } from './IWhatsAppProvider';

/**
 * Reply through the exact inbound message context. This matters for modern
 * WhatsApp `@lid` identities: message.getChat().sendMessage() can resolve a
 * virtual/LID chat that accepts the call without delivering into the user's
 * visible conversation. message.reply() preserves WhatsApp's own routing
 * context and quoted-message identity.
 */
export async function sendInboundTextReply(message: any, text: string): Promise<SendResult> {
  if (typeof message?.reply === 'function') {
    const sent = await message.reply(text);
    return classifyWebjsSendResult(sent);
  }

  // Backward-compatible fallback for test doubles/older library objects.
  const chat = await message.getChat();
  const sent = await chat.sendMessage(text);
  return classifyWebjsSendResult(sent);
}
