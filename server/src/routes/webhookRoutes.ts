// ═════════════════════════════════════════════════════════════════════════════
// webhookRoutes.ts — Public webhook endpoints (no auth — verified by signature)
// Mounted BEFORE body parser in app.ts for raw body signature verification
// ═════════════════════════════════════════════════════════════════════════════

import { Router } from 'express';
import crypto from 'crypto';
import prisma from '../db/prisma';
import createLogger from '../utils/logger';
import { verifyWebhookSignature } from '../middleware/webhookHmacAuth';
import { handleInboundEvent as gchatInbound } from '../services/connectors/GoogleChatConnector';
import { ingest as feedIngest } from '../services/feed/feedIngestionService';

const log = createLogger('webhook');
const router = Router();

// ─── HaseebOS v15 L1 — Slack Events API webhook ────────────────────
// Slack signs with x-slack-signature over the raw body + x-slack-request-timestamp.
// URL verification challenge returns the token; message events land in feed_events.
router.post('/webhooks/slack/:clientNumber', async (req, res) => {
  const { clientNumber } = req.params;
  const body = req.body ?? {};

  // Slack URL verification handshake
  if (body.type === 'url_verification') {
    res.status(200).json({ challenge: body.challenge });
    return;
  }

  try {
    const secret = process.env.SLACK_SIGNING_SECRET ?? '';
    const tsHeader = req.headers['x-slack-request-timestamp'] as string | undefined;
    const sigHeader = req.headers['x-slack-signature'] as string | undefined;
    if (secret && tsHeader && sigHeader) {
      const rawBody = (req as any).rawBody ?? JSON.stringify(body);
      const { SlackFeedAdapter } = await import('../services/adapters/impl/slackFeedAdapter');
      const ok = SlackFeedAdapter.verifySigning(secret, rawBody, tsHeader, sigHeader);
      if (!ok) {
        res.status(401).json({ error: 'invalid slack signature' });
        return;
      }
    }

    // Ack within 3s (Slack retries otherwise), process async
    res.sendStatus(200);

    const ev = body.event ?? {};
    if (ev.type === 'message' || ev.type === 'app_mention') {
      const sourceId = `${ev.channel}:${ev.ts}`;
      await feedIngest({
        clientNumber: String(clientNumber),
        sourceType: 'slack' as any,
        sourceId,
        payload: { ...ev, teamId: body.team_id },
      });
    }
  } catch (err: any) {
    log.error('Slack webhook error', { clientNumber, err: err.message });
  }
});

