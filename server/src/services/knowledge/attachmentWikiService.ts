/**
 * attachment_doc — one wiki page per email attachment so Brain can open,
 * quote, and cite attachment content just like any other page.
 *
 * Ingest path:
 *   1. Gmail message arrives → feed_event.
 *   2. We list attachments via gmailAttachmentService.
 *   3. For each: download bytes → extract text (attachmentExtractorService).
 *   4. Upsert a wiki_page(pageType='attachment_doc') with the extracted text.
 *   5. Append a line to the sender_topic page noting the attachment.
 *
 * Dedup key: (clientNumber, userId, attachment_doc, title) where
 * title = `${filename} · ${attachmentId.slice(0,8)}`. If the same
 * attachment appears in a thread twice we keep one page.
 *
 * Scope bounds:
 *   - Max 10 attachments per message.
 *   - Max 5MB per attachment (extractor skips bigger ones).
 *   - Extracted text capped at 40KB (extractor enforces).
 */
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { listAttachmentsForMessage, getAttachmentBytes } from '../gmailAttachmentService';
import { extractAttachmentText } from './attachmentExtractorService';
import { BRAIN_SCHEMA_VERSION } from './brainSchema';

const log = createLogger('attachment-wiki');

const MAX_ATTACHMENTS_PER_MESSAGE = 10;

export interface IngestAttachmentsParams {
  clientNumber: string;
  userId: number;
  senderEmail: string | null;
  gmailMessageId: string;
  feedEventId: string;
  subject?: string | null;
  receivedAt: Date;
}

export interface AttachmentIngestResult {
  total: number;
  processed: number;
  skipped: number;
  wikiPageIds: string[];
}

/**
 * Process all attachments for a single Gmail message. Fire-and-forget from
 * the ingest path; errors on one attachment don't block the others.
 */
export async function ingestMessageAttachments(
  p: IngestAttachmentsParams,
): Promise<AttachmentIngestResult> {
  const result: AttachmentIngestResult = { total: 0, processed: 0, skipped: 0, wikiPageIds: [] };

  const { attachments } = await listAttachmentsForMessage(p.userId, p.gmailMessageId);
  if (attachments.length === 0) return result;
  result.total = attachments.length;

  const limited = attachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
  for (const att of limited) {
    try {
      const { buffer, error } = await getAttachmentBytes(p.userId, p.gmailMessageId, att.attachmentId);
      if (!buffer) {
        log.warn('skip: no bytes', { filename: att.filename, error });
        result.skipped++;
        continue;
      }
      const extracted = await extractAttachmentText(buffer, att.mimeType, att.filename);
      const pageId = await upsertAttachmentPage({
        clientNumber: p.clientNumber,
        userId: p.userId,
        senderEmail: p.senderEmail,
        gmailMessageId: p.gmailMessageId,
        feedEventId: p.feedEventId,
        subject: p.subject,
        receivedAt: p.receivedAt,
        attachmentId: att.attachmentId,
        filename: att.filename,
        mimeType: att.mimeType,
        size: att.size,
        extracted,
      });
      if (pageId) result.wikiPageIds.push(pageId);
      if (extracted.method === 'skipped') result.skipped++;
      else result.processed++;
    } catch (err: any) {
      log.warn('attachment ingest error', { filename: att.filename, error: err.message });
      result.skipped++;
    }
  }

  if (result.processed > 0) {
    log.info('attachments scribed', {
      userId: p.userId, messageId: p.gmailMessageId,
      total: result.total, processed: result.processed, skipped: result.skipped,
    });
  }
  return result;
}

interface UpsertParams {
  clientNumber: string;
  userId: number;
  senderEmail: string | null;
  gmailMessageId: string;
  feedEventId: string;
  subject?: string | null;
  receivedAt: Date;
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  extracted: { text: string; pageCount?: number; method: string; truncated: boolean };
}

