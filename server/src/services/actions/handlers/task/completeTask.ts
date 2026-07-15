import {ActionHandler, HandlerContext, ValidationResult, DryRunResult, ExecutionOutput, ReverseOperation, HandlerMetadata, ConfirmationCapability } from '../../handlerBase';
import { markTaskDone, findTaskById, getTask } from '../../../googleTasksService';

export class CompleteTaskHandler extends ActionHandler {
  metadata(): HandlerMetadata {
    return { name: 'complete_task', category: 'task', description: 'Mark a task as done', version: '1.1', requiresConnector: 'google_tasks' };
  }
  schema() {
    return { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } } };
  }
  auditFields() { return ['taskId', 'taskListId']; }
  riskLevel() { return 'LOW' as const; }
  async validate(ctx: HandlerContext): Promise<ValidationResult> {
    if (!ctx.payload.taskId) return { valid: false, errors: ['taskId required'] };
    return { valid: true };
  }
  async dryRun(ctx: HandlerContext): Promise<DryRunResult> {
    return { wouldSucceed: true, preview: { taskId: ctx.payload.taskId, newStatus: 'completed' } };
  }
  async execute(ctx: HandlerContext): Promise<ExecutionOutput> {
    // Real Google Tasks write (was a stub until 2026-07-09 backlog gap-fill).
    // Payload schema carries only taskId — we scan the user's lists via
    // findTaskById to locate its list before patching. Failing closed on
    // "not found" is required: blind writing to the wrong list is worse
    // than telling the user we couldn't find the task.
    try {
      const taskId = String(ctx.payload.taskId ?? '').trim();
      if (!taskId) return { ok: false, error: 'taskId required' };
      const located = await findTaskById(ctx.userId, taskId);
      if (!located) {
        return { ok: false, error: `task not found in any of your Google Tasks lists (id ${taskId})` };
      }
      const previousStatus = String(located.task?.status ?? 'needsAction');
      // Idempotency: task already completed → no second write, report ok.
      // Prevents markTaskDone racing on retries + keeps the audit trail
      // showing "completed" as the terminal state without churn.
      if (previousStatus === 'completed') {
        return {
          ok: true,
          output: {
            taskId,
            taskListId: located.taskListId,
            previousStatus: 'completed',
            completedAt: new Date().toISOString(),
            noWriteNeeded: true,
          },
        };
      }
      await markTaskDone(ctx.userId, located.taskListId, taskId);
      return {
        ok: true,
        output: {
          taskId,
          taskListId: located.taskListId,
          previousStatus,
          completedAt: new Date().toISOString(),
        },
      };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? 'complete_task failed' };
    }
  }
  confirmationCapability(): ConfirmationCapability {
    return 'provider_confirmed'; // confirm() reads back from the provider (Odoo/Google Tasks)
  }

  async confirm(ctx: HandlerContext, output: unknown): Promise<boolean> {
    // Provider read-back: fetch the task, expect status='completed'.
    const o = output as { taskId?: string; taskListId?: string } | null | undefined;
    if (!o || typeof o.taskId !== 'string' || !o.taskId || typeof o.taskListId !== 'string' || !o.taskListId) {
      return false;
    }
    try {
      const t = await getTask(ctx.userId, o.taskListId, o.taskId);
      return !!t && t.status === 'completed';
    } catch {
      return false;
    }
  }
  async undo(ctx: HandlerContext, output: unknown): Promise<ReverseOperation> {
    const o = output as { taskId: string; previousStatus: string };
    return { handler: 'reopen_task', payload: { taskId: o.taskId, restoreStatus: o.previousStatus } };
  }
}
