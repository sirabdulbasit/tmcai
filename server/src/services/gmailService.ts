import { google } from 'googleapis';
import { getAuthenticatedClient } from './integrationService';

/**
 * GmailService — read, search, and send emails for a user.
 * Uses per-user OAuth tokens from integrationService.
 */

export interface EmailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  /** CC header (raw, multiple addresses comma-separated). Empty when
   *  the message has no Cc. Critical for triage — emails where the
   *  user is CC-only are usually informational, not action items. */
  cc: string;
  /** BCC won't show in the user's view of inbox messages — only when
   *  they sent it. Kept for completeness. */
  bcc: string;
  subject: string;
  snippet: string;
  date: string;
  isUnread: boolean;
  labels: string[];
}

export interface EmailDetail extends EmailSummary {
  body: string;        // Plain text or stripped HTML
  attachments: { filename: string; mimeType: string; size: number }[];
}

// ─── Get inbox emails ─────────────────────────────────────────

export async function getInbox(userId: number, maxResults = 10, query?: string): Promise<{ emails: EmailSummary[]; error?: string }> {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client) return { emails: [], error };

  try {
    const gmail = google.gmail({ version: 'v1', auth: client });
    const q = query || 'in:inbox';
    const response = await gmail.users.messages.list({ userId: 'me', maxResults, q });

    if (!response.data.messages) return { emails: [] };

    // Parallelize per-message metadata fetches in concurrency-capped chunks.
    // Sequential was the original implementation, but at limit=500 (set by
    // genericFeedPoller for inbox headroom) it took ~25s — over the gmail
    // adapter's 15s circuit-breaker timeout — so every regular poll tripped
    // and lastSyncAt stayed frozen until a Re-scribe button click.
    // Concurrency=10 finishes 500 messages in ~5s while staying inside
    // Gmail's per-user quota tolerance (250 units/sec, messages.get=5 units).
    // Individual 429s land in the per-call catch and are skipped harmlessly.
    const messages = response.data.messages.slice(0, maxResults);
    const emails: EmailSummary[] = [];
    const CHUNK = 10;
    for (let i = 0; i < messages.length; i += CHUNK) {
      const chunk = messages.slice(i, i + CHUNK);
      const results = await Promise.all(chunk.map(async (msg) => {
        try {
          const detail = await gmail.users.messages.get({ userId: 'me', id: msg.id!, format: 'metadata', metadataHeaders: ['From', 'To', 'Cc', 'Bcc', 'Subject', 'Date'] });
          const headers = detail.data.payload?.headers || [];
          const getHeader = (name: string) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
          return {
            id: msg.id!,
            threadId: msg.threadId!,
            from: getHeader('From'),
            to: getHeader('To'),
            cc: getHeader('Cc'),
            bcc: getHeader('Bcc'),
            subject: getHeader('Subject'),
            snippet: detail.data.snippet || '',
            date: getHeader('Date'),
            isUnread: detail.data.labelIds?.includes('UNREAD') || false,
            labels: detail.data.labelIds || [],
          } as EmailSummary;
        } catch { return null; }
      }));
      for (const r of results) if (r) emails.push(r);
    }

    return { emails };
  } catch (err: any) {
    return { emails: [], error: `Gmail error: ${err.message}` };
  }
}

// ─── Read full email ──────────────────────────────────────────

