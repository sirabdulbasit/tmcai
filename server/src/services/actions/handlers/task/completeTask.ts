import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';

export class CompleteTaskHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'complete_task', category: 'task', description: 'Mark a task as done', version: '1.0', requiresConnector: 'google_tasks' };
  }
  schema() {
    return { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } };
  }
  auditFields() { return ['taskId']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    if (!ctx.payload.taskId) return { valid: false, errors: ['taskId required'] };
    return { valid: true };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    return { wouldSucceed: true, preview: { taskId: ctx.payload.taskId, newStatus: 'completed' } };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    return { ok: true, output: { taskId: ctx.payload.taskId, previousStatus: 'needsAction', completedAt: new Date().toISOString() } };
  }
  async confirm(_ctx: HandlerContext, _output: unknown): Promise<boolean> {
    // Read-back (B2): execute() is still a stub — it echoes the taskId
    // and a fabricated completedAt without touching Google Tasks or any
    // local table, so there is NO system of record to verify the
    // completion against. Fail closed until the real write + read-back
    // path exists.
    return false;
  }

  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { taskId: string; previousStatus: string };
    return { handler: 'reopen_task', payload: { taskId: o.taskId, restoreStatus: o.previousStatus } };
  }
}
