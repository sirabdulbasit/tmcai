// ═════════════════════════════════════════════════════════════════════════════
// WhatsAppManager — Orchestrator that routes to correct provider per tenant
//
// getProvider(clientNumber) → reads config → returns WebjsProvider or MetaProvider
// sendWhatsAppMessage() → checks limits → sends via provider → logs message
// ═════════════════════════════════════════════════════════════════════════════

import { IWhatsAppProvider } from './IWhatsAppProvider';
import { WebjsProvider } from './WebjsProvider';
import { MetaProvider } from './MetaProvider';
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { whatsappMessageLogStatus } from './sendReceipt';
import { SendResult } from './IWhatsAppProvider';

const log = createLogger('whatsapp:manager');

// Cached provider instances per tenant
const providers = new Map<string, IWhatsAppProvider>();

// ─── Provider factory ─────────────────────────────────────────────────────────

export async function getProvider(clientNumber: string): Promise<IWhatsAppProvider> {
  if (providers.has(clientNumber)) return providers.get(clientNumber)!;

  const rows = await prisma.$queryRawUnsafe(
    `SELECT provider FROM whatsapp_config WHERE client_number = $1`, clientNumber,
  ) as any[];

  if (!rows.length) throw new Error(`No WhatsApp config for ${clientNumber}`);

  let provider: IWhatsAppProvider;
  switch (rows[0].provider) {
    case 'meta':
      provider = new MetaProvider();
      break;
    case 'webjs':
    default:
      provider = new WebjsProvider();
      break;
  }

  providers.set(clientNumber, provider);
  return provider;
}

/** Clear cached provider (call after config change so it re-creates with new settings) */
export function clearProviderCache(clientNumber: string): void {
  providers.delete(clientNumber);
}

/** Stop a live inbound provider before changing its configured type. */
async function disposeCachedProvider(clientNumber: string): Promise<void> {
  const provider = providers.get(clientNumber);
  if (!provider) return;
  try {
    await provider.disconnect(clientNumber);
  } catch (error: any) {
    log.warn('Provider disposal failed during config switch', {
      clientNumber, error: error?.message,
    });
  } finally {
    providers.delete(clientNumber);
  }
}

// ─── Initialize all connected tenants on server startup ───────────────────────

export async function initializeAllTenants(): Promise<void> {
  const configs = await prisma.$queryRawUnsafe(
    `SELECT client_number FROM whatsapp_config WHERE status != 'disconnected'`,
  ) as any[];

  for (const config of configs) {
    try {
      providers.delete(config.client_number);
      const provider = await getProvider(config.client_number);
      await provider.initialize(config.client_number);
      log.info('Initialized', { clientNumber: config.client_number });
    } catch (error: any) {
      log.error('Init failed', { clientNumber: config.client_number, error: error.message });
    }
  }
}

// ─── Send message via correct provider ────────────────────────────────────────

