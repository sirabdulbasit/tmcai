import prisma from '../../../../db/prisma';
import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import { sendWhatsAppToPhone } from '../../../adapters/whatsappAdapter';

export class SendWhatsappMessageHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return {
      name: 'send_whatsapp_message',
      category: 'communication',
      description: 'Send a WhatsApp message to an arbitrary phone via Meta Cloud API',
      version: '1.0',
      requiresConnector: 'whatsapp',
    };
  }
  schema() {
    return {
      type: 'object',
      required: ['toPhone', 'text'],
      properties: {
        toPhone: { type: 'string', pattern: '^\\+?[0-9]{7,15}$' },
        text: { type: 'string' },
      },
    };
  }
  auditFields() { return ['toPhone', 'messageId']; }
  riskLevel() { return 'MEDIUM' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    const phone = String(ctx.payload.toPhone ?? '').trim();
    if (!phone) errors.push('toPhone required');
    else if (!/^\+?[0-9]{7,15}$/.test(phone)) errors.push('toPhone must be a digit string, optionally prefixed with +');
    if (!ctx.payload.text) errors.push('text required');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return {
      wouldSucceed: v.valid,
      preview: { toPhone: ctx.payload.toPhone, textPreview: String(ctx.payload.text ?? '').slice(0, 200) },
      warnings: v.errors,
    };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    try {
      const r = await sendWhatsAppToPhone(
        ctx.clientNumber,
        String(ctx.payload.toPhone),
        String(ctx.payload.text),
      );
      if (!r.sent) return { ok: false, error: r.reason ?? 'whatsapp send failed' };
      return { ok: true, output: { messageId: r.messageId, sentAt: new Date().toISOString() } };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }
  /** B2 trust invariant — whatsappService.sendWhatsAppToPhone mirrors every
   *  accepted send into whatsapp_messages (direction 'out', status 'sent',
   *  messageId = Meta-assigned wamid) whenever the destination phone maps
   *  to a whatsapp_connections row, so a DB read-back on that row is the
   *  cheapest system-of-record check. For external phones with no
   *  connection row the service skips the mirror by design ("Meta is
   *  source of truth"), so we drop to a receipt check on the wamid. Fail
   *  closed when neither holds. */
  async confirm(_ctx: HandlerContext, output: unknown): Promise<boolean> {
    const o = output as { messageId?: unknown } | undefined;
    const messageId = o?.messageId;
    // Meta only assigns a wamid on an accepted send — no id, nothing stuck.
    if (typeof messageId !== 'string' || !messageId) return false;
    try {
      // status may already be upgraded by a delivery webhook (sent →
      // delivered → read), so only exclude the explicit failure log rows.
      const row = await prisma.whatsAppMessage.findFirst({
        where: { messageId, direction: 'out', status: { not: 'failed' } },
        select: { id: true },
      });
      if (row) return true;
    } catch {
      // DB unreachable — cannot verify the mirror, fail closed.
      return false;
    }
    // CONFIRM-DEEPEN(F1): receipt-only — upgrade to provider read-back
    // (external phone with no whatsapp_connections row: the DB mirror is
    // skipped by design and the Meta Cloud API has no cheap message-get).
    return /^wamid\./.test(messageId);
  }
  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { messageId: string };
    return {
      handler: 'whatsapp.retract',
      payload: { messageId: o.messageId },
      note: 'cannot unsend; log retraction and consider a follow-up correction message',
    };
  }
}
