import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';

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
  async execute(_ctx: HandlerContext): Promise<ExecutionOutput> {
    return { ok: true, output: { messageId: `stub_fwd_${Date.now()}`, sentAt: new Date().toISOString(), deliveryStatus: 'stub' } };
  }
  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { messageId: string };
    return { handler: 'forward_email.retract', payload: { messageId: o.messageId }, note: 'cannot unsend' };
  }
}
