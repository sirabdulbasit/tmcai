/**
 * Tenant WhatsApp send primitive — channel-aware text/voice routing.
 *
 * Architectural rule: Brain ↔ user always runs over the tenant WhatsApp
 * number. This module is the single concrete implementation of "send
 * through whichever tenant channel is connected." It's used by:
 *
 *   1. brainContactsUser — Brain-initiated proactive pings (criticality,
 *      watchpoints, emergency). Wraps with audit + dedup.
 *   2. WhatsAppInbound.sendReply — replies to inbound user messages.
 *      Wraps with whatsapp_messages logging.
 *
 * Both callers should NOT call sendViaNotifier or sendWhatsAppMessage
 * directly — go through this module so a Meta-only tenant gets all
 * outbound (proactive + reactive) on Meta, and a webjs-only tenant
 * gets all outbound on webjs.
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { sendViaNotifier } from './whatsappNotifierService';

const log = createLogger('tenant-whatsapp');

export interface SendResult {
  ok: boolean;
  waMessageId?: string;
  error?: string;
  confirmation?: 'provider_receipt' | 'transport_accepted';
  warning?: string;
  /** Which channel actually delivered (or attempted) the send. */
  via?: 'meta' | 'webjs' | 'none';
  /** Distinguishes a real voice bubble from the built-in text fallback. */
  deliveredAs?: 'voice' | 'text';
}

/**
 * Send a text message through whichever tenant channel is configured.
 *
 * Resolution:
 *   1. Meta Notifier — only attempted when `tenant_whatsapp_notifier.is_active=TRUE`
 *      AND a token is stored. Skips placeholder configs entirely.
 *   2. Legacy whatsapp-web.js — attempted when `whatsapp_config.status='connected'`.
 *      Tolerates an empty in-memory client Map (post-restart) by re-running
 *      `provider.initialize()` to re-load LocalAuth, then retrying once.
 *
 * If neither is configured, returns a clear `unconfigured` error.
 */
export async function sendTenantWhatsAppText(
  clientNumber: string,
  toPhone: string,
  body: string,
  userId: number,
): Promise<SendResult> {
  const [notifier, legacy] = await Promise.all([
    prisma.tenantWhatsappNotifier.findUnique({
      where: { clientNumber },
      select: { isActive: true, accessTokenEncrypted: true, phoneNumberId: true },
    }).catch(() => null),
    prisma.$queryRawUnsafe<any[]>(
      `SELECT status FROM whatsapp_config WHERE client_number = $1`,
      clientNumber,
    ).catch(() => [] as any[]),
  ]);

  const metaReady = !!(notifier?.isActive && notifier.accessTokenEncrypted && notifier.phoneNumberId);
  const legacyReady = legacy?.[0]?.status === 'connected';

  if (metaReady) {
    const meta = await sendViaNotifier(clientNumber, toPhone, body);
    if (meta.ok) return {
      ok: true, waMessageId: meta.waMessageId, via: 'meta',
      confirmation: meta.waMessageId ? 'provider_receipt' : 'transport_accepted',
    };
    const configIssue = /token decrypt|no active|inactive/i.test(meta.error ?? '');
    if (!configIssue) return { ok: false, error: meta.error, via: 'meta' };
    log.warn('meta config issue, trying legacy webjs', { err: meta.error });
  }

  if (legacyReady) {
    const r = await sendViaLegacyWebjs(clientNumber, toPhone, body, userId);
    if (r.ok) return { ...r, via: 'webjs' };
    return { ok: false, error: metaReady ? `meta config; webjs: ${r.error}` : `webjs: ${r.error}`, via: 'webjs' };
  }

  return {
    ok: false,
    via: 'none',
    error: metaReady
      ? 'no tenant whatsapp channel available (legacy webjs disconnected; meta failed config)'
      : 'no tenant whatsapp channel configured — admin must set up Meta Notifier or pair legacy WhatsApp Web',
  };
}

