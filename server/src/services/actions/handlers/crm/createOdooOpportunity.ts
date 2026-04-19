import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import { createOpportunity } from '../../../adapters/odooAdapter';

export class CreateOdooOpportunityHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'create_odoo_opportunity', category: 'crm', description: 'Create a new opportunity (deal) in Odoo CRM', version: '1.0', requiresConnector: 'odoo' };
  }
  schema() {
    return {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        contactName: { type: 'string' },
        email: { type: 'string', format: 'email' },
        phone: { type: 'string' },
        description: { type: 'string' },
        expectedRevenue: { type: 'number' },
        probability: { type: 'number', minimum: 0, maximum: 100 },
      },
    };
  }
  auditFields() { return ['opportunityId', 'name', 'expectedRevenue']; }
  // Always HIGH — creating deals touches revenue pipeline
  riskLevel() { return 'HIGH' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    if (!ctx.payload.name) return { valid: false, errors: ['name required'] };
    return { valid: true };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return {
      wouldSucceed: v.valid,
      preview: { willCreate: 'crm.opportunity', name: ctx.payload.name, expectedRevenue: ctx.payload.expectedRevenue, probability: ctx.payload.probability ?? null },
      warnings: v.errors,
    };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    try {
      const opportunityId = await createOpportunity(ctx.clientNumber, {
        name: String(ctx.payload.name),
        contactName: ctx.payload.contactName as string | undefined,
        email: ctx.payload.email as string | undefined,
        phone: ctx.payload.phone as string | undefined,
        description: ctx.payload.description as string | undefined,
        expectedRevenue: ctx.payload.expectedRevenue as number | undefined,
        probability: ctx.payload.probability as number | undefined,
      });
      return { ok: true, output: { opportunityId, createdAt: new Date().toISOString() } };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }
  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { opportunityId: number };
    return {
      handler: 'odoo.archive_opportunity',
      payload: { opportunityId: o.opportunityId },
      note: 'archive the opportunity — destructive undo requires explicit SA approval',
    };
  }
}
