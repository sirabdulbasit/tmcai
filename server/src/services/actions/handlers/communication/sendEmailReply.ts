import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';

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
  async execute(_ctx: HandlerContext): Promise<ExecutionOutput> {
    return {
      ok: true,
      output: { messageId: `stub_reply_${Date.now()}`, sentAt: new Date().toISOString(), deliveryStatus: 'stub' },
    };
  }
  /** B2 trust invariant — execute() is still a stub (no Gmail write ever
   *  happens; output carries deliveryStatus 'stub'), so there is NO system
   *  of record to read back against. The old `return true` default marked
   *  stub replies as done — exactly the lie the abstract confirm() exists
   *  to prevent. Fail closed unconditionally until execute() performs a
   *  real Gmail send, at which point this must become a users.messages.get
   *  read-back (see SendEmailHandler.confirm for the pattern). */
  async confirm(_ctx: HandlerContext, _output: unknown): Promise<boolean> {
    return false;
  }
  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { messageId: string };
    return { handler: 'send_email_reply.retract', payload: { messageId: o.messageId }, note: 'cannot unsend' };
  }
}
