import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, HandlerMetadata } from '../../handlerBase';

const VALID_AGENTS = new Set([
  'brain',
  'feed_curator',
  'triage',
  'action_executor',
  'reflection',
  'steering',
  'shadow_scorer',
]);

export class TransferToAgentHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return {
      name: 'transfer_to_agent',
      category: 'orchestration',
      description: 'ADK-native delegation to another agent in the 7-agent topology',
      version: '1.0',
    };
  }
  schema() {
    return {
      type: 'object',
      required: ['targetAgent', 'context'],
      properties: {
        targetAgent: { type: 'string', enum: Array.from(VALID_AGENTS) },
        context: { type: 'object' },
        priority: { type: 'string', enum: ['LOW', 'NORMAL', 'HIGH'], default: 'NORMAL' },
      },
    };
  }
  auditFields() { return ['targetAgent', 'priority']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    const tgt = ctx.payload.targetAgent as string;
    if (!tgt) errors.push('targetAgent required');
    else if (!VALID_AGENTS.has(tgt)) errors.push(`targetAgent "${tgt}" not in valid agent set`);
    if (!ctx.payload.context) errors.push('context required');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return {
      wouldSucceed: v.valid,
      preview: { targetAgent: ctx.payload.targetAgent, priority: ctx.payload.priority ?? 'NORMAL' },
      warnings: v.errors,
    };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    // In production this publishes a message to the target agent's Pub/Sub subscription.
    // Wiring to pubsubPublisher happens once the agent Cloud Run service is live (Phase 4).
    return {
      ok: true,
      output: {
        targetAgent: ctx.payload.targetAgent,
        transferId: `transfer_${ctx.traceId ?? Date.now()}`,
        acceptedAt: new Date().toISOString(),
      },
    };
  }
  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // CONFIRM-DEEPEN(F1): receipt-only — upgrade to provider read-back.
    // execute() is a Phase-4 stub: it persists nothing and publishes nothing
    // yet, so there is no platform row or Pub/Sub receipt to re-read. The
    // strongest honest check today is the receipt itself: a transferId was
    // minted, and it names the same valid agent the payload asked for. Once
    // the Pub/Sub wiring lands, replace this with verification of the publish
    // messageId / delivery record. Fail closed on a malformed or mismatched
    // receipt.
    const o = output as { targetAgent?: string; transferId?: string } | null;
    if (!o?.transferId || !o.targetAgent) return false;
    return o.targetAgent === ctx.payload.targetAgent && VALID_AGENTS.has(o.targetAgent);
  }
}
