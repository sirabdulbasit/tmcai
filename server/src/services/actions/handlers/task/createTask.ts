import {ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata, ConfirmationCapability } from '../../handlerBase';
import { createTask, getTask, getTaskLists } from '../../../googleTasksService';

export class CreateTaskHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'create_task', category: 'task', description: 'Create a Google Task or internal task', version: '1.1', requiresConnector: 'google_tasks' };
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
  auditFields() { return ['taskId', 'title', 'taskListId']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    if (!ctx.payload.title) return { valid: false, errors: ['title required'] };
    return { valid: true };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    const v = await this.validate(ctx);
    return { wouldSucceed: v.valid, preview: { title: ctx.payload.title, dueDate: ctx.payload.dueDate, assigneeUserId: ctx.payload.assigneeUserId }, warnings: v.errors };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    // Real Google Tasks write (was a stub until 2026-07-09 backlog gap-fill).
    // Google Tasks has NO assignee concept — payload.assigneeUserId is
    // accepted (schema-level) but silently ignored at the provider layer.
    // Cross-user assignment is handled by delegate_open_item, not here.
    try {
      const title = String(ctx.payload.title ?? '').trim();
      const notes = ctx.payload.notes != null ? String(ctx.payload.notes) : undefined;
      const dueDate = ctx.payload.dueDate != null ? String(ctx.payload.dueDate) : undefined;
      let taskListId = ctx.payload.taskListId != null ? String(ctx.payload.taskListId) : '';
      if (!taskListId) {
        // No list specified — use the user's first list ("My Tasks" by
        // Google default). Fail closed if the user has no lists connected
        // at all; the caller should tell the user to open Google Tasks
        // once so the default list exists.
        const lists = await getTaskLists(ctx.userId);
        if (!lists || lists.length === 0) {
          return { ok: false, error: 'no Google Tasks list connected — open Google Tasks once to auto-create your default list' };
        }
        taskListId = String(lists[0].id ?? '');
        if (!taskListId) {
          return { ok: false, error: 'default Google Tasks list has no id' };
        }
      }
      const created = await createTask(ctx.userId, taskListId, title, notes, dueDate);
      if (!created || !created.id) {
        return { ok: false, error: 'Google Tasks did not return a task id' };
      }
      return {
        ok: true,
        output: {
          taskId: created.id,
          taskListId,
          title: created.title ?? title,
          createdAt: new Date().toISOString(),
        },
      };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'create_task failed' };
    }
  }
  confirmationCapability(): ConfirmationCapability {
    return 'provider_confirmed'; // confirm() reads back from the provider (Odoo/Google Tasks)
  }

  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // Provider read-back (B2): fetch the task we claim to have created
    // and confirm the id lines up. Any provider error → false.
    const o = output as { taskId?: string; taskListId?: string; title?: string } | null | undefined;
    if (!o || typeof o.taskId !== 'string' || !o.taskId || typeof o.taskListId !== 'string' || !o.taskListId) {
      return false;
    }
    try {
      const t = await getTask(ctx.userId, o.taskListId, o.taskId);
      return !!t && t.id === o.taskId;
    } catch {
      return false;
    }
  }
  async undo(_ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { taskId: string };
    return { handler: 'delete_task', payload: { taskId: o.taskId } };
  }
}
