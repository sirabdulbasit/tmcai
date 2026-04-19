import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import { sendUserEmail } from '../../../adapters/gmailAdapter';

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
