import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import { sendUserEmail, readEmail } from '../../../adapters/gmailAdapter';

export class SendEmailHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return {
      name: 'send_email',
      category: 'communication',
      description: 'Send a fresh email via Gmail',
      version: '1.0',
      requiresConnector: 'gmail',
    };
  }
  schema() {
    return {
      type: 'object',
      required: ['to', 'subject', 'body'],
      properties: {
        to: { type: 'array', items: { type: 'string', format: 'email' } },
        cc: { type: 'array', items: { type: 'string', format: 'email' } },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
    };
  }
  auditFields() { return ['to', 'subject', 'messageId']; }
  async riskLevel(ctx: HandlerContext) {
    const extDomains = new Set<string>();
    const recipients = (ctx.payload.to as string[]) ?? [];
    for (const r of recipients) extDomains.add(r.split('@')[1] ?? '');
    if (extDomains.size > 1) return 'HIGH';
    return 'MEDIUM';
  }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    const to = ctx.payload.to as unknown;
    if (!Array.isArray(to) || to.length === 0) errors.push('to must be a non-empty array');
    if (!ctx.payload.subject) errors.push('subject required');
    if (!ctx.payload.body) errors.push('body required');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return {
      wouldSucceed: v.valid,
      preview: {
        to: ctx.payload.to,
        cc: ctx.payload.cc ?? [],
        subject: ctx.payload.subject,
        bodyPreview: String(ctx.payload.body ?? '').slice(0, 200),
      },
      warnings: v.errors,
    };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    const to = (ctx.payload.to as string[]) ?? [];
    const cc = Array.isArray(ctx.payload.cc) ? (ctx.payload.cc as string[]).join(',') : undefined;
    const subject = String(ctx.payload.subject ?? '');
    const body = String(ctx.payload.body ?? '');
    // Multi-recipient support: gmailAdapter.sendUserEmail takes a single `to` string; send once per recipient
    // to keep delivery visibility per address and cap circuit-breaker failure granularity.
    const results: Array<{ recipient: string; messageId?: string; error?: string }> = [];
    for (const recipient of to) {
      try {
        const r = await sendUserEmail(ctx.userId, recipient, subject, body, cc);
        results.push({ recipient, messageId: r.messageId, error: r.error });
      } catch (err: any) {
        results.push({ recipient, error: err.message });
      }
    }
    const anySuccess = results.some((r) => r.messageId && !r.error);
    if (!anySuccess) {
      return { ok: false, output: { results }, error: 'all recipients failed' };
    }
    return {
      ok: true,
      output: {
        results,
        sentAt: new Date().toISOString(),
        successCount: results.filter((r) => r.messageId).length,
        failCount: results.filter((r) => r.error).length,
      },
    };
  }
  /** B2 trust invariant — an email only counts as sent once the system of
   *  record agrees. Strategy: Gmail read-back (users.messages.get via
   *  gmailAdapter.readEmail) on every messageId execute() claimed as
   *  delivered. Caveat: sendUserEmail silently falls back to IMAP/SMTP when
   *  Gmail is unavailable (see gmailService.sendUserEmail); those ids are
   *  RFC-5322 Message-IDs (contain '@') that Gmail can't look up, so for
   *  that path only a receipt-format check is possible. Fail closed: any
   *  claimed send we cannot verify makes the whole action unconfirmed. */
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
    const o = output as { results?: Array<{ recipient: string; messageId?: string }> };
    const sentIds = (o.results ?? []).filter((r) => r.messageId).map((r) => r.messageId!);
    // Can't unsend; best effort = log retraction per successful send
    return {
      handler: 'send_email.retract',
      payload: { messageIds: sentIds },
      note: 'cannot unsend a sent email; log retraction and consider sending a follow-up correction',
    };
  }
}
