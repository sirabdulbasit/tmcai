import {ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata, ConfirmationCapability } from '../../handlerBase';

export class ReassignTaskHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'reassign_task', category: 'task', description: 'Change the owner of a task', version: '1.1', requiresConnector: 'google_tasks' };
  }
  schema() {
    return { type: 'object', required: ['taskId', 'newAssigneeUserId'], properties: { taskId: { type: 'string' }, newAssigneeUserId: { type: 'number' }, note: { type: 'string' } } };
  }
  auditFields() { return ['taskId', 'previousAssigneeUserId', 'newAssigneeUserId']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.payload.taskId) errors.push('taskId required');
    if (!ctx.payload.newAssigneeUserId) errors.push('newAssigneeUserId required');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return { wouldSucceed: false, preview: { taskId: ctx.payload.taskId, newAssigneeUserId: ctx.payload.newAssigneeUserId }, warnings: [...(v.errors ?? []), 'Google Tasks API does not support cross-user reassignment; use delegate_open_item for internal delegation.'] };
  }
  async execute(_ctx: HandlerContext): Promise<ExecutionOutput> {
    // Fail-closed honest limitation (2026-07-09 backlog gap-fill).
    // Google Tasks has NO cross-user owner field — a task lives in one
    // user's list and cannot be transferred via API. Fabricating a
    // "reassigned" receipt would violate the B2 confirm invariant AND
    // mislead the caller: nothing was actually written.
    // The supported alternative is delegate_open_item, which creates
    // an open_item + emails the delegatee (internal delegation path).
    return {
      ok: false,
      error: 'Google Tasks does not support cross-user task reassignment via API. Use delegate_open_item to delegate an open item to another internal user (creates an open_item row + notifies the delegatee).',
    };
  }
  confirmationCapability(): ConfirmationCapability {
    return 'unverifiable'; // execute() never succeeds; nothing is ever verifiable here
  }

  async confirm(_ctx: HandlerContext, _output: unknown): Promise<boolean> {
    // execute() never returns ok:true for this handler, so confirm()
    // should never be invoked under B2's contract. Return false as a
    // structural safeguard — no side effect was written, nothing to
    // verify, and any caller that reaches this branch must not treat
    // the action as done.
    return false;
  }

  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { taskId: string; previousAssigneeUserId: number };
    return { handler: 'reassign_task', payload: { taskId: o.taskId, newAssigneeUserId: o.previousAssigneeUserId, note: 'undo' } };
  }
}
