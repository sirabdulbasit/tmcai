/**
 * Slack outbound action handler — posts a message to a channel or thread
 * using the tenant's stored bot token (saved by the Slack OAuth flow
 * into user_connectors.config.botToken envelope-encrypted).
 *
 * This is the missing half of the Slack integration: inbound was already
 * working through the slackFeedAdapter, and this closes outbound so
 * user-defined action rules with action_type='send_slack_message' can
 * actually post replies on the user's behalf.
 */
import prisma from '../../../../db/prisma';
import {
  ActionHandler,
  HandlerContext,
  ValidationResult,
  DryRunResult,
  ExecutionOutput,
  ReverseOperation,
  HandlerMetadata,
} from '../../handlerBase';

export class SendSlackMessageHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return {
      name: 'send_slack_message',
      category: 'communication',
      description: 'Post a message to a Slack channel or thread (uses tenant bot token)',
      version: '1.0',
      requiresConnector: 'slack',
    };
  }
  schema() {
    return {
      type: 'object',
      required: ['channel', 'text'],
      properties: {
        channel: { type: 'string', description: 'Channel ID (C…) or user ID (U…) for DM' },
        text: { type: 'string' },
        threadTs: { type: 'string', description: 'Optional ts of parent message to reply in-thread' },
      },
    };
  }
  auditFields() { return ['channel', 'threadTs', 'ts']; }
  riskLevel() { return 'MEDIUM' as const; }

  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.payload.channel) errors.push('channel required');
    if (!ctx.payload.text) errors.push('text required');
    return { valid: errors.length === 0, errors };
  }

  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return {
      wouldSucceed: v.valid,
      preview: {
        channel: ctx.payload.channel,
        threadTs: ctx.payload.threadTs ?? null,
        textPreview: String(ctx.payload.text ?? '').slice(0, 200),
      },
      warnings: v.errors,
    };
  }

  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    try {
      const token = await getBotToken(ctx.clientNumber);
      if (!token) {
        return { ok: false, error: 'Slack not connected for this tenant — pair via Connectors page first' };
      }
      const r = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify({
          channel: String(ctx.payload.channel),
          text: String(ctx.payload.text),
          thread_ts: ctx.payload.threadTs ? String(ctx.payload.threadTs) : undefined,
        }),
      });
      const j: any = await r.json();
      if (!j.ok) return { ok: false, error: `Slack API: ${j.error ?? 'unknown'}` };
      return {
        ok: true,
        output: {
          channel: j.channel,
          ts: j.ts,
          messageTs: j.message?.ts,
          sentAt: new Date().toISOString(),
        },
      };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { channel?: string; ts?: string };
    return {
      handler: 'slack.delete_message',
      payload: { channel: o.channel ?? null, ts: o.ts ?? null },
      note: o.channel && o.ts
        ? `Run POST https://slack.com/api/chat.delete with channel=${o.channel} ts=${o.ts}`
        : 'No channel/ts captured — cannot auto-delete',
    };
  }
}

async function getBotToken(tenantId: string): Promise<string | null> {
  const ct = await prisma.connectorType.findUnique({ where: { slug: 'slack' } });
  if (!ct) return null;
  const row = await prisma.userConnector.findFirst({
    where: { clientNumber: tenantId, connectorTypeId: ct.id, status: 'connected' },
    select: { config: true },
  });
  if (!row?.config) return null;
  const { decryptConnectorConfig } = await import('../../../connectorService');
  const cfg = await decryptConnectorConfig(row.config as Record<string, unknown>);
  return (cfg.botToken as string | undefined) ?? null;
}
