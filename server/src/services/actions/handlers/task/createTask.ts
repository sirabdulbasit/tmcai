import { ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata } from '../../handlerBase';

export class CreateTaskHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'create_task', category: 'task', description: 'Create a Google Task or internal task', version: '1.0', requiresConnector: 'google_tasks' };
  }
  schema() {
    return {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        notes: { type: 'string' },
        dueDate: { type: 'string', format: 'date-time' },
        assigneeUserId: { type: 'number' },
        taskListId: { type: 'string' },
      },
    };
  }
  auditFields() { return ['taskId', 'title', 'assigneeUserId']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    if (!ctx.payload.title) return { valid: false, errors: ['title required'] };
    return { valid: true };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return { wouldSucceed: v.valid, preview: { title: ctx.payload.title, dueDate: ctx.payload.dueDate, assigneeUserId: ctx.payload.assigneeUserId }, warnings: v.errors };
  }
  async execute(_ctx: HandlerContext): Promise<ExecutionOutput> {
    return { ok: true, output: { taskId: `stub_task_${Date.now()}`, createdAt: new Date().toISOString() } };
  }
  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { taskId: string };
    return { handler: 'delete_task', payload: { taskId: o.taskId } };
  }
}