export async function readEmail(userId: number, messageId: string): Promise<{ email?: EmailDetail; error?: string }> {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client) return { error };

  try {
    const gmail = google.gmail({ version: 'v1', auth: client });
    const detail = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });

    const headers = detail.data.payload?.headers || [];
    const getHeader = (name: string) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

    // Extract body
    let body = '';
    const payload = detail.data.payload;
    if (payload?.body?.data) {
      body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    } else if (payload?.parts) {
      const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
      const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
      if (textPart?.body?.data) {
        body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
      } else if (htmlPart?.body?.data) {
        body = Buffer.from(htmlPart.body.data, 'base64').toString('utf-8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }

    // Extract attachments
    const attachments = (payload?.parts || [])
      .filter(p => p.filename && p.filename.length > 0)
      .map(p => ({ filename: p.filename!, mimeType: p.mimeType || '', size: parseInt(p.body?.size?.toString() || '0') }));

    return {
      email: {
        id: messageId,
        threadId: detail.data.threadId!,
        from: getHeader('From'),
        to: getHeader('To'),
        cc: getHeader('Cc'),
        bcc: getHeader('Bcc'),
        subject: getHeader('Subject'),
        snippet: detail.data.snippet || '',
        date: getHeader('Date'),
        isUnread: detail.data.labelIds?.includes('UNREAD') || false,
        labels: detail.data.labelIds || [],
        body: body.slice(0, 5000), // Limit body size for AI context
        attachments,
      },
    };
  } catch (err: any) {
    return { error: `Gmail error: ${err.message}` };
  }
}

// ─── Send email ───────────────────────────────────────────────

export async function sendUserEmail(
  userId: number,
  to: string,
  subject: string,
  body: string,
  cc?: string,
  opts?: { threadId?: string; inReplyTo?: string; references?: string },
): Promise<{ success: boolean; messageId?: string; threadId?: string; error?: string }> {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client) {
    // Gmail unavailable. Per Basit 2026-06-11 "anyone email should be
    // configured either gmail, microsoft, imap smtp" — fall back to
    // the user's IMAP/SMTP connector if they have one connected. This
    // means callers (instructionDispatcher, delegationFollowUpJob,
    // conversationalHandler, etc.) DON'T need to branch by provider —
    // sendUserEmail picks the right route automatically.
    try {
      const { sendEmail: imapSmtpSend } = await import('./imapSmtpService');
      const r = await imapSmtpSend({
        userId,
        to,
        subject,
        bodyText: body.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(),
        bodyHtml: body,
        inReplyTo: opts?.inReplyTo,
      });
      if (r.ok) {
        return { success: true, messageId: r.messageId };
      }
      // No imap_smtp either — return the more informative Gmail error.
      if (/no connected imap_smtp/i.test(r.error || '')) {
        return { success: false, error };
      }
      return { success: false, error: r.error };
    } catch (fallbackErr: any) {
      return { success: false, error };
    }
  }

  try {
    const gmail = google.gmail({ version: 'v1', auth: client });

    // When sending into a thread, ensure subject starts with "Re: " so
    // mail clients that fall back to subject-matching for threading
    // group correctly. Gmail itself uses threadId, but other readers do not.
    const finalSubject = opts?.threadId && !/^re:/i.test(subject) ? `Re: ${subject}` : subject;

    // Build RFC 2822 message. In-Reply-To and References give external
    // mail readers proper threading; threadId on the API call covers Gmail.
    const headers = [
      `To: ${to}`,
      cc ? `Cc: ${cc}` : '',
      `Subject: ${finalSubject}`,
      opts?.inReplyTo ? `In-Reply-To: ${opts.inReplyTo}` : '',
      opts?.references ? `References: ${opts.references}` : '',
      'Content-Type: text/html; charset=utf-8',
      'MIME-Version: 1.0',
    ].filter(Boolean).join('\r\n');

    const message = `${headers}\r\n\r\n${body}`;
    const encodedMessage = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const requestBody: { raw: string; threadId?: string } = { raw: encodedMessage };
    if (opts?.threadId) requestBody.threadId = opts.threadId;

    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody,
    });

    // Fire-and-forget commitment extraction. Outbound emails often
    // contain "I'll send X by Y" — we file each promise as an open_item
    // so Brain can track and follow up. Idempotent on (channel, sourceRef).
    void (async () => {
      try {
        const messageId = response.data.id;
        if (!messageId) return;
        const u = await import('../db/prisma').then(m => m.default.user.findUnique({
          where: { id: userId }, select: { clientNumber: true },
        }));
        if (!u?.clientNumber) return;
        // Strip HTML to plain text for the extractor.
        const plain = body.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        const { extractAndFileCommitments } = await import('../services/knowledge/commitmentExtractor');
        await extractAndFileCommitments({
          clientNumber: u.clientNumber, userId,
          channel: 'email', sourceRef: messageId,
          recipient: to, subject, body: plain,
          sentAt: new Date(),
        });
      } catch { /* best-effort; never block the send */ }
    })();

    return {
      success: true,
      messageId: response.data.id || undefined,
      threadId: response.data.threadId || undefined,
    };
  } catch (err: any) {
    return { success: false, error: `Send failed: ${err.message}` };
  }
}