/**
 * Send a voice note (OGG/Opus buffer) through whichever tenant channel
 * supports voice. Both Meta and the QR Code (webjs) paths are now
 * fully wired:
 *
 *   - Meta Notifier — uploads via /media → sends audio with voice=true
 *     so WhatsApp renders a voice bubble instead of a generic file
 *   - Legacy webjs — uses MessageMedia + sendAudioAsVoice:true via the
 *     new WebjsProvider.sendVoiceMessage method, with daily-limit
 *     accounting matching the text path
 *
 * If neither is available the dispatcher degrades to a plain text send
 * carrying the same body, so the user still gets the alert.
 */
export async function sendTenantWhatsAppVoiceNote(
  clientNumber: string,
  toPhone: string,
  audio: Buffer,
  textFallback: string,
  userId: number,
): Promise<SendResult> {
  const [notifier, legacy] = await Promise.all([
    prisma.tenantWhatsappNotifier.findUnique({
      where: { clientNumber },
      select: { isActive: true, accessTokenEncrypted: true, phoneNumberId: true },
    }).catch(() => null),
    prisma.$queryRawUnsafe<any[]>(
      `SELECT status FROM whatsapp_config WHERE client_number = $1`, clientNumber,
    ).catch(() => [] as any[]),
  ]);

  const metaReady = !!(notifier?.isActive && notifier.accessTokenEncrypted && notifier.phoneNumberId);
  const legacyReady = legacy?.[0]?.status === 'connected';

  if (metaReady) {
    const { sendVoiceNoteViaNotifier } = await import('./whatsappNotifierService');
    const r = await sendVoiceNoteViaNotifier(clientNumber, toPhone, audio, 'audio/ogg');
    if (r.ok) return {
      ok: true, waMessageId: r.waMessageId, via: 'meta',
      confirmation: r.waMessageId ? 'provider_receipt' : 'transport_accepted',
      deliveredAs: 'voice',
    };
    log.warn('meta voice note send failed, trying legacy webjs voice', { err: r.error });
  }

  if (legacyReady) {
    const { sendWhatsAppVoiceNote } = await import('../whatsapp/WhatsAppManager');
    const r = await sendWhatsAppVoiceNote({
      clientNumber, to: toPhone, audio,
      mimeType: 'audio/ogg; codecs=opus', userId,
      caption: textFallback.slice(0, 160),
    });
    if (r.success) return {
      ok: true, waMessageId: r.messageId, via: 'webjs',
      confirmation: r.confirmation,
      warning: r.warning,
      deliveredAs: 'voice',
    };
    log.warn('legacy webjs voice send failed, falling back to text', { err: r.error });
  }

  // Both voice paths failed (or were unavailable) — deliver the body as
  // text so the user still gets the message.
  const text = await sendTenantWhatsAppText(clientNumber, toPhone, textFallback, userId);
  return { ...text, deliveredAs: 'text' };
}

// ─── webjs send + auto-recovery (extracted from brainOutboundService) ───

async function sendViaLegacyWebjs(
  clientNumber: string,
  phone: string,
  body: string,
  userId: number,
): Promise<SendResult> {
  const { sendWhatsAppMessage, getProvider } = await import('../whatsapp/WhatsAppManager');

  const first = await sendWhatsAppMessage({ clientNumber, to: phone, message: body, userId });
  if (first.success) return {
    ok: true,
    waMessageId: first.messageId,
    confirmation: first.confirmation,
    warning: first.warning,
  };

  if (!/not connected|not initialized/i.test(first.error ?? '')) {
    return { ok: false, error: first.error };
  }

  log.warn('webjs in-memory client missing — re-initializing from LocalAuth', { clientNumber });
  try {
    const provider = await getProvider(clientNumber);
    await provider.initialize(clientNumber);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const t = await provider.testConnection(clientNumber).catch(() => ({ success: false }));
      if (t.success) break;
      await new Promise((r) => setTimeout(r, 800));
    }
  } catch (err: any) {
    return { ok: false, error: `webjs re-init failed: ${err.message}` };
  }

  const second = await sendWhatsAppMessage({ clientNumber, to: phone, message: body, userId });
  if (second.success) {
    log.info('webjs auto-recovery succeeded', { clientNumber });
    return {
      ok: true,
      waMessageId: second.messageId,
      confirmation: second.confirmation,
      warning: second.warning,
    };
  }
  return { ok: false, error: `webjs after re-init: ${second.error}` };
}
