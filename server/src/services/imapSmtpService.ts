/**
 * ImapSmtpService — connect / test / read / send for tenants whose
 * email is NOT on Gmail or Microsoft 365 (Zoho, ProtonMail, cPanel
 * mail, private corporate IMAP servers, etc.).
 *
 * No OAuth — the whole point of this connector is supporting providers
 * that don't ship an OAuth surface. Users supply username + password
 * (or an app-specific password where their provider requires one).
 *
 * Credential storage: piggybacks on the existing
 * `encryptConnectorConfig` chokepoint in connectorService — the
 * `password` field is one of the auto-encrypted sensitive keys. We
 * pass plaintext through testConnection (which never persists), and
 * the caller (`testAndConnect`) handles encryption before saving to
 * `user_connectors.config`. Read side uses `decryptConnectorConfig`
 * to get plaintext back for live IMAP / SMTP use.
 *
 * Per Basit 2026-06-10: "what if any client don't have emails on gmail
 * or microsoft, so how he can setup his email? thorugh smtp??"
 */
import prisma from '../db/prisma';
import { decryptConnectorConfig } from './connectorService';
import createLogger from '../utils/logger';

const log = createLogger('imap-smtp');

export interface ImapSmtpConfig {
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpTls: boolean;
  username: string;
  /** Plaintext at the call site for testConnection; never stored. The
   *  upstream caller (testAndConnect) encrypts via encryptConnectorConfig
   *  before writing to DB. */
  password: string;
}

export interface ImapSmtpTestResult {
  ok: boolean;
  imapOk?: boolean;
  smtpOk?: boolean;
  error?: string;
  detail?: string;
}

export interface InboxMessage {
  uid: number;
  subject: string;
  from: string;
  fromName: string;
  to: string;
  cc: string;
  date: Date;
  snippet: string;
  isUnread: boolean;
  messageId: string;
}

// ─── Public surface ─────────────────────────────────────────────────

/** Validate config by attempting both an IMAP login AND an SMTP verify.
 *  Returns granular flags so the UI can show "IMAP works, SMTP fails"
 *  instead of a single yes/no. Password is plaintext at this point —
 *  the only callers are the connect flow (fresh creds entered by user)
 *  and the re-test flow (which calls decryptConnectorConfig first). */
export async function testConnection(input: ImapSmtpConfig): Promise<ImapSmtpTestResult> {
  if (!input.password) return { ok: false, error: 'password required' };
  if (!input.username) return { ok: false, error: 'email address required' };
  if (!input.imapHost) return { ok: false, error: 'IMAP host required' };
  if (!input.smtpHost) return { ok: false, error: 'SMTP host required' };

  let imapOk = false;
  let smtpOk = false;
  let firstError: string | undefined;

  // ── IMAP test ──
  try {
    // @ts-ignore optional dep — runtime require so app boots even if not installed
    const { ImapFlow } = await import('imapflow' as string);
    const imap = new ImapFlow({
      host: input.imapHost,
      port: input.imapPort,
      secure: input.imapTls,
      auth: { user: input.username, pass: input.password },
      logger: false,
    });
    await imap.connect();
    // Quick mailbox listing as a positive proof-of-life — login alone
    // can succeed against some servers that then refuse all reads.
    await imap.mailboxOpen('INBOX', { readOnly: true });
    await imap.logout();
    imapOk = true;
  } catch (err: any) {
    firstError = `IMAP: ${err.message}`;
    log.warn('imap test failed', { host: input.imapHost, error: err.message });
  }

  // ── SMTP test ──
  try {
    const nodemailer = await import('nodemailer');
    const transport = nodemailer.createTransport({
      host: input.smtpHost,
      port: input.smtpPort,
      secure: input.smtpTls,
      auth: { user: input.username, pass: input.password },
    });
    await transport.verify();
    smtpOk = true;
  } catch (err: any) {
    if (!firstError) firstError = `SMTP: ${err.message}`;
    log.warn('smtp test failed', { host: input.smtpHost, error: err.message });
  }

  return {
    ok: imapOk && smtpOk,
    imapOk, smtpOk,
    error: firstError,
    detail: imapOk && smtpOk
      ? `Logged in as ${input.username}; both IMAP and SMTP responded.`
      : `IMAP: ${imapOk ? 'ok' : 'failed'}, SMTP: ${smtpOk ? 'ok' : 'failed'}`,
  };
}