export async function sendWhatsAppMessage(params: {
  clientNumber: string;
  to: string;
  message: string;
  messageType?: 'text' | 'template';
  templateName?: string;
  templateParams?: string[];
  agentId?: number;
  userId?: number;
  requiresApproval?: boolean;
}): Promise<SendResult> {
  // Read config first to confirm tenant exists + connected. We still
  // need this for status, connected_number, and the requires-approval
  // path; the LIMIT check moves to an atomic conditional update below.
  const configs = await prisma.$queryRawUnsafe(
    `SELECT status, connected_number, daily_limit, messages_today FROM whatsapp_config WHERE client_number = $1`,
    params.clientNumber,
  ) as any[];

  if (!configs.length) return { success: false, error: 'WhatsApp not configured' };
  const config = configs[0];

  if (config.status !== 'connected') return { success: false, error: `WhatsApp status: ${config.status}` };

  // `whatsapp_messages.user_id` is NOT NULL. Resolve a sane userId for
  // the log row: prefer the caller-provided one; if missing, fall back
  // to the tenant's first active SA (admin/superadmin). If even that
  // fails, refuse to send rather than leave an orphaned row attempt.
  let logUserId = params.userId ?? null;
  if (!logUserId) {
    const sa = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM users WHERE client_number = $1 AND is_active = TRUE
         AND user_type IN ('SA','AD') ORDER BY user_type, id LIMIT 1`,
      params.clientNumber,
    ).catch(() => [] as any[]);
    logUserId = sa[0]?.id ?? null;
  }
  if (!logUserId) {
    return { success: false, error: 'send refused — no userId and no SA/AD fallback for tenant' };
  }

  // If requires approval: queue as pending. Queued messages do NOT
  // consume a daily slot — they're claimed only when actually sent
  // (via approveQueuedMessage → sendWhatsAppMessage without
  // requiresApproval, which goes through the atomic-claim path below).
  if (params.requiresApproval) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO whatsapp_messages (client_number, user_id, direction, from_number, to_number, content, status, requires_approval, agent_id, created_at)
       VALUES ($1, $2, 'outbound', $3, $4, $5, 'queued', TRUE, $6, NOW())`,
      params.clientNumber, logUserId, config.connected_number || '', params.to,
      params.message, params.agentId || null,
    );
    return { success: true, messageId: 'pending_approval' };
  }

  // ── Atomic daily-limit claim ─────────────────────────────────
  //
  // Old pattern (read → check → send → increment) had a race: under
  // concurrent sends, multiple requests could pass the check before
  // any of them incremented, busting the daily cap. The fix is the
  // standard atomic-claim pattern — a single conditional UPDATE that
  // increments only when under limit, with the row count telling us
  // whether we got a slot.
  //
  // Rules:
  //   - rowcount = 0 → limit was hit (someone else got the last slot)
  //   - rowcount = 1 → slot claimed; we MUST either send successfully
  //                    OR refund the counter on failure
  //   - On send failure (network, provider error) we decrement back
  //     so a transient error doesn't permanently consume a slot.
  const claim = await prisma.$queryRawUnsafe<any[]>(
    `UPDATE whatsapp_config
        SET messages_today      = messages_today + 1,
            messages_this_month = messages_this_month + 1,
            last_message_at     = NOW(),
            updated_at          = NOW()
      WHERE client_number = $1
        AND messages_today < daily_limit
      RETURNING messages_today AS new_count, daily_limit AS limit_at`,
    params.clientNumber,
  ).catch(() => [] as any[]);

  if (claim.length === 0) {
    return { success: false, error: 'Daily message limit reached' };
  }

  const refundClaim = async () => {
    // Decrement back. Bounded at 0 so a refund storm can't go negative.
    await prisma.$executeRawUnsafe(
      `UPDATE whatsapp_config
          SET messages_today      = GREATEST(messages_today - 1, 0),
              messages_this_month = GREATEST(messages_this_month - 1, 0),
              updated_at          = NOW()
        WHERE client_number = $1`,
      params.clientNumber,
    ).catch(() => {});
  };

  // Send
  try {
    const provider = await getProvider(params.clientNumber);
    const result = await provider.sendMessage({
      clientNumber: params.clientNumber,
      to: params.to,
      message: params.message,
      messageType: params.messageType || 'text',
      templateName: params.templateName,
      templateParams: params.templateParams,
    });

    // Log message
    await prisma.$executeRawUnsafe(
      `INSERT INTO whatsapp_messages (client_number, user_id, direction, from_number, to_number, content, wa_message_id, status, agent_id, created_at)
       VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7, $8, NOW())`,
      params.clientNumber, logUserId, config.connected_number || '', params.to,
      params.message, result.messageId || null, whatsappMessageLogStatus(result), params.agentId || null,
    );

    // Refund the claim if the actual send failed — the slot was
    // consumed by the atomic update but the message never went out.
    if (!result.success) {
      await refundClaim();
    }

    return result;
  } catch (error: any) {
    log.error('Send failed', { clientNumber: params.clientNumber, to: params.to, error: error.message });
    // Send threw before we could record an outcome — refund the slot
    // so a thrown error (network blip, puppeteer crash) doesn't burn
    // the user's daily quota silently.
    await refundClaim();
    return { success: false, error: error.message };
  }
}