// ─── Read sent items (for tone analysis) ──────────────────────
// Returns up to `max` of the user's recent SENT messages, full body. Used
// by the tone-matching cover-note generator for delegations and drafts so
// forwards/replies feel organic instead of templated.
export async function getSentSamples(userId: number, max = 6): Promise<{ samples: Array<{ subject: string; body: string; to: string }>; error?: string }> {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client) return { samples: [], error };
  try {
    const gmail = google.gmail({ version: 'v1', auth: client });
    const list = await gmail.users.messages.list({
      userId: 'me', q: 'in:sent', maxResults: max,
    });
    const out: Array<{ subject: string; body: string; to: string }> = [];
    for (const m of list.data.messages ?? []) {
      const d = await gmail.users.messages.get({ userId: 'me', id: m.id!, format: 'full' }).catch(() => null);
      if (!d?.data) continue;
      const headers = d.data.payload?.headers ?? [];
      const getH = (k: string) => headers.find((h) => h.name?.toLowerCase() === k.toLowerCase())?.value ?? '';
      // Extract text body (recursively)
      const findText = (part: any): string => {
        if (!part) return '';
        if (part.mimeType === 'text/plain' && part.body?.data) {
          return Buffer.from(part.body.data, 'base64').toString('utf-8');
        }
        if (part.parts) {
          for (const p of part.parts) {
            const t = findText(p);
            if (t) return t;
          }
        }
        return '';
      };
      let body = findText(d.data.payload) || (d.data.snippet ?? '');
      // Strip quoted-reply / signatures — keep only the first paragraph-ish
      body = body.split(/\n>|On .* wrote:/i)[0].slice(0, 600).trim();
      if (body.length < 20) continue;
      out.push({ subject: getH('Subject'), body, to: getH('To') });
    }
    return { samples: out };
  } catch (err: any) {
    return { samples: [], error: err.message };
  }
}

// ─── Sent emails to a specific recipient (for tone learning) ──
//
// Pulls the most recent N emails the user has sent to `recipientEmail`.
// Used by smartChaseService to few-shot the chase composer with the
// user's actual register for THIS person — first-name vs surname,
// formal vs casual, sentence length, sign-off style.
//
// Returns full text bodies (up to 1200 chars each) with quoted
// replies + signatures stripped at common delimiters.
export async function getSentSamplesToRecipient(
  userId: number,
  recipientEmail: string,
  max = 8,
): Promise<{ samples: Array<{ subject: string; body: string; date: string }>; error?: string }> {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client) return { samples: [], error };
  try {
    const gmail = google.gmail({ version: 'v1', auth: client });
    const list = await gmail.users.messages.list({
      userId: 'me',
      q: `from:me to:${recipientEmail} -is:draft`,
      maxResults: max * 2,
    });
    const ids = (list.data.messages ?? []).map((m) => m.id!).filter(Boolean).slice(0, max * 2);

    const samples: Array<{ subject: string; body: string; date: string }> = [];
    for (const id of ids) {
      try {
        const d = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
        const headers = d.data.payload?.headers ?? [];
        const getH = (k: string) => headers.find((h) => h.name?.toLowerCase() === k.toLowerCase())?.value ?? '';
        const subject = getH('Subject');
        const date = getH('Date');

        const findText = (part: any): string => {
          if (!part) return '';
          if (part.mimeType === 'text/plain' && part.body?.data) {
            return Buffer.from(part.body.data, 'base64').toString('utf-8');
          }
          if (part.parts) {
            for (const p of part.parts) {
              const t = findText(p);
              if (t) return t;
            }
          }
          return '';
        };
        let body = findText(d.data.payload) || (d.data.snippet ?? '');

        // Strip quoted-reply and signature blocks. Order matters —
        // signatures often appear before the first quote.
        const cutMarkers: RegExp[] = [
          /\nOn .{1,80} wrote:/i,
          /\n-+\s*Original Message\s*-+/i,
          /\n>\s/,
          /\n--\s*\n/,
        ];
        for (const m of cutMarkers) {
          const idx = body.search(m);
          if (idx > 50) body = body.slice(0, idx);
        }
        body = body.replace(/\s+\n/g, '\n').trim();

        // Skip 1-liners and pure forwards — no tone signal.
        if (body.length < 30) continue;
        if (/^(fwd|fw|re):\s/i.test(subject) && body.length < 80) continue;

        samples.push({ subject, body: body.slice(0, 1200), date });
        if (samples.length >= max) break;
      } catch { /* skip individual message errors */ }
    }
    return { samples };
  } catch (err: any) {
    return { samples: [], error: err.message };
  }
}

// ─── Mark message as read ─────────────────────────────────────
// Removes the UNREAD label so it no longer contributes to the inbox counter
// (the same counter Day Brief's "Emails unread" tile reads live). Called
// whenever MD or Brain takes a terminal action on a Gmail-backed event
// (ignore / delegate / open item / send draft / acknowledge).
export async function markAsRead(userId: number, messageId: string): Promise<{ success: boolean; error?: string }> {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client) return { success: false, error };
  try {
    const gmail = google.gmail({ version: 'v1', auth: client });
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: { removeLabelIds: ['UNREAD'] },
    });
    return { success: true };
  } catch (err: any) {
    return { success: false, error: `Mark-read failed: ${err.message}` };
  }
}

// ─── Search emails ────────────────────────────────────────────