async function upsertAttachmentPage(p: UpsertParams): Promise<string | null> {
  // Don't pollute the wiki with pages for inline logos, email icons, and
  // other non-textual attachments. If the extractor couldn't pull any
  // readable text, skip page creation entirely — the metadata lives in
  // feed_events already. This keeps the tenant_index focused on content
  // Brain can actually quote from.
  if (p.extracted.method === 'skipped' || !p.extracted.text.trim()) {
    return null;
  }

  const title = `${p.filename} · ${p.attachmentId.slice(0, 8)}`;
  const when = p.receivedAt.toISOString().slice(0, 16).replace('T', ' ');
  const sizeKb = Math.max(1, Math.round(p.size / 1024));

  const header: string[] = [];
  header.push(`# ${p.filename}`);
  header.push('');
  header.push(`**Attachment of:** ${p.senderEmail ?? 'unknown sender'}`);
  if (p.subject) header.push(`**Email subject:** ${p.subject}`);
  header.push(`**Received:** ${when}`);
  header.push(`**MIME:** ${p.mimeType}`);
  header.push(`**Size:** ${sizeKb} KB`);
  header.push(`**Extracted via:** ${p.extracted.method}${p.extracted.pageCount ? ` · ${p.extracted.pageCount} pages` : ''}${p.extracted.truncated ? ' · truncated' : ''}`);
  header.push('');
  if (p.extracted.text) {
    header.push('## Extracted content');
    header.push(p.extracted.text);
  } else {
    header.push('_No text extracted (binary / unsupported format). Metadata only._');
  }

  const body = header.join('\n');
  const metadata = {
    schemaVersion: BRAIN_SCHEMA_VERSION,
    scope: 'user',
    authoredBy: 'attachment_wiki',
    filename: p.filename,
    mimeType: p.mimeType,
    size: p.size,
    gmailMessageId: p.gmailMessageId,
    attachmentId: p.attachmentId,
    feedEventId: p.feedEventId,
    senderEmail: p.senderEmail,
    extractMethod: p.extracted.method,
    pageCount: p.extracted.pageCount ?? null,
    extractedChars: p.extracted.text.length,
    truncated: p.extracted.truncated,
  };

  try {
    const existing = await prisma.wikiPage.findFirst({
      where: {
        clientNumber: p.clientNumber, userId: p.userId,
        pageType: 'attachment_doc', title,
      },
      select: { id: true },
    });
    let pageId: string;
    if (existing) {
      await prisma.wikiPage.update({
        where: { id: existing.id },
        data: { bodyMarkdown: body, metadata, lastUpdatedBy: 'attachment_wiki', lastUpdatedAt: new Date(), status: 'active' },
      });
      pageId = existing.id;
    } else {
      const created = await prisma.wikiPage.create({
        data: {
          clientNumber: p.clientNumber, userId: p.userId,
          pageType: 'attachment_doc', title,
          bodyMarkdown: body,
          metadata,
          storage: 'postgres',
          status: 'active',
          lastUpdatedBy: 'attachment_wiki',
        },
      });
      pageId = created.id;
    }
    // Embed this attachment so Brain can find it by semantic match
    // (a transcript about "CBL demo" will match a question about "demo
    // system" without any keyword decomposition).
    void (async () => {
      try {
        const { embedWikiPage } = await import('./wikiEmbeddingService');
        await embedWikiPage(pageId);
      } catch { /* best effort */ }
    })();

    // Meeting digestion — if this attachment looks like a transcript and
    // its parent email was delivered by a known transcription service,
    // turn the transcript into a `meeting_minutes` page + `open_items`.
    // Fires only on transcript-named files so we don't LLM-process every
    // PDF / spreadsheet that rides along in email.
    if (/transcript/i.test(title)) {
      void (async () => {
        try {
          const { digestMeetingFromEmail, looksLikeTranscriptEmail } = await import('./meetingDigestService');
          // Find the parent email_message page by feedEventId (stable).
          if (!p.feedEventId) return;
          const emailPage = await prisma.wikiPage.findFirst({
            where: {
              clientNumber: p.clientNumber, userId: p.userId,
              pageType: 'email_message',
              metadata: { path: ['feedEventId'], equals: p.feedEventId } as any,
            },
            select: { id: true, metadata: true },
          });
          if (!emailPage) return;
          if (!looksLikeTranscriptEmail(emailPage.metadata)) return;
          await digestMeetingFromEmail(emailPage.id);
        } catch { /* best effort — never block the attachment scribe */ }
      })();
    }

    return pageId;
  } catch (err: any) {
    log.warn('attachment_doc upsert failed', { title, error: err.message });
    return null;
  }
}
