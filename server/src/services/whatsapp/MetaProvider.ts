// ═════════════════════════════════════════════════════════════════════════════
// MetaProvider — Production WhatsApp provider via Meta Cloud API
//
// Stateless — credentials stored in whatsapp_config (encrypted).
// No QR code needed. Webhook handles inbound messages.
// ═════════════════════════════════════════════════════════════════════════════

import { IWhatsAppProvider, SendMessageParams, SendResult, ConnectionStatus, TestResult } from './IWhatsAppProvider';
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
// DEF-195 — the one transport policy, applied at the provider boundary.
import { fitToTransport } from '../knowledge/transportBudget';

const log = createLogger('whatsapp:meta');

async function getDecryptedConfig(clientNumber: string) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT meta_phone_number_id, meta_access_token, meta_business_id, meta_webhook_secret
     FROM whatsapp_config WHERE client_number = $1`, clientNumber,
  ) as any[];
  if (!rows.length) throw new Error('WhatsApp config not found');
  const row = rows[0];

  // Decrypt sensitive fields via configService
  const { decrypt } = await import('../configService');
  return {
    phoneNumberId: row.meta_phone_number_id,
    accessToken: row.meta_access_token ? await decrypt(row.meta_access_token) : null,
    businessId: row.meta_business_id,
    webhookSecret: row.meta_webhook_secret ? await decrypt(row.meta_webhook_secret) : null,
  };
}

export class MetaProvider implements IWhatsAppProvider {

  async initialize(clientNumber: string): Promise<void> {
    const result = await this.testConnection(clientNumber);
    await prisma.$executeRawUnsafe(
      `UPDATE whatsapp_config SET status = $1, connected_number = $2, connected_at = CASE WHEN $1 = 'connected' THEN NOW() ELSE connected_at END, last_error = $3, last_error_at = CASE WHEN $3 IS NOT NULL THEN NOW() ELSE last_error_at END WHERE client_number = $4`,
      result.success ? 'connected' : 'error',
      result.connectedNumber || null,
      result.error || null,
      clientNumber,
    );
  }

  async getQRCode(): Promise<null> {
    return null; // Meta does not use QR codes
  }

  async testConnection(clientNumber: string): Promise<TestResult> {
    try {
      const config = await getDecryptedConfig(clientNumber);
      if (!config.phoneNumberId || !config.accessToken) {
        return { success: false, error: 'Meta credentials not configured' };
      }
      const resp = await fetch(
        `https://graph.facebook.com/v18.0/${config.phoneNumberId}`,
        { headers: { Authorization: `Bearer ${config.accessToken}` } },
      );
      if (!resp.ok) {
        const err = await resp.json() as any;
        return { success: false, error: err.error?.message || `Meta API ${resp.status}` };
      }
      const data = await resp.json() as any;
      return { success: true, connectedNumber: data.display_phone_number };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async sendMessage(params: SendMessageParams): Promise<SendResult> {
    try {
      const config = await getDecryptedConfig(params.clientNumber);
      const body = params.messageType === 'template'
        ? {
            messaging_product: 'whatsapp', to: params.to, type: 'template',
            template: {
              name: params.templateName, language: { code: 'en' },
              components: [{ type: 'body', parameters: (params.templateParams || []).map(p => ({ type: 'text', text: p })) }],
            },
          }
        : { messaging_product: 'whatsapp', to: params.to, type: 'text', text: { body: fitToTransport(params.message).body } };

      const resp = await fetch(
        `https://graph.facebook.com/v18.0/${config.phoneNumberId}/messages`,
        { method: 'POST', headers: { Authorization: `Bearer ${config.accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      );
      const data = await resp.json() as any;
      if (!resp.ok) return { success: false, error: data.error?.message || 'Meta send failed' };
      return { success: true, messageId: data.messages?.[0]?.id };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }

  async disconnect(clientNumber: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `UPDATE whatsapp_config SET status = 'disconnected' WHERE client_number = $1`, clientNumber,
    );
  }

  async getStatus(clientNumber: string): Promise<ConnectionStatus> {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT status, connected_number, last_error FROM whatsapp_config WHERE client_number = $1`, clientNumber,
    ) as any[];
    if (!rows.length) return { status: 'disconnected' };
    return {
      status: (rows[0].status || 'disconnected') as ConnectionStatus['status'],
      connectedNumber: rows[0].connected_number || undefined,
      error: rows[0].last_error || undefined,
    };
  }
}
