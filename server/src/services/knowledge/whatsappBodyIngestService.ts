/**
 * whatsapp_message — one wiki page per inbound WhatsApp message,
 * full body (including transcribed voice notes).
 *
 * Closes the parity gap with email_message: WhatsApp only lived in
 * feed_events (30-day TTL) which meant voice transcripts and message
 * history were lost when the pruner ran. Now every inbound WhatsApp
 * message scribes a permanent wiki page so search, brain memory, and
 * retrospective lookups all keep working past the queue window.
 *
 * Dedup key: (clientNumber, userId, 'whatsapp_message', sourceRef =
 * waMessageId). Re-ingesting updates the same page.
 *
 * Body content:
 *   - Text messages: payload.body verbatim
 *   - Voice notes: the formatted "🎤 Voice note in <lang>\nOriginal:\n
 *     English:" block already produced by UserWebjsProvider
 *   - Images / docs: a stub line ("Image attachment / Document
 *     attached") — actual media is in WhatsApp; we record the metadata
 *
 * Scope bounds:
 *   - Max 40K chars per body (matches email_message + attachment policy)
 *   - Fire-and-forget from feed ingest (doesn't block triage)
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';

const log = createLogger('whatsapp-body');

const MAX_BODY_CHARS = 40_000;

export interface IngestWhatsAppBodyParams {
  clientNumber: string;
  userId: number;
  feedEventId: string;
  waMessageId: string;
  chatId: string | null;
  senderName: string | null;
  senderPhone: string | null;
  body: string;
  type: string;
  voiceTranscript: any | null;
  receivedAt: Date;
}

export async function ingestWhatsAppBody(p: IngestWhatsAppBodyParams): Promise<string | null> {
  if (!p.waMessageId) return null;

  const dateIso = p.receivedAt.toISOString().slice(0, 10);
  const fromLabel = (p.senderName ?? p.senderPhone ?? 'Unknown').slice(0, 80);
  const titleBase = `${dateIso} · WhatsApp from ${fromLabel}`;
  // Add a short fingerprint of the message id so the title stays unique
  // across multiple messages from the same person on the same day.
  const idTail = p.waMessageId.slice(-8);
  const title = `${titleBase} · ${idTail}`.slice(0, 300);

  const body = (p.body ?? '').slice(0, MAX_BODY_CHARS);
  const isVoice = p.type === 'ptt' || p.type === 'audio';

  const metadata: any = {
    sourceType: 'whatsapp',
    waMessageId: p.waMessageId,
    chatId: p.chatId,
    senderName: p.senderName,
    senderPhone: p.senderPhone,
    receivedAt: p.receivedAt.toISOString(),
    type: p.type,
    isVoice,
    feedEventId: p.feedEventId,
  };
  if (p.voiceTranscript) {
    metadata.voiceTranscript = p.voiceTranscript;
  }

  try {
    const existing = await prisma.wikiPage.findFirst({
      where: {
        clientNumber: p.clientNumber,
        userId: p.userId,
        pageType: 'whatsapp_message',
        sourceRef: p.waMessageId,
      } as any,
      select: { id: true },
    });

    if (existing) {
      await prisma.wikiPage.update({
        where: { id: existing.id },
        data: {
          bodyMarkdown: body,
          metadata,
          lastUpdatedAt: p.receivedAt,
          lastUpdatedBy: 'whatsapp_body_ingest',
          status: 'active',
        } as any,
      });
      return existing.id;
    }

    const created = await prisma.wikiPage.create({
      data: {
        clientNumber: p.clientNumber,
        userId: p.userId,
        pageType: 'whatsapp_message',
        sourceRef: p.waMessageId,
        title,
        bodyMarkdown: body,
        metadata,
        lastUpdatedAt: p.receivedAt,
        lastUpdatedBy: 'whatsapp_body_ingest',
        status: 'active',
      } as any,
    });
    return created.id;
  } catch (err: any) {
    log.warn('whatsapp wiki write failed', { feedEventId: p.feedEventId, error: err.message });
    return null;
  }
}