// ─── HaseebOS v15 F-2 — Google Chat inbound webhook ─────────────────
// Mount BEFORE the WhatsApp routes so the shared JSON body parser works.
// Google Chat sends a Bearer JWT signed by Google; our middleware validates it
// (optionally matches an allow-listed SA email from GOOGLE_WEBHOOK_SA).
router.post(
  '/webhooks/gchat',
  verifyWebhookSignature({ provider: 'google', allowUnsignedInDev: true }),
  async (req, res) => {
    try {
      await gchatInbound(req.body ?? {});
      res.sendStatus(204);
    } catch (err: any) {
      log.error('Google Chat webhook error', { err: err.message });
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── Generic inbound webhook (HMAC-signed) ──────────────────────────
// Any custom integration can POST here with `x-tmcai-signature: <sha256-hex>`
// header and a JSON body. Ingested directly into feed_events.
router.post(
  '/webhooks/generic/:clientNumber/:sourceType/:sourceId',
  verifyWebhookSignature({ provider: 'generic', allowUnsignedInDev: true }),
  async (req, res) => {
    const { clientNumber, sourceType, sourceId } = req.params;
    try {
      const result = await feedIngest({
        clientNumber: String(clientNumber),
        sourceType: sourceType as any,
        sourceId: String(sourceId),
        payload: req.body ?? {},
      });
      res.status(200).json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  },
);

// ─── Meta WhatsApp webhook verification (GET) ─────────────────────────────────
router.get('/webhooks/whatsapp/:clientNumber', async (req, res) => {
  const { clientNumber } = req.params;
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const rows = await prisma.$queryRawUnsafe(
    `SELECT meta_webhook_secret, provider FROM whatsapp_config WHERE client_number = $1`, clientNumber,
  ) as any[];

  if (mode === 'subscribe' && rows.length && rows[0].provider === 'meta' && token === rows[0].meta_webhook_secret) {
    log.info('Webhook verified', { clientNumber });
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─── Meta WhatsApp webhook receiver (POST) ────────────────────────────────────
router.post('/webhooks/whatsapp/:clientNumber', async (req, res) => {
  const { clientNumber } = req.params;

  // Verify X-Hub-Signature-256
  const rows = await prisma.$queryRawUnsafe(
    `SELECT meta_webhook_secret FROM whatsapp_config WHERE client_number = $1`, clientNumber,
  ) as any[];

  if (rows.length && rows[0].meta_webhook_secret) {
    const signature = req.headers['x-hub-signature-256'] as string;
    const rawBody = JSON.stringify(req.body);
    const expected = 'sha256=' + crypto.createHmac('sha256', rows[0].meta_webhook_secret).update(rawBody).digest('hex');
    if (signature !== expected) {
      log.warn('Invalid webhook signature', { clientNumber });
      res.sendStatus(403);
      return;
    }
  }

  // Acknowledge immediately (Meta requires < 5s)
  res.sendStatus(200);

  // Process asynchronously
  setImmediate(async () => {
    try {
      const body = req.body;
      if (body.object !== 'whatsapp_business_account') return;

      const { handleInboundMessage } = await import('../services/whatsapp/WhatsAppInbound');

      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const value = change.value;

          // Status updates (sent → delivered → read)
          for (const status of value.statuses || []) {
            await prisma.$executeRawUnsafe(
              `UPDATE whatsapp_messages SET status = $1, updated_at = NOW() WHERE wa_message_id = $2`,
              status.status, status.id,
            );
          }

          // Incoming messages
          for (const message of value.messages || []) {
            const isVoice = message.type === 'audio' || message.type === 'voice';
            let messageBody = message.text?.body || message.caption || '';
            let inputWasVoice = false;

            // Voice note inbound — parity with the legacy webjs path. The
            // Meta webhook only delivers a media id; we fetch the actual
            // audio bytes from /media, transcribe to text, and pass the
            // transcript on to handleInboundMessage. If transcription
            // fails, send back a "couldn't understand" prompt instead of
            // dropping the message silently.
            if (isVoice && message.audio?.id) {
              inputWasVoice = true;
              try {
                const audio = await downloadMetaMedia(clientNumber, message.audio.id);
                if (audio) {
                  const { transcribeVoiceNote } = await import('../services/voiceService');
                  const t = await transcribeVoiceNote(audio.buffer, audio.mimeType);
                  messageBody = t.text;
                  log.info('voice transcribed (meta)', { len: messageBody.length, lang: t.language });
                }
              } catch (err: any) {
                log.error('meta voice transcription failed', { error: err.message });
              }
              if (!messageBody) {
                const { sendTenantWhatsAppText } = await import('../services/notifications/tenantWhatsappSender');
                await sendTenantWhatsAppText(
                  clientNumber, '+' + message.from,
                  "Sorry, I couldn't understand the voice note. Please try again or type your message.",
                  0,
                );
                continue;
              }
            }

            // Build replyFn — when input was voice, the reply path generates
            // TTS + sends as a voice note via the unified tenant sender,
            // mirroring the webjs experience. Otherwise text only.
            const replyFn = inputWasVoice
              ? async (text: string) => {
                  const { textToVoiceNote } = await import('../services/voiceService');
                  const audioBuf = await textToVoiceNote(text);
                  if (audioBuf) {
                    const { sendTenantWhatsAppVoiceNote } = await import('../services/notifications/tenantWhatsappSender');
                    await sendTenantWhatsAppVoiceNote(clientNumber, '+' + message.from, audioBuf, text, 0);
                    // Also send text version so the user can re-read it.
                    const { sendTenantWhatsAppText } = await import('../services/notifications/tenantWhatsappSender');
                    await sendTenantWhatsAppText(clientNumber, '+' + message.from, text, 0);
                  } else {
                    const { sendTenantWhatsAppText } = await import('../services/notifications/tenantWhatsappSender');
                    await sendTenantWhatsAppText(clientNumber, '+' + message.from, text, 0);
                  }
                }
              : undefined;

            await handleInboundMessage({
              clientNumber,
              fromNumber: '+' + message.from,
              messageBody,
              messageType: isVoice ? 'voice' : message.type === 'image' ? 'image' : 'text',
              mediaUrl: message.image?.id || message.audio?.id || undefined,
              replyFn,
            });
          }
        }
      }
    } catch (err: any) {
      log.error('Webhook processing error', { clientNumber, error: err.message });
    }
  });
});

/**
 * Download a Meta-hosted media object by id.
 *
 * Meta returns audio/image/video as opaque ids in the webhook payload;
 * fetching the actual bytes is a two-hop: GET /{media-id} → returns a
 * temporary URL → GET that URL with the same bearer token → bytes.
 *
 * The temporary URL is valid for ~5 minutes, so we download immediately
 * inside the webhook handler (before the setImmediate completes).
 *
 * Uses the tenant's stored access token from `tenant_whatsapp_notifier`.
 */
async function downloadMetaMedia(
  clientNumber: string,
  mediaId: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const n = await prisma.tenantWhatsappNotifier.findUnique({
    where: { clientNumber },
    select: { accessTokenEncrypted: true },
  }).catch(() => null);
  if (!n?.accessTokenEncrypted) {
    log.warn('meta media download — notifier not configured', { clientNumber });
    return null;
  }
  const { decrypt } = await import('../services/notifications/whatsappNotifierService');
  let token: string;
  try { token = decrypt(n.accessTokenEncrypted); }
  catch { return null; }

  // Step 1: resolve media URL.
  const meta = await fetch(`https://graph.facebook.com/v18.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!meta.ok) {
    log.warn('meta media metadata fetch failed', { status: meta.status });
    return null;
  }
  const metaJson: any = await meta.json();
  const url = metaJson?.url;
  const mimeType = metaJson?.mime_type ?? 'audio/ogg';
  if (!url) return null;

  // Step 2: fetch bytes (Meta's signed URL still requires the bearer token).
  const bin = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!bin.ok) {
    log.warn('meta media bytes fetch failed', { status: bin.status });
    return null;
  }
  const buffer = Buffer.from(await bin.arrayBuffer());
  return { buffer, mimeType };
}

export default router;
