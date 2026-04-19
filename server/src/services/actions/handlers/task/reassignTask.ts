import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';

export class ReassignTaskHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'reassign_task', category: 'task', description: 'Change the owner of a task', version: '1.0', requiresConnector: 'google_tasks' };
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
    return { wouldSucceed: v.valid, preview: { taskId: ctx.payload.taskId, newAssigneeUserId: ctx.payload.newAssigneeUserId }, warnings: v.errors };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    return { ok: true, output: { taskId: ctx.payload.taskId, previousAssigneeUserId: ctx.userId, newAssigneeUserId: ctx.payload.newAssigneeUserId, at: new Date().toISOString() } };
  }
  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { taskId: string; previousAssigneeUserId: number };
    return { handler: 'reassign_task', payload: { taskId: o.taskId, newAssigneeUserId: o.previousAssigneeUserId, note: 'undo' } };
  }
}
