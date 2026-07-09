import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import { sendUserEmail, readEmail } from '../../../adapters/gmailAdapter';
// Shared with the reply handler — same feed_event → Gmail-id resolution
// (payload ids come from feed cards; accept thread id or message id).
import { resolveOriginalGmailMessage } from './sendEmailReply';

/** Minimal HTML-escape + newline→<br> for the forwarded block.
 *  WHY: sendUserEmail sends Content-Type text/html, and the quoted
 *  original comes from readEmail as PLAIN text (HTML already stripped) —
 *  injecting it raw would let a `<` in the original body eat the rest of
 *  the forward, and newlines (the forwarded-header block is inherently
 *  multi-line) would collapse to a single run-on line in every client. */
function toHtmlBlock(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '<br>\n');
}

export class ForwardEmailHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'forward_email', category: 'communication', description: 'Forward an existing email thread to new recipients', version: '1.0', requiresConnector: 'gmail' };
  }
  schema() {
    return {
      type: 'object',
      required: ['threadId', 'to'],
      properties: {
        threadId: { type: 'string' },
        to: { type: 'array', items: { type: 'string', format: 'email' } },
        note: { type: 'string' },
      },
    };
  }
  auditFields() { return ['threadId', 'to', 'messageId']; }
  riskLevel() { return 'MEDIUM' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.payload.threadId) errors.push('threadId required');
    const to = ctx.payload.to as unknown;
    if (!Array.isArray(to) || to.length === 0) errors.push('to must be a non-empty array');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return { wouldSucceed: v.valid, preview: { threadId: ctx.payload.threadId, to: ctx.payload.to, hasNote: !!ctx.payload.note }, warnings: v.errors };
  }
  /** F1 — real provider I/O (was a stub that fabricated a receipt).
   *  Flow: resolve original message → fetch its FULL body via
   *  gmailAdapter.readEmail (a forward must carry the content, not just
   *  headers) → send note + standard forwarded-message block to each
   *  recipient. One sendUserEmail call PER recipient, mirroring
   *  SendEmailHandler: per-address delivery visibility and per-call
   *  circuit-breaker failure granularity.
   *
   *  Deliberately NOT passed: threadId / In-Reply-To. A forward starts a
   *  new conversation for its recipients, and Gmail only honours a
   *  threadId when References AND a matching Subject are supplied — the
   *  "Fwd: " prefix breaks that match, so threading a forward would be
   *  request noise at best and a 400 at worst. */
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const threadId = String(ctx.payload.threadId ?? '');
    const to = (ctx.payload.to as string[]) ?? [];
    const note = String(ctx.payload.note ?? '').trim();

    const resolved = await resolveOriginalGmailMessage(ctx, threadId);
    if ('error' in resolved) return { ok: false, error: resolved.error };

    // Full read-back of the original — body is load-bearing for a forward.
    // If Gmail can't produce the message there is nothing real to forward;
    // never fall through to sending the note alone (that would silently
    // deliver an empty forward, the exact fabrication F1 is killing).
    let original: { from: string; to: string; cc: string; subject: string; date: string; body: string };
    try {
      const { email, error } = await readEmail(ctx.userId, resolved.messageId);
      if (error || !email) {
        return { ok: false, error: `could not resolve original message for thread ${threadId}: ${error ?? 'not found'}` };
      }
      original = email;
    } catch (err: any) {
      return { ok: false, error: `could not resolve original message for thread ${threadId}: ${err?.message ?? 'read failed'}` };
    }

    // "Fwd: " prefix, idempotent across Fwd:/FW:/fwd: variants so a
    // forward-of-a-forward doesn't stack prefixes.
    const subject = /^(fwd|fw):\s/i.test(original.subject) ? original.subject : `Fwd: ${original.subject}`;

    // Standard forwarded-message block (the shape every mail client
    // renders and every human recognises), preceded by the cover note.
    const headerLines = [
      '---------- Forwarded message ----------',
      `From: ${original.from}`,
      original.date ? `Date: ${original.date}` : null,
      `Subject: ${original.subject}`,
      `To: ${original.to}`,
      original.cc ? `Cc: ${original.cc}` : null,
    ].filter((l): l is string => l !== null);
    const forwardedBlock = `${headerLines.join('\n')}\n\n${original.body}`;
    const body = [note ? toHtmlBlock(note) : '', note ? '<br>' : '', toHtmlBlock(forwardedBlock)].filter(Boolean).join('\n');

    const results: Array<{ recipient: string; messageId?: string; error?: string }> = [];
    for (const recipient of to) {
      try {
        const r = await sendUserEmail(ctx.userId, recipient, subject, body);
        results.push({ recipient, messageId: r.messageId, error: r.success ? r.error : (r.error ?? 'send failed') });
      } catch (err: any) {
        results.push({ recipient, error: err?.message ?? 'send failed' });
      }
    }
    const succeeded = results.filter((r) => r.messageId && !r.error);
    if (succeeded.length === 0) {
      return { ok: false, output: { results }, error: `all recipients failed: ${results[0]?.error ?? 'unknown'}` };
    }
    return {
      ok: true,
      output: {
        results,
        // auditFields declares a singular messageId — surface the first
        // provider-assigned id; the full per-recipient set stays in results.
        messageId: succeeded[0].messageId,
        forwardedMessageId: resolved.messageId,
        sentAt: new Date().toISOString(),
        successCount: succeeded.length,
        failCount: results.length - succeeded.length,
      },
    };
  }
  /** B2 trust invariant — a forward only counts as sent once the system of
   *  record agrees. Strategy: Gmail read-back (users.messages.get via
   *  gmailAdapter.readEmail) on EVERY messageId execute() claimed as
   *  delivered — one unverifiable claim makes the whole action
   *  unconfirmed. Caveat: sendUserEmail silently falls back to IMAP/SMTP
   *  when Gmail is unavailable; those ids are RFC-5322 Message-IDs
   *  (contain '@') that Gmail can't look up, so that path only gets a
   *  receipt-format check. Fail closed. */
  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    const o = output as { results?: Array<{ recipient: string; messageId?: string; error?: string }> } | undefined;
    const claimed = (o?.results ?? []).filter((r) => r.messageId && !r.error);
    // execute() only returns ok when at least one send succeeded — an empty
    // claim list means the output is malformed; never trust it implicitly.
    if (claimed.length === 0) return false;
    for (const r of claimed) {
      const id = r.messageId!;
      if (id.includes('@')) {
        // CONFIRM-DEEPEN(F1): receipt-only — upgrade to provider read-back
        // (IMAP/SMTP fallback path: nodemailer's Message-ID is the only
        // receipt we get; there is no cheap read method on that connector).
        if (!/^<?[^\s@<>]+@[^\s@<>]+>?$/.test(id)) return false;
        continue;
      }
      try {
        const { email, error } = await readEmail(ctx.userId, id);
        // Not found / fetch failed → the send did not verifiably stick.
        if (error || !email || email.id !== id) return false;
      } catch {
        // Circuit breaker open or transport failure — cannot verify, fail closed.
        return false;
      }
    }
    return true;
  }
  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { messageId: string };
    return { handler: 'forward_email.retract', payload: { messageId: o.messageId }, note: 'cannot unsend' };
  }
}