export async function searchEmails(userId: number, query: string, maxResults = 10): Promise<{ emails: EmailSummary[]; error?: string }> {
  return getInbox(userId, maxResults, query);
}

// ─── Fetch message headers for reply context ─────────────────
// Pulls the canonical Message-ID, From/To/Cc, and References from a
// single message. Used by the /drafts/:id/send route to build a proper
// in-thread reply (Reply or Reply All) with correct RFC headers.

export async function getEmailHeadersForReply(
  userId: number,
  messageId: string,
): Promise<{
  rfcMessageId: string | null;  // <CABc...@mail.gmail.com> — for In-Reply-To
  references: string | null;    // existing References chain (if any)
  from: string;
  to: string;
  cc: string;
  subject: string;
  threadId: string | null;
} | { error: string }> {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client) return { error: error ?? 'no auth client' };
  try {
    const gmail = google.gmail({ version: 'v1', auth: client });
    const m = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'metadata',
      metadataHeaders: ['Message-ID', 'References', 'From', 'To', 'Cc', 'Subject'],
    });
    const headers = m.data.payload?.headers ?? [];
    const h = (name: string) => headers.find((x: any) => (x.name || '').toLowerCase() === name.toLowerCase())?.value ?? '';
    return {
      rfcMessageId: h('Message-ID') || null,
      references: h('References') || null,
      from: h('From'),
      to: h('To'),
      cc: h('Cc'),
      subject: h('Subject'),
      threadId: m.data.threadId ?? null,
    };
  } catch (err: any) {
    return { error: `Header fetch failed: ${err.message}` };
  }
}

// ─── Fetch thread context ─────────────────────────────────────
// Last N messages in a Gmail thread — used by Brain to understand
// ambiguous replies ("looks fine", "approved", "sounds good") without
// having to re-parse the whole conversation.

export async function fetchEmailThreadContext(
  userId: number,
  threadId: string,
  limit = 200,
): Promise<Array<{
  from: 'me' | 'them';
  fromName?: string;
  to?: string;
  cc?: string;
  subject: string;
  text: string;
  timestamp: number;
}>> {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client || !threadId) return [];
  try {
    const gmail = google.gmail({ version: 'v1', auth: client });
    const t = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' }).catch(() => null);
    // Return the FULL thread (oldest → newest) like a regular email
    // client. The cap is only there as a safety floor for pathological
    // mailing-list threads with hundreds of replies. For Brain's
    // tone/context callers that pass a small limit (e.g. ambiguous-
    // reply parsing), they get the LAST N — the most recent messages,
    // which is what those callers actually want.
    const all = t?.data?.messages ?? [];
    const msgs = limit < all.length ? all.slice(-limit) : all;
    return msgs.map((m: any) => {
      const headers = m.payload?.headers ?? [];
      const h = (name: string) => headers.find((x: any) => (x.name || '').toLowerCase() === name)?.value ?? '';
      const body = extractPlainPart(m.payload) || String(m.snippet ?? '').slice(0, 800);
      const fromMe = (m.labelIds ?? []).includes('SENT');
      const fromHeader = String(h('from'));
      // Pull display name out of "Name <addr@x>" if present.
      const nameMatch = fromHeader.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>/);
      const fromName = nameMatch ? nameMatch[1].trim() : fromHeader.trim();
      return {
        from: fromMe ? ('me' as const) : ('them' as const),
        fromName,
        to: String(h('to')),
        cc: String(h('cc')),
        subject: String(h('subject')),
        text: body.slice(0, 800),
        timestamp: Number(m.internalDate ?? 0),
      };
    });
  } catch { return []; }
}

function extractPlainPart(part: any): string {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) {
    try { return Buffer.from(part.body.data, 'base64').toString('utf-8'); } catch { return ''; }
  }
  if (Array.isArray(part.parts)) {
    for (const p of part.parts) {
      const v = extractPlainPart(p);
      if (v) return v;
    }
  }
  return '';
}

// ─── Get unread count ─────────────────────────────────────────

export async function getUnreadCount(userId: number): Promise<{ count: number; error?: string }> {
  const { client, error } = await getAuthenticatedClient(userId);
  if (!client) return { count: 0, error };

  try {
    const gmail = google.gmail({ version: 'v1', auth: client });
    // The INBOX label carries an exact `messagesUnread` counter — the same
    // number Gmail UI shows in its sidebar. `messages.list` returns an
    // *estimate* (resultSizeEstimate) which can be off by 10x for small
    // result sets, so we use labels.get instead.
    const label = await gmail.users.labels.get({ userId: 'me', id: 'INBOX' });
    return { count: label.data.messagesUnread ?? 0 };
  } catch (err: any) {
    return { count: 0, error: err.message };
  }
}
