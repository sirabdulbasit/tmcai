/**
 * email_message — one wiki page per Gmail message, full plaintext body.
 *
 * Closes the "nothing missed" gap: today Gmail ingest only captures
 * subject + 280-char snippet. This service fetches the FULL message body
 * (format='full' from Gmail API, HTML → plaintext where needed) and
 * stores it as its own `email_message` wiki page, linked by
 * metadata.entityId to the canonical person for the sender.
 *
 * Dedup key: (clientNumber, userId, 'email_message', title) where
 * title = `${date} · ${subject}` truncated — same message re-ingested
 * updates the existing page.
 *
 * Scope bounds:
 *   - Max 40K chars per body (matches attachment + org_doc policy).
 *   - Fire-and-forget from the ingest path (doesn't block triage /
 *     Day Brief / attachment scribing).
 *   - Embeds the page after write so semantic retrieval lands on it.
 */
import { google } from 'googleapis';
import { getAuthenticatedClient } from '../integrationService';
import prisma from '../../db/prisma';
import createLogger from '../../utils/logger';
import { BRAIN_SCHEMA_VERSION } from './brainSchema';

const log = createLogger('email-body');

const MAX_BODY_CHARS = 40_000;

export interface IngestEmailBodyParams {
  clientNumber: string;
  userId: number;
  gmailMessageId: string;
  feedEventId: string;
  senderEmail: string | null;
  senderName: string | null;
  subject: string | null;
  receivedAt: Date;
}

export async function ingestEmailBody(p: IngestEmailBodyParams): Promise<string | null> {
  const { client, error } = await getAuthenticatedClient(p.userId);
  if (!client) { log.warn('no gmail auth', { userId: p.userId, error }); return null; }

  try {
    const gmail = google.gmail({ version: 'v1', auth: client });
    const msg = await gmail.users.messages.get({ userId: 'me', id: p.gmailMessageId, format: 'full' });

    const headers = msg.data.payload?.headers ?? [];
    const headerVal = (name: string) =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

    const subject = p.subject ?? headerVal('Subject') ?? '(no subject)';
    const from = headerVal('From');
    const to = headerVal('To');
    const cc = headerVal('Cc');
    const date = headerVal('Date') || p.receivedAt.toISOString();
    // Message-Id / In-Reply-To / References let us reconstruct the
    // conversation continuity even when Gmail's threadId isn't enough
    // (forwarded messages, split threads, imported mailboxes).
    const messageIdHeader = headerVal('Message-ID');
    const inReplyTo = headerVal('In-Reply-To');
    const references = headerVal('References');
    // Gmail's own threadId — the single most reliable thread signal.
    const threadId = msg.data.threadId ?? null;

    const bodyText = extractBodyText(msg.data.payload).slice(0, MAX_BODY_CHARS);
    if (!bodyText.trim()) {
      log.info('empty body, skipped', { messageId: p.gmailMessageId });
      return null;
    }

    // Resolve canonical person so the email_message page is linked to
    // the same entity_person the sender_history/topic are linked to.
    let entityId: string | null = null;
    if (p.senderEmail) {
      const { resolvePersonByEmail } = await import('./personIdentityService');
      entityId = await resolvePersonByEmail(p.senderEmail, {
        clientNumber: p.clientNumber,
        name: p.senderName ?? null,
      });
    }

    const dateIso = p.receivedAt.toISOString().slice(0, 10);
    const title = `${dateIso} · ${String(subject).slice(0, 220)}`.slice(0, 300);

    const bodyParts: string[] = [];
    bodyParts.push(`# ${subject}`);
    bodyParts.push('');
    bodyParts.push(`**From:** ${from || p.senderEmail || '(unknown)'}`);
    if (to) bodyParts.push(`**To:** ${to}`);
    if (cc) bodyParts.push(`**Cc:** ${cc}`);
    bodyParts.push(`**Date:** ${date}`);
    bodyParts.push(`**Gmail message ID:** \`${p.gmailMessageId}\``);
    if (entityId) bodyParts.push(`**Person ID:** \`${entityId}\``);
    bodyParts.push('');
    bodyParts.push('## Body');
    bodyParts.push(bodyText);
    const body = bodyParts.join('\n');

    const metadata = {
      schemaVersion: BRAIN_SCHEMA_VERSION,
      scope: 'user',
      authoredBy: 'email_body_ingest',
      gmailMessageId: p.gmailMessageId,
      threadId,
      messageIdHeader,
      inReplyTo,
      references,
      feedEventId: p.feedEventId,
      entityId,
      senderEmail: p.senderEmail,
      senderName: p.senderName,
      subject,
      from, to, cc, date,
      bodyChars: bodyText.length,
    };

    const existing = await prisma.wikiPage.findFirst({
      where: { clientNumber: p.clientNumber, userId: p.userId, pageType: 'email_message', title },
      select: { id: true },
    }).catch(() => null);

    let pageId: string;
    if (existing) {
      await prisma.wikiPage.update({
        where: { id: existing.id },
        data: { bodyMarkdown: body, metadata, lastUpdatedAt: p.receivedAt, lastUpdatedBy: 'email_body_ingest', status: 'active' },
      });
      pageId = existing.id;
    } else {
      const created = await prisma.wikiPage.create({
        data: {
          clientNumber: p.clientNumber, userId: p.userId,
          pageType: 'email_message', title,
          bodyMarkdown: body, metadata,
          storage: 'postgres', status: 'active', sourceCount: 1,
          lastUpdatedBy: 'email_body_ingest',
          lastUpdatedAt: p.receivedAt,
        },
      });
      pageId = created.id;
    }

    // Embed the page so semantic retrieval finds it by the body content,
    // not just the subject line.
    void (async () => {
      try {
        const { embedWikiPage } = await import('./wikiEmbeddingService');
        await embedWikiPage(pageId);
      } catch { /* best effort */ }
    })();

    return pageId;
  } catch (err: any) {
    log.warn('ingestEmailBody failed', { messageId: p.gmailMessageId, error: err.message });
    return null;
  }
}

/** Recursively walk a Gmail MIME payload. Prefer text/plain, fall back to
 *  a minimal HTML → plaintext stripper on text/html. Ignores attachments
 *  (those already have their own attachment_doc pages). */
function extractBodyText(payload: any): string {
  if (!payload) return '';

  const plain = findPart(payload, 'text/plain');
  if (plain) return decodeBody(plain.body?.data);

  const html = findPart(payload, 'text/html');
  if (html) return htmlToPlaintext(decodeBody(html.body?.data));

  // Single-part message, no multipart
  if (payload.body?.data) {
    const decoded = decodeBody(payload.body.data);
    return (payload.mimeType === 'text/html') ? htmlToPlaintext(decoded) : decoded;
  }
  return '';
}

function findPart(node: any, mime: string): any | null {
  if (!node) return null;
  if (node.mimeType === mime && node.body?.data) return node;
  if (Array.isArray(node.parts)) {
    for (const p of node.parts) {
      const hit = findPart(p, mime);
      if (hit) return hit;
    }
  }
  return null;
}

function decodeBody(data: string | null | undefined): string {
  if (!data) return '';
  // Gmail returns URL-safe base64.
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  try { return Buffer.from(normalized, 'base64').toString('utf8'); }
  catch { return ''; }
}

function htmlToPlaintext(html: string): string {
  return html
    // Drop script/style blocks entirely
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Preserve paragraph / br breaks
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div\s*>/gi, '\n')
    .replace(/<\/li\s*>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode common HTML entities
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    // Collapse runaway whitespace
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}