/**
 * Send a voice note (OGG/Opus) via the active provider. Mirrors
 * sendWhatsAppMessage but for audio: same daily-limit atomic claim,
 * same logging shape, same refund-on-failure. Used by the unified
 * tenant-WhatsApp sender to deliver Brain-generated voice notes when
 * Meta /media isn't configured (the QR Code / webjs path).
 */
export async function sendWhatsAppVoiceNote(params: {
  clientNumber: string;
  to: string;
  audio: Buffer;
  mimeType?: string;
  caption?: string;             // logged alongside the row for audit
  agentId?: number;
  userId?: number;
}): Promise<SendResult> {
  const configs = await prisma.$queryRawUnsafe<any[]>(
    `SELECT status, connected_number, daily_limit, messages_today FROM whatsapp_config WHERE client_number = $1`,
    params.clientNumber,
  );
  if (!configs.length) return { success: false, error: 'WhatsApp not configured' };
  if (configs[0].status !== 'connected') return { success: false, error: `WhatsApp status: ${configs[0].status}` };

  let logUserId = params.userId ?? null;
  if (!logUserId) {
    const sa = await prisma.$queryRawUnsafe<any[]>(
      `SELECT id FROM users WHERE client_number = $1 AND is_active = TRUE
         AND user_type IN ('SA','AD') ORDER BY user_type, id LIMIT 1`,
      params.clientNumber,
    ).catch(() => [] as any[]);
    logUserId = sa[0]?.id ?? null;
  }
  if (!logUserId) return { success: false, error: 'send refused — no userId fallback' };

  // Same atomic-claim pattern as text sends (see sendWhatsAppMessage).
  const claim = await prisma.$queryRawUnsafe<any[]>(
    `UPDATE whatsapp_config
        SET messages_today      = messages_today + 1,
            messages_this_month = messages_this_month + 1,
            last_message_at     = NOW(),
            updated_at          = NOW()
      WHERE client_number = $1
        AND messages_today < daily_limit
      RETURNING messages_today AS new_count`,
    params.clientNumber,
  ).catch(() => [] as any[]);
  if (claim.length === 0) return { success: false, error: 'Daily message limit reached' };

  const refundClaim = async () => {
    await prisma.$executeRawUnsafe(
      `UPDATE whatsapp_config
          SET messages_today      = GREATEST(messages_today - 1, 0),
              messages_this_month = GREATEST(messages_this_month - 1, 0),
              updated_at          = NOW()
        WHERE client_number = $1`,
      params.clientNumber,
    ).catch(() => {});
  };

  try {
    const provider = await getProvider(params.clientNumber);
    // Only WebjsProvider implements sendVoiceMessage; Meta has its own
    // /media path called via whatsappNotifierService directly.
    if (typeof (provider as any).sendVoiceMessage !== 'function') {
      await refundClaim();
      return { success: false, error: 'voice note send not supported by current provider' };
    }
    const r = await (provider as any).sendVoiceMessage(
      params.clientNumber,
      params.to,
      params.audio,
      params.mimeType,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO whatsapp_messages (client_number, user_id, direction, from_number, to_number, content, wa_message_id, status, agent_id, created_at)
       VALUES ($1, $2, 'outbound', $3, $4, $5, $6, $7, $8, NOW())`,
      params.clientNumber, logUserId, configs[0].connected_number || '',
      params.to, `[voice note] ${params.caption ?? ''}`.trim(),
      r.messageId || null, whatsappMessageLogStatus(r), params.agentId || null,
    );
    if (!r.success) await refundClaim();
    return r;
  } catch (error: any) {
    await refundClaim();
    return { success: false, error: error.message };
  }
}

// ─── Save/update config (handles encryption) ─────────────────────────────────

export async function saveWhatsAppConfig(
  clientNumber: string,
  data: {
    provider: string;
    companyNumber?: string;
    metaPhoneNumberId?: string;
    metaAccessToken?: string;
    metaBusinessId?: string;
    metaWebhookSecret?: string;
    dailyLimit?: number;
    monthlyLimit?: number;
    maxTokensData?: number;
  },
): Promise<void> {
  const { encrypt } = await import('../configService');

  const encAccessToken = data.metaAccessToken ? await encrypt(data.metaAccessToken) : null;
  const encWebhookSecret = data.metaWebhookSecret ? await encrypt(data.metaWebhookSecret) : null;

  const exists = await prisma.$queryRawUnsafe(
    `SELECT provider FROM whatsapp_config WHERE client_number = $1`, clientNumber,
  ) as any[];

  if (exists.length && exists[0].provider !== data.provider) {
    await disposeCachedProvider(clientNumber);
  }

  if (exists.length) {
    await prisma.$executeRawUnsafe(
      `UPDATE whatsapp_config SET
        provider = $1,
        connected_number = COALESCE($2, connected_number),
        meta_phone_number_id = COALESCE($3, meta_phone_number_id),
        meta_access_token = COALESCE($4, meta_access_token),
        meta_business_id = COALESCE($5, meta_business_id),
        meta_webhook_secret = COALESCE($6, meta_webhook_secret),
        daily_limit = COALESCE($7, daily_limit),
        monthly_limit = COALESCE($8, monthly_limit),
        max_tokens_data = COALESCE($9, max_tokens_data),
        updated_at = NOW()
       WHERE client_number = $10`,
      data.provider,
      data.companyNumber || null,
      data.metaPhoneNumberId || null,
      encAccessToken,
      data.metaBusinessId || null,
      encWebhookSecret,
      data.dailyLimit || null,
      data.monthlyLimit || null,
      data.maxTokensData || null,
      clientNumber,
    );
  } else {
    await prisma.$executeRawUnsafe(
      `INSERT INTO whatsapp_config (client_number, provider, connected_number, meta_phone_number_id, meta_access_token, meta_business_id, meta_webhook_secret, daily_limit, monthly_limit, max_tokens_data, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'disconnected', NOW(), NOW())`,
      clientNumber, data.provider,
      data.companyNumber || null,
      data.metaPhoneNumberId || null, encAccessToken,
      data.metaBusinessId || null, encWebhookSecret,
      data.dailyLimit || 100, data.monthlyLimit || 2000, data.maxTokensData || 400,
    );
  }

  clearProviderCache(clientNumber);
}

// ─── Approve a queued message → send immediately ──────────────────────────────

export async function approveQueuedMessage(messageId: number, approvedBy: number): Promise<{ success: boolean; error?: string }> {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT client_number, to_number, content FROM whatsapp_messages WHERE id = $1 AND status = 'queued' AND requires_approval = TRUE`, messageId,
  ) as any[];
  if (!rows.length) return { success: false, error: 'Message not found or already processed' };

  const msg = rows[0];
  const result = await sendWhatsAppMessage({
    clientNumber: msg.client_number, to: msg.to_number, message: msg.content,
  });

  await prisma.$executeRawUnsafe(
    `UPDATE whatsapp_messages SET status = $1, approved_by = $2, approved_at = NOW(), wa_message_id = $3, error_message = $4 WHERE id = $5`,
    whatsappMessageLogStatus(result), approvedBy, result.messageId || null,
    result.error || result.warning || null, messageId,
  );

  return result;
}

// ─── Reject a queued message ──────────────────────────────────────────────────

export async function rejectQueuedMessage(messageId: number, rejectedBy: number): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE whatsapp_messages SET status = 'rejected', approved_by = $1, approved_at = NOW() WHERE id = $2 AND status = 'queued'`,
    rejectedBy, messageId,
  );
}

// ─── Daily counter reset (call from cron at midnight) ─────────────────────────

export async function resetDailyCounters(): Promise<void> {
  await prisma.$executeRawUnsafe(`UPDATE whatsapp_config SET messages_today = 0`);
}

// ─── Monthly counter reset (call from cron on 1st of month) ───────────────────

export async function resetMonthlyCounters(): Promise<void> {
  await prisma.$executeRawUnsafe(`UPDATE whatsapp_config SET messages_this_month = 0`);
}
