import prisma from '../../db/prisma';

/**
 * Mirror Meta credentials used by the outbound notifier into the shared
 * WhatsApp configuration row without changing the tenant's inbound channel.
 *
 * A tenant may receive messages through a QR/Web.js session while sending
 * proactive messages through Meta Cloud API. Saving outbound credentials must
 * therefore never switch `provider`, claim the inbound channel is connected,
 * replace its connected number, or disturb its QR session state.
 *
 * Inbound provider changes belong to WhatsAppManager.saveWhatsAppConfig(),
 * which is called by the explicit /admin/whatsapp/config endpoint.
 */
export async function mirrorNotifierCredentials(args: {
  clientNumber: string;
  phoneNumberId: string;
  accessToken?: string | null;
  wabaId?: string | null;
}): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO whatsapp_config
       (client_number, provider, meta_phone_number_id, meta_access_token,
        meta_business_id, status, created_at, updated_at)
     VALUES ($1, 'webjs', $2, $3, $4, 'disconnected', NOW(), NOW())
     ON CONFLICT (client_number) DO UPDATE SET
       meta_phone_number_id = EXCLUDED.meta_phone_number_id,
       meta_access_token    = COALESCE(EXCLUDED.meta_access_token, whatsapp_config.meta_access_token),
       meta_business_id     = COALESCE(EXCLUDED.meta_business_id, whatsapp_config.meta_business_id),
       updated_at           = NOW()`,
    args.clientNumber,
    args.phoneNumberId,
    args.accessToken || null,
    args.wabaId || null,
  );
}

/** Store/rotate the Meta webhook verification token, also without activating
 * Meta inbound implicitly. An absent row is created in the schema's safe
 * webjs/disconnected state; the operator must explicitly select Meta inbound. */
export async function storeMetaWebhookSecret(clientNumber: string, secret: string): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO whatsapp_config
       (client_number, provider, meta_webhook_secret, status, created_at, updated_at)
     VALUES ($1, 'webjs', $2, 'disconnected', NOW(), NOW())
     ON CONFLICT (client_number) DO UPDATE SET
       meta_webhook_secret = EXCLUDED.meta_webhook_secret,
       updated_at = NOW()`,
    clientNumber,
    secret,
  );
}
