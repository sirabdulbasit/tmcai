import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';
import { updatePartner, updateOpportunity, readRecord } from '../../../adapters/odooAdapter';

export class UpdateOdooCrmHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return {
      name: 'update_odoo_crm',
      category: 'crm',
      description: 'Update a contact or company record in Odoo CRM',
      version: '1.0',
      requiresConnector: 'odoo',
    };
  }
  schema() {
    return {
      type: 'object',
      required: ['recordType', 'recordId', 'fields'],
      properties: {
        recordType: { type: 'string', enum: ['contact', 'company', 'opportunity'] },
        recordId: { type: 'number' },
        fields: { type: 'object' },
      },
    };
  }
  auditFields() { return ['recordType', 'recordId', 'changedKeys']; }
  riskLevel() { return 'MEDIUM' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.payload.recordType) errors.push('recordType required');
    if (typeof ctx.payload.recordId !== 'number') errors.push('recordId (number) required');
    if (!ctx.payload.fields || typeof ctx.payload.fields !== 'object') errors.push('fields object required');
    return { valid: errors.length === 0, errors };
  }
  async prepare(ctx: HandlerContext): Promise<void> {
    const fieldKeys = Object.keys((ctx.payload.fields as Record<string, unknown>) ?? {});
    const model = ctx.payload.recordType === 'opportunity' ? 'crm.lead' : 'res.partner';
    try {
      const snapshot = await readRecord(ctx.clientNumber, model, ctx.payload.recordId as number, fieldKeys);
      (ctx.payload as any).__previous = snapshot;
    } catch (err: any) {
      console.warn(`[updateOdooCrm] prepare snapshot failed: ${err.message}`);
    }
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    const fields = (ctx.payload.fields as Record<string, unknown>) ?? {};
    return {
      wouldSucceed: v.valid,
      preview: {
        recordType: ctx.payload.recordType,
        recordId: ctx.payload.recordId,
        changedKeys: Object.keys(fields),
      },
      warnings: v.errors,
    };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    try {
      const recordType = String(ctx.payload.recordType);
      const recordId = ctx.payload.recordId as number;
      const fields = ctx.payload.fields as Record<string, unknown>;
      let ok: boolean;
      if (recordType === 'opportunity') {
        ok = await updateOpportunity(ctx.clientNumber, recordId, fields);
      } else {
        ok = await updatePartner(ctx.clientNumber, recordId, fields);
      }
      return {
        ok,
        output: {
          recordType,
          recordId,
          changedKeys: Object.keys(fields),
          previous: (ctx.payload as any).__previous ?? null,
        },
      };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }
  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { recordType: string; recordId: number; previous: Record<string, unknown> | null };
    return {
      handler: 'update_odoo_crm',
      payload: { recordType: o.recordType, recordId: o.recordId, fields: o.previous ?? {} },
      note: 'restore previous field values captured during prepare()',
    };
  }
}
