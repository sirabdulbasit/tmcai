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

export function whatsappMessageLogStatus(result: SendResult): 'sent' | 'sent_unconfirmed' | 'failed' {
  if (!result.success) return 'failed';
  return result.confirmation === 'transport_accepted' || !result.messageId
    ? 'sent_unconfirmed'
    : 'sent';
}
