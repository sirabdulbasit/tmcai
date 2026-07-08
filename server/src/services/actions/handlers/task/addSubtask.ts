import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';

export class AddSubtaskHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'add_subtask', category: 'task', description: 'Add a subtask under an existing task', version: '1.0', requiresConnector: 'google_tasks' };
  }
  schema() {
    return { type: 'object', required: ['parentTaskId', 'title'], properties: { parentTaskId: { type: 'string' }, title: { type: 'string' }, notes: { type: 'string' } } };
  }
  auditFields() { return ['parentTaskId', 'subtaskId']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    const errors: string[] = [];
    if (!ctx.payload.parentTaskId) errors.push('parentTaskId required');
    if (!ctx.payload.title) errors.push('title required');
    return { valid: errors.length === 0, errors };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return { wouldSucceed: v.valid, preview: { parentTaskId: ctx.payload.parentTaskId, title: ctx.payload.title }, warnings: v.errors };
  }
  async execute(_ctx: HandlerContext): Promise<ExecutionOutput> {
    return { ok: true, output: { subtaskId: `stub_sub_${Date.now()}`, createdAt: new Date().toISOString() } };
  }
  async confirm(_ctx: HandlerContext, _output: unknown): Promise<boolean> {
    // Read-back (B2): execute() is still a stub — it fabricates a
    // subtaskId without writing to Google Tasks or any local table, so
    // there is NO system of record to verify against. A stub receipt
    // must never read as a confirmed side effect; fail closed until the
    // real write + read-back path exists.
    return false;
  }

  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { subtaskId: string };
    return { handler: 'delete_task', payload: { taskId: o.subtaskId } };
  }
}
