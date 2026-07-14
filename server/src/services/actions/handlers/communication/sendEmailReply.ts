import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata, ConfirmationCapability } from '../../handlerBase';
import { sendUserEmail, readEmail } from '../../../adapters/gmailAdapter';
// getEmailHeadersForReply is imported straight from gmailService (not the
// adapter) because the adapter only wraps the hot-path calls in circuit
// breakers; header lookup is a single low-volume metadata GET made once per
// user-approved reply, and adding it to the adapter is out of scope here
// (F1 constrains this change to the two handlers).
import { getEmailHeadersForReply } from '../../../gmailService';
import prisma from '../../../../db/prisma';

/** Pull the bare address out of "Name <addr@x>" (or return the input
 *  trimmed when it's already bare). Used to compare recipients for
 *  reply-all self/duplicate filtering. */
function bareEmail(raw: string): string {
  const m = raw.match(/<([^<>\s]+@[^<>\s]+)>/);
  return (m ? m[1] : raw).trim().toLowerCase();
}

/** The original message a reply/forward is anchored to, resolved to a real
 *  Gmail message id plus whatever sender context the feed already knows. */
export interface ResolvedOriginal {
  messageId: string;
  senderEmail?: string;
  subjectHint?: string;
}

/** Resolve payload.threadId → the LATEST Gmail message of that thread.
 *
 *  WHY feed_events first (same shape as instructionDispatcher's draft_reply
 *  path): the ids Brain hands to actions come from feed cards, and gmail
 *  feed_events store sourceId = message id with rawPayload.threadId = thread
 *  id (see gmailFeedPoller.pollUser). Callers are sloppy about which of the
 *  two they pass — accept either by matching sourceId OR rawPayload.threadId.
 *  Latest-createdAt wins because ingest order tracks arrival order, so the
 *  newest feed row for a thread IS the message a human would be replying to.
 *
 *  Fallback: no feed row (thread older than the poll window, or scribed
 *  before userId stamping). Gmail thread ids share an id space with message
 *  ids — the thread id IS the first message's id — so a direct
 *  users.messages.get on the payload id still resolves single-message
 *  threads and thread-id-passed-as-message-id cases. */