/** Load + decrypt the user's saved IMAP/SMTP config for live use.
 *  Returns null when no connected row exists. */
export async function loadConfig(userId: number): Promise<ImapSmtpConfig | null> {
  const uc = await prisma.userConnector.findFirst({
    where: { userId, connectorType: { slug: 'imap_smtp' }, status: 'connected' },
  });
  if (!uc) return null;
  const raw = await decryptConnectorConfig(uc.config as Record<string, unknown>);
  return {
    imapHost: String(raw.imapHost ?? ''),
    imapPort: Number(raw.imapPort ?? 993),
    imapTls: raw.imapTls !== false,
    smtpHost: String(raw.smtpHost ?? ''),
    smtpPort: Number(raw.smtpPort ?? 465),
    smtpTls: raw.smtpTls !== false,
    username: String(raw.username ?? ''),
    password: String(raw.password ?? ''),
  };
}

/** Send a single outbound email via the stored SMTP credentials. */
export async function sendEmail(args: {
  userId: number;
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  inReplyTo?: string;
}): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  const cfg = await loadConfig(args.userId);
  if (!cfg) return { ok: false, error: 'no connected imap_smtp connector for this user' };

  try {
    const nodemailer = await import('nodemailer');
    const transport = nodemailer.createTransport({
      host: cfg.smtpHost, port: cfg.smtpPort, secure: cfg.smtpTls,
      auth: { user: cfg.username, pass: cfg.password },
    });
    const info = await transport.sendMail({
      from: cfg.username,
      to: args.to,
      subject: args.subject,
      text: args.bodyText,
      html: args.bodyHtml,
      ...(args.inReplyTo ? { inReplyTo: args.inReplyTo, references: args.inReplyTo } : {}),
    });
    log.info('imap_smtp email sent', { userId: args.userId, to: args.to, messageId: info.messageId });
    return { ok: true, messageId: info.messageId };
  } catch (err: any) {
    log.error('imap_smtp send failed', { userId: args.userId, error: err.message });
    return { ok: false, error: err.message };
  }
}

/** Fetch the most-recent N messages from INBOX. Used by the
 *  ImapSmtpFeedAdapter (forthcoming) and for ad-hoc admin probes. */
export async function fetchRecentInbox(userId: number, limit = 25): Promise<InboxMessage[]> {
  const cfg = await loadConfig(userId);
  if (!cfg) return [];

  // @ts-ignore optional dep
  const { ImapFlow } = await import('imapflow' as string);
  const imap = new ImapFlow({
    host: cfg.imapHost, port: cfg.imapPort, secure: cfg.imapTls,
    auth: { user: cfg.username, pass: cfg.password },
    logger: false,
  });
  const out: InboxMessage[] = [];
  try {
    await imap.connect();
    const box = await imap.mailboxOpen('INBOX', { readOnly: true });
    const total = box.exists;
    if (!total) return [];
    const from = Math.max(1, total - limit + 1);
    const seqRange = `${from}:${total}`;
    for await (const msg of imap.fetch(seqRange, { envelope: true, flags: true, uid: true, internalDate: true })) {
      const env = msg.envelope ?? ({} as any);
      const fromAddr = env.from?.[0];
      out.push({
        uid: msg.uid as number,
        subject: env.subject ?? '',
        from: fromAddr ? `${fromAddr.mailbox}@${fromAddr.host}` : '',
        fromName: fromAddr?.name ?? '',
        to: (env.to ?? []).map((a: any) => `${a.mailbox}@${a.host}`).join(', '),
        cc: (env.cc ?? []).map((a: any) => `${a.mailbox}@${a.host}`).join(', '),
        date: env.date ? new Date(env.date) : new Date(),
        snippet: '',
        isUnread: !(msg.flags && msg.flags.has('\\Seen')),
        messageId: env.messageId ?? '',
      });
    }
  } finally {
    try { await imap.logout(); } catch {}
  }
  // ImapFlow returns ascending; reverse so newest-first matches other adapters.
  return out.reverse();
}
