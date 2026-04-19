import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import { createLead, updatePartner } from '../../../adapters/odooAdapter';

export class CreateOdooLeadHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'create_odoo_lead', category: 'crm', description: 'Create a new lead in Odoo CRM', version: '1.0', requiresConnector: 'odoo' };
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
      },
    };
  }
  auditFields() { return ['leadId', 'name', 'email']; }
  riskLevel() { return 'MEDIUM' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    if (!ctx.payload.name) return { valid: false, errors: ['name required'] };
    return { valid: true };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return { wouldSucceed: v.valid, preview: { willCreate: 'crm.lead', name: ctx.payload.name, email: ctx.payload.email }, warnings: v.errors };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    try {
      const leadId = await createLead(ctx.clientNumber, {
        name: String(ctx.payload.name),
        contactName: ctx.payload.contactName as string | undefined,
        email: ctx.payload.email as string | undefined,
        phone: ctx.payload.phone as string | undefined,
        description: ctx.payload.description as string | undefined,
        expectedRevenue: ctx.payload.expectedRevenue as number | undefined,
      });
      return { ok: true, output: { leadId, createdAt: new Date().toISOString() } };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }
  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { leadId: number };
    return {
      handler: 'odoo.archive_lead',
      payload: { leadId: o.leadId },
      note: 'archive (not delete) the lead in Odoo — requires manual action via admin or odoo api',
    };
  }
}
