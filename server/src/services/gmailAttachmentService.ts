/**
 * Gmail attachment helpers.
 *
 * listAttachments() — walks a message's MIME tree and returns every
 * attachable part (filename present, attachmentId present).
 *
 * getAttachmentBytes() — downloads one attachment via
 * users.messages.attachments.get and returns a Buffer.
 *
 * Both are light wrappers around the google-apis client; they reuse the
 * per-user OAuth from getAuthenticatedClient.
 */
import { google } from 'googleapis';
import { getAuthenticatedClient } from './integrationService';
import createLogger from '../utils/logger';

const log = createLogger('gmail-attach');

export interface GmailAttachmentMeta {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
  partId?: string;
}

/** Recursively walk the MIME tree and collect attachable parts. */
function collectAttachments(part: any, out: GmailAttachmentMeta[]): void {
  if (!part) return;
  const filename = part.filename;
  const body = part.body;
  if (filename && body?.attachmentId) {
    out.push({
      attachmentId: body.attachmentId,
      filename,
      mimeType: String(part.mimeType ?? 'application/octet-stream'),
      size: Number(body.size ?? 0),
      partId: part.partId,
    });
  }
  if (Array.isArray(part.parts)) {
    for (const child of part.parts) collectAttachments(child, out);
  }
}

export async function listAttachmentsForMessage(
  userId: number,
  messageId: string,
): Promise<{ attachments: GmailAttachmentMeta[]; error?: string }> {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client) return { attachments: [], error };
  try {
    const gmail = google.gmail({ version: 'v1', auth: client });
    const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
    const out: GmailAttachmentMeta[] = [];
    collectAttachments(msg.data.payload, out);
    return { attachments: out };
  } catch (err: any) {
    log.warn('listAttachments failed', { userId, messageId, error: err.message });
    return { attachments: [], error: err.message };
  }
}

export async function getAttachmentBytes(
  userId: number,
  messageId: string,
  attachmentId: string,
): Promise<{ buffer: Buffer | null; error?: string }> {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client) return { buffer: null, error };
  try {
    const gmail = google.gmail({ version: 'v1', auth: client });
    const r = await gmail.users.messages.attachments.get({
      userId: 'me', messageId, id: attachmentId,
    });
    const data = String(r.data.data ?? '');
    if (!data) return { buffer: null, error: 'empty attachment body' };
    // Gmail returns URL-safe base64. Node Buffer handles both with 'base64'
    // if we normalize _ / - back to / +.
    const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
    const buf = Buffer.from(normalized, 'base64');
    return { buffer: buf };
  } catch (err: any) {
    log.warn('getAttachmentBytes failed', { userId, messageId, attachmentId, error: err.message });
    return { buffer: null, error: err.message };
  }
}
