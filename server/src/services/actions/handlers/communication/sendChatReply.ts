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
  /** B2 trust invariant — the googleChatAdapter exposes no message-level
   *  read (only sendMessage / getSpaceInfo), so provider read-back isn't
   *  possible without new API surface, and execute() writes no DB mirror
   *  row. Best available: verify the provider-assigned resource name is
   *  well-formed AND belongs to the space we were asked to post in — the
   *  Chat API only returns a `spaces/X/messages/Y` name on an accepted
   *  write, and a cross-space name would mean the receipt doesn't match
   *  the requested side effect.
   *  CONFIRM-DEEPEN(F1): receipt-only — upgrade to provider read-back
   *  (spaces.messages.get) once the adapter grows a read method. */
  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    const o = output as { messageName?: unknown } | undefined;
    const name = o?.messageName;
    if (typeof name !== 'string' || !name) return false;
    // Chat message resource names look like spaces/AAAA/messages/BBBB.CCCC
    if (!/^spaces\/[^/]+\/messages\/[^/]+$/.test(name)) return false;
    const space = String(ctx.payload.space ?? '');
    if (space && !name.startsWith(`${space}/messages/`)) return false;
    return true;
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
