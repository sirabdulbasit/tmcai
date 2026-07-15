import {ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata, ConfirmationCapability } from '../../handlerBase';
import { updateOpportunity, readRecord } from '../../../adapters/odooAdapter';

export class UpdateOdooOpportunityHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return {
      name: 'update_odoo_opportunity',
      category: 'crm',
      description: 'Update stage / probability / fields on an existing Odoo opportunity',
      version: '1.0',
      requiresConnector: 'odoo',
    };
  }
  schema() {
    return {
      type: 'object',
      required: ['opportunityId', 'fields'],
      properties: {
        opportunityId: { type: 'number' },
        fields: { type: 'object' },
      },
    };
  }
  auditFields() { return ['opportunityId', 'changedKeys']; }
  // Always HIGH — stage / revenue changes affect forecast
  riskLevel() { return 'HIGH' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (typeof ctx.payload.opportunityId !== 'number') errors.push('opportunityId (number) required');
    if (!ctx.payload.fields || typeof ctx.payload.fields !== 'object') errors.push('fields object required');
    return { valid: errors.length === 0, errors };
  }
  async prepare(ctx: HandlerContext): Promise<void> {
    // Snapshot existing fields so undo can revert accurately
    const fields = Object.keys((ctx.payload.fields as Record<string, unknown>) ?? {});
    try {
      const snapshot = await readRecord(ctx.clientNumber, 'crm.lead', ctx.payload.opportunityId as number, fields);
      (ctx.payload as any).__previous = snapshot;
    } catch (err: any) {
      console.warn(`[updateOdooOpportunity] prepare: snapshot failed: ${err.message}`);
    }
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    const fields = (ctx.payload.fields as Record<string, unknown>) ?? {};
    return {
      wouldSucceed: v.valid,
      preview: { opportunityId: ctx.payload.opportunityId, changedKeys: Object.keys(fields) },
      warnings: v.errors,
    };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    try {
      const ok = await updateOpportunity(
        ctx.clientNumber,
        ctx.payload.opportunityId as number,
        ctx.payload.fields as Record<string, unknown>,
      );
      return {
        ok,
        output: {
          opportunityId: ctx.payload.opportunityId,
          changedKeys: Object.keys((ctx.payload.fields as Record<string, unknown>) ?? {}),
          previous: (ctx.payload as any).__previous ?? null,
        },
      };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }
  confirmationCapability(): ConfirmationCapability {
    return 'provider_confirmed'; // confirm() reads back from the provider (Odoo/Google Tasks)
  }

  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // Provider read-back: re-read the changed keys from crm.lead and require
    // the opportunity to exist with the written values in place. many2one
    // fields (e.g. stage_id) read back as [id, name] tuples, so numeric
    // writes are compared against the tuple's id. Missing record or read
    // error → false (fail closed).
    const o = output as { opportunityId?: number; changedKeys?: string[] } | null | undefined;
    if (!o || typeof o.opportunityId !== 'number') return false;
    const written = (ctx.payload.fields as Record<string, unknown>) ?? {};
    const keys = Array.isArray(o.changedKeys) && o.changedKeys.length > 0 ? o.changedKeys : Object.keys(written);
    try {
      const record = await readRecord(ctx.clientNumber, 'crm.lead', o.opportunityId, keys);
      if (!record) return false;
      return keys.every(key => {
        const wrote = written[key];
        const read = (record as Record<string, unknown>)[key];
        if (Array.isArray(read) && typeof wrote === 'number') return read[0] === wrote; // many2one [id, name]
        if (['string', 'number', 'boolean'].includes(typeof wrote) && ['string', 'number', 'boolean'].includes(typeof read)) {
          return String(read) === String(wrote);
        }
        return true; // non-comparable shapes — existence check already passed
      });
    } catch {
      return false;
    }
  }
  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { opportunityId: number; previous: Record<string, unknown> | null };
    return {
      handler: 'update_odoo_opportunity',
      payload: { opportunityId: o.opportunityId, fields: o.previous ?? {} },
      note: 'restore previous field values captured during prepare()',
    };
  }
}