export async function resolveOriginalGmailMessage(
  ctx: HandlerContext,
  threadOrMessageId: string,
): Promise<ResolvedOriginal | { error: string }> {
  try {
    const fe = await prisma.feedEvent.findFirst({
      where: {
        clientNumber: ctx.clientNumber,
        userId: ctx.userId,
        sourceType: 'gmail',
        OR: [
          { sourceId: threadOrMessageId },
          { rawPayload: { path: ['threadId'], equals: threadOrMessageId } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      select: { sourceId: true, senderEmail: true, rawPayload: true },
    });
    if (fe) {
      const p: any = fe.rawPayload ?? {};
      return {
        messageId: fe.sourceId,
        senderEmail: fe.senderEmail ?? undefined,
        subjectHint: typeof p.subject === 'string' ? p.subject : undefined,
      };
    }
  } catch {
    // DB unavailable is not fatal — the Gmail fallback below can still
    // resolve; only fail when BOTH sources come up empty.
  }
  return { messageId: threadOrMessageId };
}

export class SendEmailReplyHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return {
      name: 'send_email_reply',
      category: 'communication',
      description: 'Reply to an existing email thread',
      version: '1.0',
      requiresConnector: 'gmail',
    };
  }
  schema() {
    return {
      type: 'object',
      required: ['threadId', 'body'],
      properties: {
        threadId: { type: 'string' },
        body: { type: 'string' },
        replyAll: { type: 'boolean', default: false },
      },
    };
  }
  auditFields() { return ['threadId', 'messageId']; }
  riskLevel() { return 'MEDIUM' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.payload.threadId) errors.push('threadId required');
    if (!ctx.payload.body) errors.push('body required');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return {
      wouldSucceed: v.valid,
      preview: { threadId: ctx.payload.threadId, replyAll: !!ctx.payload.replyAll, bodyPreview: String(ctx.payload.body ?? '').slice(0, 200) },
      warnings: v.errors,
    };
  }
  /** F1 — real provider I/O (was a stub that fabricated a receipt).
   *  Flow: resolve original message → fetch its RFC headers → send via
   *  gmailAdapter.sendUserEmail with full threading (threadId for Gmail's
   *  own grouping, In-Reply-To + extended References for every other mail
   *  reader — gmailService builds the RFC 2822 message and prefixes
   *  "Re: " itself when threadId is set, so we pass the ORIGINAL subject). */
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const threadId = String(ctx.payload.threadId ?? '');
    const body = String(ctx.payload.body ?? '');

    const resolved = await resolveOriginalGmailMessage(ctx, threadId);
    if ('error' in resolved) return { ok: false, error: resolved.error };

    // Header fetch is load-bearing, not decorative: it gives us (a) the
    // recipient (original From — the feed row only knows senderEmail, and
    // may be absent entirely), (b) the true subject, and (c) the RFC
    // Message-ID/References needed for cross-client threading. If Gmail
    // can't find the message, there is nothing real to reply to — never
    // fall through to a blind send.
    const headers = await getEmailHeadersForReply(ctx.userId, resolved.messageId);
    if ('error' in headers) {
      return { ok: false, error: `could not resolve original message for thread ${threadId}: ${headers.error}` };
    }

    const recipient = bareEmail(headers.from || '') || resolved.senderEmail || '';
    if (!recipient) return { ok: false, error: 'original message has no sender address to reply to' };

    // Reply-all: everyone on the original To+Cc, minus the recipient
    // (already in To) and minus the user themself (they RECEIVED the
    // original, so their own address sits in its To header — copying it
    // back is a self-cc no mail client would produce). Self-detection uses
    // the account email from the users table; best-effort because the
    // Gmail OAuth identity can differ from the login email — a leftover
    // self-cc is cosmetic, a missed participant is a real bug, so we only
    // ever FILTER on confident matches, never drop unknowns.
    let cc: string | undefined;
    if (ctx.payload.replyAll) {
      let selfEmail = '';
      try {
        const u = await prisma.user.findUnique({ where: { id: ctx.userId }, select: { email: true } });
        selfEmail = (u?.email ?? '').toLowerCase();
      } catch { /* best-effort — see above */ }
      const participants = [headers.to, headers.cc]
        .filter(Boolean)
        .join(',')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((p) => {
          const e = bareEmail(p);
          return e !== recipient && (!selfEmail || e !== selfEmail);
        });
      cc = participants.length > 0 ? participants.join(', ') : undefined;
    }

    // RFC 5322: the reply's References = original References chain +
    // original Message-ID; In-Reply-To = original Message-ID alone.
    const references = [headers.references, headers.rfcMessageId].filter(Boolean).join(' ') || undefined;

    try {
      const r = await sendUserEmail(ctx.userId, recipient, headers.subject || resolved.subjectHint || '', body, cc, {
        threadId: headers.threadId ?? threadId,
        inReplyTo: headers.rfcMessageId ?? undefined,
        references,
      });
      if (!r.success || !r.messageId) {
        return { ok: false, error: r.error ?? 'send failed with no messageId' };
      }
      return {
        ok: true,
        output: {
          // Provider-assigned id — this is what confirm() reads back.
          messageId: r.messageId,
          threadId: r.threadId ?? headers.threadId ?? threadId,
          recipient,
          replyAll: !!ctx.payload.replyAll,
          sentAt: new Date().toISOString(),
          sentFromAddress: (r as any).sentFromAddress,
        },
      };
    } catch (err: any) {
      // Circuit breaker open / transport failure — surface the real reason.
      return { ok: false, error: err?.message ?? 'send failed' };
    }
  }
  /** B2 trust invariant — a reply only counts as sent once the system of
   *  record agrees. Strategy: Gmail read-back (users.messages.get via
   *  gmailAdapter.readEmail) on the messageId execute() claimed, PLUS a
   *  thread check — the read-back message must sit in the thread we said
   *  we replied to, otherwise "sent" and "replied" have diverged. Caveat:
   *  sendUserEmail silently falls back to IMAP/SMTP when Gmail is
   *  unavailable; those ids are RFC-5322 Message-IDs (contain '@') that
   *  Gmail can't look up, so that path only gets a receipt-format check.
   *  Fail closed on anything we cannot verify. */
  confirmationCapability(): ConfirmationCapability {
    return 'provider_confirmed'; // confirm() reads back from the provider / delivery log
  }

  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    const o = output as { messageId?: string; threadId?: string } | undefined;
    const id = o?.messageId;
    if (!id) return false;
    if (id.includes('@')) {
      // CONFIRM-DEEPEN(F1): receipt-only — upgrade to provider read-back
      // (IMAP/SMTP fallback path: nodemailer's Message-ID is the only
      // receipt we get; there is no cheap read method on that connector).
      return /^<?[^\s@<>]+@[^\s@<>]+>?$/.test(id);
    }
    try {
      const { email, error } = await readEmail(ctx.userId, id);
      if (error || !email || email.id !== id) return false;
      // Thread membership check: only when both sides know the thread.
      if (o?.threadId && email.threadId && email.threadId !== o.threadId) return false;
      return true;
    } catch {
      // Circuit breaker open or transport failure — cannot verify, fail closed.
      return false;
    }
  }
  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { messageId: string };
    return { handler: 'send_email_reply.retract', payload: { messageId: o.messageId }, note: 'cannot unsend' };
  }
}
