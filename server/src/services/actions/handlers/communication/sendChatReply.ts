import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import { sendMessage } from '../../../adapters/googleChatAdapter';

export class SendChatReplyHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return {
      name: 'send_chat_reply',
      category: 'communication',
      description: 'Reply in a Google Chat space or DM',
      version: '1.0',
      requiresConnector: 'google_chat',
    };
  }
  schema() {
    return {
      type: 'object',
      required: ['space', 'text'],
      properties: {
        space: { type: 'string' }, // spaces/AAAAAAAAAAA
        text: { type: 'string' },
        threadName: { type: 'string' },
      },
    };
  }
  auditFields() { return ['space', 'messageName']; }
  riskLevel() { return 'MEDIUM' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.payload.space) errors.push('space required (format: spaces/XXX)');
    if (!ctx.payload.text) errors.push('text required');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return {
      wouldSucceed: v.valid,
      preview: {
        space: ctx.payload.space,
        threadName: ctx.payload.threadName ?? null,
        textPreview: String(ctx.payload.text ?? '').slice(0, 200),
      },
      warnings: v.errors,
    };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    try {
      const messageName = await sendMessage(ctx.clientNumber, {
        space: String(ctx.payload.space),
        text: String(ctx.payload.text),
        threadName: ctx.payload.threadName as string | undefined,
      });
      return { ok: true, output: { messageName, sentAt: new Date().toISOString() } };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }
  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { messageName: string };
    return {
      handler: 'gchat.delete_message',
      payload: { messageName: o.messageName },
      note: 'Google Chat messages can be deleted by the bot that sent them within a limited window',
    };
  }
}
